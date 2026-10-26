import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import * as normalization from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import type { AnyAgentTool } from "../tools/common.js";
import {
  clearEmbeddedSessionPromptStates,
  beginSessionSystemPrompt,
  prepareEmbeddedSessionActiveProjectKeys,
  prepareSessionSystemPrompt,
  prepareSessionToolSurface,
  persistSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
  retireSessionSystemPrompt,
} from "./session-prompt-state.js";

const sessionIds = new Set<string>();
const entryMetadata = { parentId: null, timestamp: "2026-10-01T00:00:00Z" };
const updateHeading =
  "System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.\n\n";

function historyEntry(type: "compaction" | "reset", id: string = type): SessionEntry {
  return type === "reset"
    ? { ...entryMetadata, type, id, reason: "reset" }
    : {
        ...entryMetadata,
        type,
        id,
        summary: "Summary.",
        firstKeptEntryId: "user",
        tokensBefore: 100,
      };
}

function promptFixture(id: string, routeKey: string) {
  let lease: ReturnType<typeof retainEmbeddedSessionPromptState>;
  function reload() {
    clearEmbeddedSessionPromptStates([id]);
    lease?.[Symbol.dispose]();
    lease = retainEmbeddedSessionPromptState(id);
    sessionIds.add(id);
  }
  beforeEach(() => reload());
  afterEach(() => lease[Symbol.dispose]());
  return {
    get state() {
      return lease.state;
    },
    reload,
    prepare(systemPrompt: string, entries: SessionEntry[] = [], route = routeKey) {
      return prepareSessionSystemPrompt({
        state: lease.state,
        routeKey: route,
        systemPrompt,
        entries,
      });
    },
    persist(this: void, entries: SessionEntry[]) {
      return persistSessionSystemPrompt(lease.state, checkpointWriter(entries));
    },
  };
}

function appendUpdate(
  entries: SessionEntry[],
  update: NonNullable<ReturnType<typeof prepareSessionSystemPrompt>["update"]>,
  id: string,
) {
  const { customType, content, details } = update;
  entries.push({
    type: "custom_message",
    id,
    timestamp: "2026-10-01T00:00:01Z",
    parentId: entries[0]!.id,
    customType,
    content,
    details,
    display: false,
  });
}

function checkpointWriter(entries: SessionEntry[]) {
  return (customType: string, data: unknown) => {
    entries.push({
      type: "custom",
      customType,
      data: structuredClone(data),
      id: `marker-${entries.length}`,
      ...entryMetadata,
    });
  };
}

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
  const routeKey = "anthropic/claude-opus-5/anthropic-messages";
  const fixture = promptFixture("system-series", routeKey);
  const persist = fixture.persist;
  const base =
    "Opening instructions.\n## Stable\nKeep this.\n## Changed\nOld.\n## Removed\nRetire this.\n";
  const changed =
    "Opening instructions.\n## Stable\nKeep this.\n## Changed\nNew.\n## Added\nAdd this.\n";
  function project(prefix: string, entries: SessionEntry[] = [], route = routeKey) {
    const result = fixture.prepare(prefix.trimEnd(), entries, route);
    result.commit();
    return result;
  }

  it("pins stable bytes and emits only changed, added, and removed sections", () => {
    const first = project(base);
    expect(first.update).toBeUndefined();
    const next = project(changed);
    expect(next.systemPrompt).toBe(first.systemPrompt);
    expect(next.update?.content).toBe(
      `${updateHeading}## Changed\nNew.\n\n\n## Added\nAdd this.\n\n## Removed\n(removed)`,
    );
    expect(project(changed).update).toBeUndefined();
    expect(project(base).update?.content).toContain("## Added\n(removed)");
    const temporal = project(`${base}${SYSTEM_PROMPT_CACHE_BOUNDARY}## Temporal Context\nday-1`);
    expect(temporal.update?.content).toContain("day-1");
    expect(temporal.update?.content).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it("preserves large prompt revisions, including distinct lone surrogates", () => {
    const stable = "## Stable\n" + "Keep these instructions.\n".repeat(100);
    const first = `${stable}## Changed\n\ud800`;
    const second = `${stable}## Changed\n\ud801`;
    expect(project(first).systemPrompt).toBe(first);
    const updated = project(second);
    expect(updated.systemPrompt).toBe(first);
    expect(updated.update?.content).toBe(`${updateHeading}## Changed\n\ud801`);
    expect(project(second, [], "other-route").systemPrompt).toBe(second);
  });

  it("replaces duplicate-heading groups without ambiguous partial removals", () => {
    project("First.\n## File\nOne.\n## File\nTwo.");
    const next = project("Second.\n## File\nChanged.\n## File\nTwo.");
    expect(next.update?.content).toContain("Second.\n");
    expect(next.update?.content).toContain("## File\nChanged.\n## File\nTwo.");
    const partial = project("Second.\n## File\nTwo.");
    expect(partial.update?.content).toBe(`${updateHeading}## File\nTwo.`);
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
      fixture.reload();
      const prepared = project(prompt, entries);
      expect(prepared.systemPrompt).toBe(first.systemPrompt);
      expect(prepared.update?.content).toBe(
        prompt === base ? undefined : `${updateHeading}${notice}`,
      );
      const checkpoints = entries.length;
      await persist(entries);
      expect(entries).toHaveLength(checkpoints + 1);
      fixture.reload();
      expect(project(prompt, entries).update).toBeUndefined();
      await persist(entries);
      expect(entries).toHaveLength(checkpoints + 1);
    }
  });

  it("retries an unpersisted update after cancellation or a failed checkpoint write", async () => {
    const entries: SessionEntry[] = [];
    project(base);
    await persist(entries);
    const state = fixture.state;
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
    appendUpdate(entries, update, "durable-update");
    const state = fixture.state;
    await expect(
      persistSessionSystemPrompt(state, (customType, data) => {
        checkpointWriter(entries)(customType, data);
        Object.assign(entries.at(-1)!, {
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
      appendUpdate(entries, update, "orphan-update");
      // The live attempt may project its queued update before checkpoint persistence.
      expect(project(changed, entries).restart).toBe(false);
      if (processRestart) {
        fixture.reload();
      }
      const state = fixture.state;
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
    expect(fixture.state.pendingSystemPrompt).toBeUndefined();
  });

  it.each(["first request", "route", "compaction", "reset"] as const)(
    "preserves current permission guidance when a series starts after %s",
    (reason) => {
      if (reason !== "first request") {
        project(base);
      }
      const notice =
        "## Permission change\nThe operator changed workspace permissions to read-only.";
      const input = {
        state: fixture.state,
        routeKey: reason === "route" ? "other route" : routeKey,
        systemPrompt: `${changed}${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic\n\n<!-- openclaw:attempt:PERMISSION -->\n${notice}\n<!-- /openclaw:attempt:PERMISSION -->`,
        entries: reason === "compaction" || reason === "reset" ? [historyEntry(reason)] : [],
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
    const state = fixture.state;
    expect(beginSessionSystemPrompt({ state, routeKey: "other", enabled: false, entries })).toBe(
      true,
    );
    expect(state.systemPrompt).toBeUndefined();
    expect(project(changed, entries).restart).toBe(true);
  });

  it("restores the pinned series and delivers intervening changes", async () => {
    const entries: SessionEntry[] = [];
    const first = project(base);
    await persist(entries);
    project(changed, entries);
    await persist(entries);
    await persist(entries);
    expect(entries).toHaveLength(2);
    fixture.reload();
    const resumed = project(changed, entries);
    expect(resumed.restart).toBe(false);
    expect(resumed.update).toBeUndefined();
    expect(resumed.systemPrompt).toBe(first.systemPrompt);
    await persist(entries);
    expect(entries).toHaveLength(2);
    expect(project(base, entries).update?.content).toContain("## Changed\nOld.");
  });
});

describe("session tool surface", () => {
  const routeKey = "openai/gpt-6-sol/openai-responses";
  const fixture = promptFixture("tool-surface", routeKey);
  const names = (tools: { name: string }[]) => tools.map(({ name }) => name).toSorted();
  const tool = (
    name: string,
    description = `${name} tool`,
    parameters: unknown = { type: "object", properties: { [name]: { type: "string" } } },
  ) =>
    ({
      name,
      label: name,
      description,
      parameters,
      execute: async () => ({
        content: [{ type: "text" as const, text: `${name} ran` }],
        details: {},
      }),
    }) as unknown as AnyAgentTool;
  const surface = (
    tools: AnyAgentTool[],
    entries: SessionEntry[] = [],
    route = routeKey,
    toolPolicy = "policy-a",
  ) =>
    prepareSessionToolSurface({
      state: fixture.state,
      routeKey: route,
      toolPolicy,
      entries,
      tools,
    });
  const definitions = (tools: AnyAgentTool[]) =>
    tools
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  async function persist(entries: SessionEntry[], prompt = "Base.") {
    fixture.prepare(prompt, entries).commit();
    await fixture.persist(entries);
  }

  it("keeps every pinned definition on a turn that builds fewer tools and refuses the missing ones", async () => {
    const entries: SessionEntry[] = [];
    const userTurn = surface([tool("read"), tool("gateway"), tool("message")]);
    await persist(entries);
    const backgroundTurn = surface([tool("read"), tool("message")], entries);
    expect(definitions(backgroundTurn)).toEqual(definitions(userTurn));
    const refused = await backgroundTurn
      .find((entry) => entry.name === "gateway")!
      .execute("x", {});
    expect(refused.details).toMatchObject({ gated: true });
    expect(JSON.stringify(refused.content)).toContain("gateway is not available in this turn");
  });

  it("preserves pins across prompt admission and checkpoints, and extends restored pins", async () => {
    const entries: SessionEntry[] = [];
    surface([tool("read"), tool("gateway")]);
    await retireSessionSystemPrompt(fixture.state, routeKey, () => undefined);
    expect(fixture.state.pendingToolSurface?.tools.map((entry) => entry.name)).toEqual([
      "gateway",
      "read",
    ]);
    await persist(entries);
    fixture.reload();
    const restored = surface([tool("read")], entries);
    expect(names(restored)).toEqual(["gateway", "read"]);
    expect(fixture.state.pendingToolSurface).toBeUndefined();
    await persist(entries, "Base.\n\n## Skills\nrefreshed");
    fixture.reload();
    expect(names(surface([tool("read")], entries))).toEqual(["gateway", "read"]);
    const extended = surface([tool("read"), tool("heartbeat_respond")], entries);
    expect(names(extended)).toEqual(["gateway", "heartbeat_respond", "read"]);
    expect(fixture.state.pendingToolSurface?.tools.map((entry) => entry.name)).toEqual([
      "gateway",
      "heartbeat_respond",
      "read",
    ]);
  });

  it("retires the pin at compaction instead of carrying it into the new history", async () => {
    const entries: SessionEntry[] = [];
    surface([tool("read"), tool("gateway")]);
    await persist(entries);
    entries.push(historyEntry("compaction", "compaction-1"));
    await persist(entries);
    expect(entries.at(-1)).toMatchObject({ data: { historyId: "compaction-1" } });
    expect(entries.at(-1)).not.toHaveProperty("data.tools");
    fixture.reload();
    expect(surface([tool("read")], entries).map((entry) => entry.name)).toEqual(["read"]);
  });

  it("loads a checkpoint written before the pin and starts a pin from it", async () => {
    const entries: SessionEntry[] = [];
    await persist(entries);
    expect(entries[0]).not.toHaveProperty("data.tools");
    fixture.reload();
    expect(fixture.prepare("Base.", entries).restart).toBe(false);
    expect(surface([tool("read")], entries).map((entry) => entry.name)).toEqual(["read"]);
    expect(fixture.state.pendingToolSurface?.tools.map((entry) => entry.name)).toEqual(["read"]);
  });

  it("drops pinned tools when the tool policy changes", () => {
    surface([tool("read"), tool("exec")]);
    expect(surface([tool("read")], [], routeKey, "policy-b").map((entry) => entry.name)).toEqual([
      "read",
    ]);
  });

  it("starts a new pin for another route", () => {
    surface([tool("read"), tool("gateway")]);
    expect(surface([tool("read")], [], "anthropic/claude-opus-5/anthropic-messages")).toHaveLength(
      1,
    );
  });

  it("keeps the pinned description when only sibling guidance changes", async () => {
    surface([tool("exec", "Run commands. No sleep loops; use automations."), tool("automations")]);
    const eventTurn = surface([tool("exec", "Run commands.")]);
    expect(eventTurn.find((entry) => entry.name === "exec")?.description).toBe(
      "Run commands. No sleep loops; use automations.",
    );
    expect(JSON.stringify((await eventTurn[0]!.execute("x", {})).content)).toContain("exec ran");
  });

  it("sends changed parameters and descriptions as built", () => {
    const description = "read v2";
    surface([tool("read")]);
    const changed = surface([
      { ...tool("read", description), parameters: { type: "object", properties: {} } },
    ] as AnyAgentTool[]);
    expect(changed.map((entry) => entry.description)).toEqual([description]);
    expect(fixture.state.pendingToolSurface?.tools).toEqual(definitions(changed));
  });

  it.each([false, true])(
    "reuses published schema facts while preserving pin equality (restored=%s)",
    async (restored) => {
      const entries: SessionEntry[] = [];
      const original = publishRuntimeToolInputSchema({
        type: "object",
        properties: { read: { type: "string" } },
      }).schema;
      const reordered = publishRuntimeToolInputSchema({
        properties: { read: { type: "string" } },
        type: "object",
      }).schema;
      const changed = publishRuntimeToolInputSchema({
        type: "object",
        properties: { read: { type: "number" } },
      }).schema;
      surface([tool("read", "Pinned description", original)]);
      await persist(entries);
      if (restored) {
        fixture.reload();
      }
      const stringify = vi.spyOn(normalization, "stableStringify");
      try {
        const unchanged = surface([tool("read", "New guidance", reordered)], entries);
        expect(unchanged[0]?.description).toBe("Pinned description");
        expect(fixture.state.pendingToolSurface).toBeUndefined();
        expect(stringify).toHaveBeenCalledTimes(restored ? 1 : 0);
        stringify.mockClear();
        const replacement = surface([tool("read", "Changed schema", changed)], entries);
        expect(replacement[0]?.description).toBe("Changed schema");
        expect(fixture.state.pendingToolSurface?.tools).toEqual(definitions(replacement));
        expect(stringify).toHaveBeenCalledTimes(restored ? 1 : 0);
      } finally {
        stringify.mockRestore();
      }
    },
  );
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
