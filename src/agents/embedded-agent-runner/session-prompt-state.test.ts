import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import {
  clearEmbeddedSessionPromptStates,
  beginSessionSystemPrompt,
  prepareEmbeddedSessionActiveProjectKeys,
  prepareSessionSystemPrompt,
  persistSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
} from "./session-prompt-state.js";

const sessionIds = new Set<string>();

function prepare(sessionId: string, projectKey: string | null): readonly string[] {
  sessionIds.add(sessionId);
  return prepareEmbeddedSessionActiveProjectKeys(sessionId, projectKey);
}

afterEach(() => {
  clearEmbeddedSessionPromptStates(sessionIds);
  sessionIds.clear();
});

it("unloads prompt payloads after the last attempt while retaining recent projects", () => {
  const sessionId = "idle-prompt-state";
  prepare(sessionId, "project-one");
  const first = retainEmbeddedSessionPromptState(sessionId);
  const overlapping = retainEmbeddedSessionPromptState(sessionId);
  first.state.toolResults.frozen.add("sent-result");
  first[Symbol.dispose]();
  first[Symbol.dispose]();
  {
    using active = retainEmbeddedSessionPromptState(sessionId);
    expect(active.state).toBe(overlapping.state);
  }
  expect(overlapping.state.toolResults.frozen.has("sent-result")).toBe(true);
  overlapping[Symbol.dispose]();
  using reloaded = retainEmbeddedSessionPromptState(sessionId);
  expect(reloaded.state).not.toBe(first.state);
  expect(prepare(sessionId, null)).toEqual(["project-one"]);

  const retired = retainEmbeddedSessionPromptState(sessionId);
  clearEmbeddedSessionPromptStates([sessionId]);
  const replacement = retainEmbeddedSessionPromptState(sessionId);
  retired[Symbol.dispose]();
  using activeReplacement = retainEmbeddedSessionPromptState(sessionId);
  expect(activeReplacement.state).toBe(replacement.state);
  expect(prepare(sessionId, null)).toEqual([]);
  replacement[Symbol.dispose]();
});

it("keeps active attempts canonical beyond the session cache limit", () => {
  const leases = Array.from({ length: 70 }, (_, index) => {
    const id = `concurrent-prompt-${index}`;
    sessionIds.add(id);
    return { id, lease: retainEmbeddedSessionPromptState(id) };
  });
  try {
    for (const { id, lease } of leases) {
      using active = retainEmbeddedSessionPromptState(id);
      expect(active.state).toBe(lease.state);
    }
  } finally {
    for (const { lease } of leases) {
      lease[Symbol.dispose]();
    }
  }
  for (const { id, lease } of leases) {
    using reloaded = retainEmbeddedSessionPromptState(id);
    expect(reloaded.state).not.toBe(lease.state);
  }
});

describe("system prompt series", () => {
  let lease: ReturnType<typeof retainEmbeddedSessionPromptState>;
  beforeEach(() => {
    lease = retainEmbeddedSessionPromptState("system-series");
  });
  afterEach(() => lease[Symbol.dispose]());
  const routeKey = "anthropic/claude-opus-5/anthropic-messages";
  const base =
    "Opening instructions.\n## Stable\nKeep this.\n## Changed\nOld.\n## Removed\nRetire this.\n";
  const changed =
    "Opening instructions.\n## Stable\nKeep this.\n## Changed\nNew.\n## Added\nAdd this.\n";
  function project(prefix: string, entries: SessionEntry[] = [], route = routeKey) {
    const id = "system-series";
    sessionIds.add(id);
    const result = prepareSessionSystemPrompt({
      state: lease.state,
      routeKey: route,
      systemPrompt: prefix.trimEnd(),
      entries,
    });
    result.commit();
    return result;
  }
  async function persist(entries: SessionEntry[]) {
    await persistSessionSystemPrompt(lease.state, (customType, data) => {
      entries.push({
        type: "custom",
        customType,
        data: structuredClone(data),
        id: `marker-${entries.length}`,
        parentId: null,
        timestamp: "2026-10-01T00:00:00Z",
      });
    });
  }

  it("pins stable bytes and emits only changed, added, and removed sections", () => {
    const first = project(base);
    expect(first.update).toBeUndefined();
    const next = project(changed);
    expect(next.systemPrompt).toBe(first.systemPrompt);
    expect(next.update?.content).toBe(
      "System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.\n\n## Changed\nNew.\n\n\n## Added\nAdd this.\n\n## Removed\n(removed)",
    );
    expect(project(changed).update).toBeUndefined();
    expect(project(base).update?.content).toContain("## Added\n(removed)");
  });

  it("keeps both prompt digests stable across disposed turns with skill, memory, and date changes", async () => {
    const entries: SessionEntry[] = [];
    let first: string | undefined;
    sessionIds.add("system-series");
    for (let turn = 0; turn < 30; turn++) {
      lease[Symbol.dispose]();
      lease = retainEmbeddedSessionPromptState("system-series");
      const prompt = `## Skills\nskill-${turn}\n## Project Context\nmemory-${turn}${SYSTEM_PROMPT_CACHE_BOUNDARY}## Temporal Context\nday-${turn}`;
      const prepared = prepareSessionSystemPrompt({
        state: lease.state,
        routeKey,
        systemPrompt: prompt,
        entries,
      });
      first ??= prepared.systemPrompt;
      expect(prepared.systemPrompt).toBe(first);
      if (turn > 0) {
        expect(prepared.restart).toBe(false);
        expect(prepared.update?.content).toContain(`skill-${turn}`);
        expect(prepared.update?.content).toContain(`memory-${turn}`);
        expect(prepared.update?.content).toContain(`day-${turn}`);
        expect(prepared.update?.content).not.toContain("OPENCLAW_CACHE_BOUNDARY");
      }
      prepared.commit();
      await persist(entries);
    }
  });

  it("replaces duplicate-heading groups without ambiguous partial removals", () => {
    project("First.\n## File\nOne.\n## File\nTwo.");
    const next = project("Second.\n## File\nChanged.\n## File\nTwo.");
    expect(next.update?.content).toContain("Second.\n");
    expect(next.update?.content).toContain("## File\nChanged.");
    expect(next.update?.content).toContain("## File\nChanged.\n## File\nTwo.");
    const partial = project("Second.\n## File\nTwo.");
    expect(partial.update?.content).toBe(
      "System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.\n\n## File\nTwo.",
    );
    expect(project("Second.\n## File\nTwo.").update).toBeUndefined();
    expect(project("Second.").update?.content.match(/## File\n\(removed\)/g)).toEqual([
      "## File\n(removed)",
    ]);
  });

  it("checkpoints permission-only changes across restored turns without repeating them", async () => {
    const entries: SessionEntry[] = [];
    const first = project(base);
    await persist(entries);
    const notice = "## Permission change\nThe workspace is now read-only.";
    const withNotice = `${base.trimEnd()}\n\n<!-- openclaw:attempt:PERMISSION -->\n${notice}\n<!-- /openclaw:attempt:PERMISSION -->`;
    for (const prompt of [withNotice, base, withNotice]) {
      clearEmbeddedSessionPromptStates(["system-series"]);
      lease[Symbol.dispose]();
      lease = retainEmbeddedSessionPromptState("system-series");
      const prepared = project(prompt, entries);
      expect(prepared.systemPrompt).toBe(first.systemPrompt);
      expect(prepared.update?.content).toBe(
        prompt === base
          ? undefined
          : `System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.\n\n${notice}`,
      );
      const checkpoints = entries.length;
      await persist(entries);
      expect(entries).toHaveLength(checkpoints + 1);
      clearEmbeddedSessionPromptStates(["system-series"]);
      lease[Symbol.dispose]();
      lease = retainEmbeddedSessionPromptState("system-series");
      expect(project(prompt, entries).update).toBeUndefined();
      await persist(entries);
      expect(entries).toHaveLength(checkpoints + 1);
    }
  });

  it("retries an unpersisted update after cancellation or a failed checkpoint write", async () => {
    const entries: SessionEntry[] = [];
    project(base);
    await persist(entries);
    const state = lease.state;
    const first = project(changed, entries);
    beginSessionSystemPrompt({ state, routeKey, enabled: true, entries });
    const retry = project(changed, entries);
    expect(retry.update?.content).toBe(first.update?.content);
    await expect(
      persistSessionSystemPrompt(state, () => {
        throw new Error("write rejected");
      }),
    ).rejects.toThrow("write rejected");
    const sameAttempt = project(changed, entries);
    expect(sameAttempt.restart).toBe(false);
    expect(sameAttempt.update).toBeUndefined();
    await persist(entries);
    expect(project(changed, entries).update).toBeUndefined();
  });

  it("reconciles a durable checkpoint after its acknowledgment fails", async () => {
    const entries: SessionEntry[] = [];
    project(base);
    await persist(entries);
    const update = project(changed, entries).update!;
    entries.push({
      type: "custom_message",
      id: "durable-update",
      parentId: entries[0]!.id,
      timestamp: "2026-10-01T00:00:01Z",
      customType: update.customType,
      content: update.content,
      display: false,
      details: update.details,
    });
    const state = lease.state;
    await expect(
      persistSessionSystemPrompt(state, (customType, data) => {
        entries.push({
          type: "custom",
          customType,
          data: structuredClone(data),
          id: "durable-checkpoint",
          parentId: "durable-update",
          timestamp: "2026-10-01T00:00:02Z",
        });
        throw new Error("checkpoint acknowledgment rejected");
      }),
    ).rejects.toThrow("checkpoint acknowledgment rejected");
    expect(entries.at(-1)).toMatchObject({ data: { renderedPrefix: changed.trimEnd() } });

    beginSessionSystemPrompt({ state, routeKey, enabled: true, entries });
    const restored = project(base, entries);
    expect(restored.restart).toBe(false);
    expect(restored.systemPrompt).toBe(base.trimEnd());
    expect(restored.update?.content).toContain("## Changed\nOld.");
    await persist(entries);
    expect(entries.at(-1)).toMatchObject({
      data: { restart: false, renderedPrefix: base.trimEnd() },
    });
  });

  it.each([false, true])(
    "re-pins an override persisted without its checkpoint (processRestart=%s)",
    async (processRestart) => {
      const entries: SessionEntry[] = [];
      project(base);
      await persist(entries);
      const update = project(changed, entries).update!;
      entries.push({
        type: "custom_message",
        id: "orphan-update",
        parentId: entries[0]!.id,
        timestamp: "2026-10-01T00:00:01Z",
        customType: update.customType,
        content: update.content,
        display: false,
        details: update.details,
      });
      // The live attempt may project its queued update before checkpoint persistence.
      expect(project(changed, entries).restart).toBe(false);
      if (processRestart) {
        clearEmbeddedSessionPromptStates(["system-series"]);
        lease[Symbol.dispose]();
        lease = retainEmbeddedSessionPromptState("system-series");
      }
      const state = lease.state;
      beginSessionSystemPrompt({ state, routeKey, enabled: true, entries });
      const recovered = project(base, entries);
      expect(recovered.restart).toBe(true);
      expect(recovered.update).toBeUndefined();
      await persist(entries);
      expect(entries.at(-1)).toMatchObject({
        type: "custom",
        data: { restart: true, renderedPrefix: base.trimEnd() },
      });
      expect(project(base, entries).restart).toBe(false);
    },
  );

  it("publishes a restart marker once when preparation and admission accept the same projection", async () => {
    const entries: SessionEntry[] = [];
    const prepared = project(base);
    await persist(entries);
    prepared.commit();
    await persist(entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ data: { restart: true } });
    expect(lease.state.pendingSystemPrompt).toBeUndefined();
  });

  it.each(["first request", "route", "compaction"])(
    "preserves current permission guidance when a series starts after %s",
    (reason) => {
      if (reason !== "first request") {
        project(base);
      }
      sessionIds.add("system-series");
      const notice =
        "## Permission change\nThe operator changed workspace permissions to read-only.";
      const input = {
        state: lease.state,
        routeKey: reason === "route" ? "other route" : routeKey,
        systemPrompt: `${changed}${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic\n\n<!-- openclaw:attempt:PERMISSION -->\n${notice}\n<!-- /openclaw:attempt:PERMISSION -->`,
        entries:
          reason === "compaction"
            ? [
                {
                  type: "compaction",
                  id: "cut",
                  parentId: null,
                  timestamp: "2026-10-01T00:00:00Z",
                  summary: "Summary",
                  firstKeptEntryId: "user",
                  tokensBefore: 100,
                } satisfies SessionEntry,
              ]
            : [],
      };
      const prepared = prepareSessionSystemPrompt(input);
      expect(prepared.restart).toBe(true);
      expect(prepared.systemPrompt).toBe(`${changed}${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic`);
      expect(prepared.update).toMatchObject({
        content: notice,
        details: { kind: "prompt-update", turnScoped: false },
      });
      prepared.commit();
      expect(prepareSessionSystemPrompt(input).update).toBeUndefined();
    },
  );

  it("retires earlier overrides when switching to a route that rebuilds the prompt", async () => {
    const entries: SessionEntry[] = [];
    project(base);
    await persist(entries);
    project(changed, entries);
    await persist(entries);
    const state = lease.state;
    expect(beginSessionSystemPrompt({ state, routeKey: "other", enabled: false, entries })).toBe(
      true,
    );
    expect(state.systemPrompt).toBeUndefined();
    expect(project(changed, entries).restart).toBe(true);
  });

  it.each([false, true])(
    "restores the pinned series and delivers intervening changes (changed=%s)",
    async (mismatch) => {
      const entries: SessionEntry[] = [];
      const first = project(base);
      await persist(entries);
      project(changed, entries);
      await persist(entries);
      await persist(entries);
      expect(entries).toHaveLength(2);
      clearEmbeddedSessionPromptStates(["system-series"]);
      lease[Symbol.dispose]();
      lease = retainEmbeddedSessionPromptState("system-series");
      const resumed = project(mismatch ? base : changed, entries);
      expect(resumed.restart).toBe(false);
      if (mismatch) {
        expect(resumed.update?.content).toContain("## Changed\nOld.");
      } else {
        expect(resumed.update).toBeUndefined();
      }
      expect(resumed.systemPrompt).toBe(first.systemPrompt);
      if (!mismatch) {
        await persist(entries);
        expect(entries).toHaveLength(2);
        expect(project(base, entries).update?.content).toContain("## Changed\nOld.");
      }
    },
  );

  it.each(["route", "compaction", "reset"])("starts a fresh series after %s", (reason) => {
    project(base);
    const entries: SessionEntry[] =
      reason === "route"
        ? []
        : [
            {
              type: "reset",
              reason: "reset",
              id: "reset",
              parentId: null,
              timestamp: "2026-10-01T00:00:00Z",
            },
          ];
    if (reason === "compaction") {
      entries[0] = {
        type: "compaction",
        id: "compaction",
        parentId: null,
        timestamp: "2026-10-01T00:00:00Z",
        summary: "Summary.",
        firstKeptEntryId: "user",
        tokensBefore: 100,
      };
    }
    const restarted = project(
      changed,
      entries,
      reason === "route" ? `${routeKey}-other` : routeKey,
    );
    expect(restarted.restart).toBe(true);
    expect(restarted.update).toBeUndefined();
    expect(restarted.systemPrompt).toContain(changed.trimEnd());
  });
});

describe("embedded session active project keys", () => {
  it("promotes repeated keys while retaining other recently active projects", () => {
    expect(prepare("session-lru", "repo-a")).toEqual(["repo-a"]);
    expect(prepare("session-lru", "repo-b")).toEqual(["repo-b", "repo-a"]);
    expect(prepare("session-lru", "repo-a")).toEqual(["repo-a", "repo-b"]);
  });

  it("evicts the least-recent project beyond the four-key cap", () => {
    for (const key of ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"]) {
      prepare("session-cap", key);
    }
    expect(prepare("session-cap", null)).toEqual(["repo-e", "repo-d", "repo-c", "repo-b"]);
  });

  it("keeps single-repository sessions identical and isolated", () => {
    expect(prepare("session-one", "repo-a")).toEqual(["repo-a"]);
    expect(prepare("session-one", null)).toEqual(["repo-a"]);
    expect(prepare("session-two", null)).toEqual([]);
  });
});
