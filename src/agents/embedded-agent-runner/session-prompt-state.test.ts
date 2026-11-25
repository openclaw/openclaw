import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGitHubPublicationToolSelection } from "../github-tool-identity-config.js";
import { projectAgentToolDefinition } from "../prepared-tool-definition.js";
import { canonicalizeSessionEntry } from "../sessions/session-manager-persistence-entry.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import * as promptPool from "../sessions/system-prompt-pool.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createComputerTool } from "../tools/computer-tool.js";
import {
  clearEmbeddedSessionPromptStates,
  beginSessionSystemPrompt,
  prepareEmbeddedSessionActiveProjectKeys,
  prepareSessionSystemPrompt,
  prepareSessionToolSurface,
  persistSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
  readSessionSentTools,
  retireSessionSystemPrompt,
} from "./session-prompt-state.js";
import { retireUserRowPromptUpdates } from "./session-prompt-update.js";
import {
  readToolSurfaceCheckpoint,
  resolveSessionToolPolicyDigest,
} from "./session-tool-checkpoint.js";

const sessionIds = new Set<string>();
const entryMetadata = { parentId: null, timestamp: "2026-10-01T00:00:00Z" };
const updateHeading =
  "System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.\n\n";

it.each(["absent", "restored", "empty", "missing-tools", "malformed", "model-change"] as const)(
  "keeps pure checkpoint definitions aligned with host restoration (%s)",
  (shape) => {
    const definition = { name: "read", description: "Read a file", parameters: { type: "object" } };
    const marker = (id: string, data: unknown): SessionEntry => ({
      ...entryMetadata,
      type: "custom",
      id,
      customType: "openclaw.system-prompt",
      data,
    });
    const entries: SessionEntry[] =
      shape === "absent" ? [] : [marker("old-pin", { tools: [definition] })];
    if (shape === "empty") {
      entries.push(marker("empty-pin", { tools: [] }));
    }
    if (shape === "missing-tools") {
      entries.push(marker("retired-pin", { restart: true }));
    }
    if (shape === "malformed") {
      entries.push(marker("bad-pin", { tools: "not an array" }));
    }
    if (shape === "model-change") {
      entries.push({
        ...entryMetadata,
        type: "model_change",
        id: "changed",
        provider: "fixture",
        modelId: "replacement",
      });
    }
    const expected = shape === "restored" ? [definition] : shape === "empty" ? [] : undefined;
    const definitions = readToolSurfaceCheckpoint(entries)?.tools;
    expect(definitions).toEqual(expected);
    const host = readSessionSentTools(entries)?.map(projectAgentToolDefinition);
    const worker = definitions?.map((tool) =>
      projectAgentToolDefinition({ ...tool, label: tool.name }),
    );
    expect(worker).toEqual(host);
  },
);

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
    const pool = vi.spyOn(promptPool, "shareSystemPromptPrefix");
    expect(project(second).update).toBeUndefined();
    expect(pool).not.toHaveBeenCalled();
    pool.mockRestore();
    expect(project(second, [], "other-route").systemPrompt).toBe(second);
  });

  it.each(["compaction", "reset"] as const)(
    "restarts on a new %s, but not when its payload enters or leaves a bounded window",
    (kind) => {
      const state = fixture.state;
      const projectBoundary = (entries: SessionEntry[], historyBoundaryCount: number) => {
        const result = prepareSessionSystemPrompt({
          state,
          routeKey,
          entries,
          historyBoundaryCount,
          systemPrompt: entries.length ? changed : base,
        });
        result.commit();
        return result;
      };
      const first = projectBoundary([], 1);
      expect(projectBoundary([historyEntry(kind, "old")], 1).systemPrompt).toBe(first.systemPrompt);
      const compacted = projectBoundary([historyEntry(kind, "new")], 2);
      expect(compacted.restart).toBe(true);
      expect(compacted.systemPrompt).toBe(changed);
      expect(projectBoundary([], 2).systemPrompt).toBe(compacted.systemPrompt);
      beginSessionSystemPrompt(state);
      expect(projectBoundary([historyEntry(kind, "different-branch")], 2).restart).toBe(true);
    },
  );

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
    beginSessionSystemPrompt(state);
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

    beginSessionSystemPrompt(state);
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
      beginSessionSystemPrompt(state);
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

describe("prompt history identity across bounded windows", () => {
  const routeKey = "openai/gpt-6-sol/openai-responses";
  const fixture = promptFixture("history-identity", routeKey);
  const prepareCounted = (
    systemPrompt: string,
    entries: SessionEntry[],
    historyBoundaryCount?: number,
  ) => {
    const result = prepareSessionSystemPrompt({
      state: fixture.state,
      routeKey,
      systemPrompt,
      entries,
      historyBoundaryCount,
    });
    result.commit();
    return result;
  };
  const refreshed = "Base.\n## AGENTS.md\nNew rule.";

  it("restarts when the window's checkpoint predates a compaction outside it", async () => {
    const entries: SessionEntry[] = [];
    prepareCounted("Base.", entries, 0);
    await fixture.persist(entries);
    // A compaction committed after this checkpoint, and its summary did not fit the next window.
    fixture.reload();
    const next = prepareCounted(refreshed, entries, 1);
    expect(next).toMatchObject({
      restart: true,
      seriesStatus: "restarted:history",
      systemPrompt: refreshed,
    });
    expect(next.update).toBeUndefined();
  });

  it.each([0, undefined])(
    "keeps a never-compacted session pinned (checkpoint boundary count %s)",
    async (writtenCount) => {
      const entries: SessionEntry[] = [];
      prepareCounted("Base.", entries, writtenCount);
      await fixture.persist(entries);
      fixture.reload();
      const next = prepareCounted(refreshed, entries, 0);
      expect(next).toMatchObject({ restart: false, seriesStatus: "pinned", systemPrompt: "Base." });
      expect(next.update?.content).toContain("New rule.");
    },
  );
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

  it.each([false, true])(
    "pins initial computer capabilities across turns (restored=%s)",
    async (restored) => {
      const entries: SessionEntry[] = [];
      const first = createComputerTool({
        pairedNodeComputerUse: { actions: ["screenshot", "list_windows"] },
      });
      const initial = JSON.stringify(definitions(surface([first])));
      expect(initial).toBe(JSON.stringify(definitions([first])));
      await persist(entries);
      if (restored) {
        fixture.reload();
      }
      const current = createComputerTool({
        pairedNodeComputerUse: {
          actions: ["launch_app"],
          gateway: { configured: false, available: false },
        },
      });
      expect(JSON.stringify(definitions([current]))).not.toBe(initial);
      const next = surface([current], entries);
      expect(JSON.stringify(definitions(next))).toBe(initial);
      expect(next[0]!.execute).toBe(current.execute);
      const unavailable = surface([], entries);
      expect(JSON.stringify(definitions(unavailable))).toBe(initial);
      expect((await unavailable[0]!.execute("unavailable", {})).details).toMatchObject({
        gated: true,
      });
      expect(definitions(surface([current], entries, routeKey, "new-provider-config"))).toEqual(
        definitions([current]),
      );
    },
  );

  it("shares published descriptors across sessions without sharing changed or mutable definitions", () => {
    const parameters = publishRuntimeToolInputSchema({ type: "object", properties: {} }).schema;
    const pin = (name: string, description: string, schema = parameters) => {
      fixture.reload();
      surface([tool(name, description, schema)]);
      return fixture.state.pendingToolSurface!.tools![0]!;
    };
    const first = pin("read", "Read a file 🦞\ud800");
    expect(pin("read", "Read a file 🦞\ud800")).toBe(first);
    const renamed = pin("other", first.description);
    expect(renamed).not.toBe(first);
    expect(renamed.name).toBe("other");
    const changed = pin("read", "New description");
    expect(changed).not.toBe(first);
    expect(first.description).toBe("Read a file 🦞\ud800");
    expect(pin("read", "New description")).toBe(changed);
    const replacement = publishRuntimeToolInputSchema({
      type: "object",
      required: ["path"],
    }).schema;
    expect(pin("read", "New description", replacement).parameters).toBe(replacement);
    const mutable = { type: "object", properties: {} };
    expect(pin("read", "New description", mutable)).not.toBe(
      pin("read", "New description", mutable),
    );
  });

  it("reuses admitted tool payloads when checkpointing a changed prompt", async () => {
    const entries: SessionEntry[] = [];
    const parameters = publishRuntimeToolInputSchema({
      type: "object",
      properties: { path: { type: "string", description: "Path to read 🦞\ud800" } },
    }).schema;
    surface([tool("read", "Read a file", parameters), tool("exec")]);
    const write = (customType: string, data: unknown) => {
      const entry = {
        ...entryMetadata,
        type: "custom" as const,
        id: `checkpoint-${entries.length}`,
        customType,
        data,
      };
      const expected = JSON.stringify(entry);
      const canonical = canonicalizeSessionEntry(entry);
      expect(JSON.stringify(canonical)).toBe(expected);
      const saved = canonical.data as { tools: { name: string; parameters: unknown }[] };
      expect(saved.tools.find((pin) => pin.name === "read")?.parameters).toBe(parameters);
      entries.push(canonical);
    };
    fixture.prepare("Base.", entries).commit();
    await persistSessionSystemPrompt(fixture.state, write);
    const pinned = fixture.state.toolSurface!.tools;
    fixture.prepare("Base.\n## Skills\nRefreshed.", entries).commit();
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    try {
      await persistSessionSystemPrompt(fixture.state, write);
      expect(ownKeys.mock.calls.filter(([value]) => value === pinned)).toHaveLength(0);
      expect(descriptors.mock.calls.filter(([value]) => value === pinned)).toHaveLength(0);
    } finally {
      ownKeys.mockRestore();
      descriptors.mockRestore();
    }
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      data: { tools: pinned, renderedPrefix: "Base.\n## Skills\nRefreshed." },
    });
  });

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

  it("preserves pins across prompt admission and checkpoints, and holds restored pins", async () => {
    const entries: SessionEntry[] = [];
    surface([tool("read"), tool("gateway")]);
    await retireSessionSystemPrompt(fixture.state, routeKey, () => undefined);
    expect(fixture.state.pendingToolSurface?.tools?.map((entry) => entry.name)).toEqual([
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
    expect(names(surface([tool("read"), tool("heartbeat_respond")], entries))).toEqual([
      "gateway",
      "read",
    ]);
    expect(fixture.state.pendingToolSurface).toBeUndefined();
  });

  it("holds the series tool set and definitions when a cron turn builds more tools", async () => {
    const entries: SessionEntry[] = [];
    const userTurn = surface([tool("read"), tool("message")]);
    await persist(entries);
    const nodeComputer = createComputerTool({
      pairedNodeComputerUse: { actions: ["screenshot", "list_windows"] },
    });
    const changedRead = tool("read", "read v2", { type: "object", properties: {} });
    const cronTurn = surface([changedRead, tool("message"), nodeComputer], entries);
    expect(definitions(cronTurn)).toEqual(definitions(userTurn));
    expect(fixture.state.pendingToolSurface).toBeUndefined();
    const read = cronTurn.find((entry) => entry.name === "read")!;
    expect(JSON.stringify((await read.execute("x", {})).content)).toContain("read ran");
  });

  it("admits new tools and changed schemas on a surface that still filters per turn", async () => {
    const entries: SessionEntry[] = [];
    surface([tool("read")]);
    await persist(entries);
    const admit = (tools: AnyAgentTool[]) =>
      prepareSessionToolSurface({
        state: fixture.state,
        routeKey,
        toolPolicy: "policy-a",
        entries,
        tools,
        admitNewTools: true,
      });
    const changedRead = tool("read", "read v2", { type: "object", properties: {} });
    const replyTurn = admit([changedRead, tool("message")]);
    expect(names(replyTurn)).toEqual(["message", "read"]);
    expect(replyTurn.find((entry) => entry.name === "read")?.description).toBe("read v2");
    const pinnedComputer = definitions(admit([changedRead, tool("message"), createComputerTool()]));
    const nodeComputer = createComputerTool({
      pairedNodeComputerUse: { actions: ["screenshot", "list_windows"] },
    });
    // Computer capabilities stay out of the definition on filtering surfaces too.
    expect(definitions(admit([changedRead, tool("message"), nodeComputer]))).toEqual(
      pinnedComputer,
    );
    await persist(entries);
    // A later turn that builds fewer tools keeps the admitted ones listed.
    expect(names(admit([changedRead]))).toEqual(["computer", "message", "read"]);
  });

  it("starts a pin when neither the session state nor the checkpoint has one", async () => {
    const entries: SessionEntry[] = [];
    await persist(entries);
    expect(entries[0]).not.toHaveProperty("data.tools");
    fixture.reload();
    expect(names(surface([tool("read"), tool("message")], entries))).toEqual(["message", "read"]);
    await persist(entries);
    fixture.reload();
    expect(names(surface([tool("read"), tool("message"), tool("computer")], entries))).toEqual([
      "message",
      "read",
    ]);
  });

  it("keeps the series when a bounded window starts after the compaction", async () => {
    const entries: SessionEntry[] = [historyEntry("compaction", "compaction-1")];
    // Production passes the transcript's boundary count beside every window.
    const prepareWindow = (systemPrompt: string, window: SessionEntry[]) =>
      prepareSessionSystemPrompt({
        state: fixture.state,
        routeKey,
        systemPrompt,
        entries: window,
        historyBoundaryCount: 1,
      });
    prepareWindow("Base.", entries).commit();
    await fixture.persist(entries);
    fixture.reload();
    // The reload sees only entries after the compaction, then a workspace file changed.
    const prepared = prepareWindow("Base.\n## AGENTS.md\nNew rule.", entries.slice(1));
    expect(prepared.restart).toBe(false);
    expect(prepared.systemPrompt).toBe("Base.");
    expect(prepared.update?.content).toContain("New rule.");
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
    expect(fixture.state.pendingToolSurface?.tools?.map((entry) => entry.name)).toEqual(["read"]);
  });

  it("starts one new pin after an upgrade changes the tool policy digest", async () => {
    const config = { tools: { toolSearch: { mode: "tools" as const } } };
    // The digest main wrote for the same configuration (before the MCP and fixed-listing keys).
    const preUpgrade = sha256Hex(
      stableStringify([
        config.tools,
        undefined,
        undefined,
        undefined,
        readGitHubPublicationToolSelection(config),
      ]),
    );
    const postUpgrade = resolveSessionToolPolicyDigest(config, "main");
    expect(postUpgrade).not.toBe(preUpgrade);
    expect(resolveSessionToolPolicyDigest(config, "main")).toBe(postUpgrade);
    const entries: SessionEntry[] = [];
    // A pin written before the upgrade, without `message`.
    surface([tool("read")], entries, routeKey, preUpgrade);
    await persist(entries);
    fixture.reload();
    const after = surface([tool("read"), tool("message")], entries, routeKey, postUpgrade);
    expect(after.map((entry) => entry.name)).toEqual(["message", "read"]);
    await persist(entries);
    fixture.reload();
    // The new pin holds from then on.
    expect(
      surface([tool("read")], entries, routeKey, postUpgrade).map((entry) => entry.name),
    ).toEqual(["message", "read"]);
  });

  it.each([false, true])(
    "separates participation pins across warm and restored turns (restored=%s)",
    async (restored) => {
      const entries: SessionEntry[] = [];
      const ceiling = {
        kind: "send" as const,
        profileId: "guest",
        sessionKey: "agent:main:shared",
        tools: ["read", "ls"],
      };
      const creatorPolicy = resolveSessionToolPolicyDigest({}, "main");
      const participantPolicy = resolveSessionToolPolicyDigest({}, "main", ceiling);
      expect(participantPolicy).not.toBe(creatorPolicy);
      expect(
        resolveSessionToolPolicyDigest({}, "main", {
          ...ceiling,
          profileId: "other",
          tools: ["ls", "read", "read"],
        }),
      ).toBe(participantPolicy);
      const defaultPolicy = resolveSessionToolPolicyDigest({}, "main", {
        ...ceiling,
        tools: undefined,
      });
      expect(defaultPolicy).not.toBe(participantPolicy);
      expect(defaultPolicy).not.toBe(creatorPolicy);
      for (const [policy, offered] of [
        [participantPolicy, ["ls", "read"]],
        [creatorPolicy, ["exec", "ls", "message", "read"]],
        [participantPolicy, ["ls", "read"]],
        [defaultPolicy, ["exec", "ls", "read"]],
        [creatorPolicy, ["exec", "ls", "message", "read"]],
      ] as const) {
        const tools = surface(
          offered.map((name) => tool(name)),
          entries,
          routeKey,
          policy,
        );
        expect(names(tools)).toEqual(offered);
        await persist(entries);
        if (restored) {
          fixture.reload();
        }
      }
    },
  );

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
    const exec = eventTurn.find((entry) => entry.name === "exec")!;
    expect(exec.description).toBe("Run commands. No sleep loops; use automations.");
    expect(JSON.stringify((await exec.execute("x", {})).content)).toContain("exec ran");
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

it("retires user-row prompt deltas sent before the newest rebuild", () => {
  const row = (text: string, timestamp: string, projection?: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.parse(timestamp),
    ...(projection
      ? { __openclaw: { modelPromptProjection: { version: 1, text: projection } } }
      : {}),
  });
  const plain = row("before", "2026-10-01T00:00:01Z", `before\n\n${updateHeading}rule A`);
  const hooked = row(
    "hooked",
    "2026-10-01T00:00:02Z",
    `recalled memory\n\nhooked\n\n${updateHeading}rule B`,
  );
  const recent = row("after", "2026-10-01T00:00:04Z", `after\n\n${updateHeading}rule C`);
  const update = {
    role: "custom" as const,
    customType: "openclaw.system-update",
    content: `${updateHeading}rule D`,
    display: false,
    details: { kind: "prompt-update", turnScoped: false },
    timestamp: Date.parse("2026-10-01T00:00:05Z"),
  };
  const rebuild: SessionEntry = {
    ...entryMetadata,
    timestamp: "2026-10-01T00:00:03Z",
    id: "rebuild",
    type: "custom",
    customType: "openclaw.system-prompt",
    data: { restart: true },
  };
  const messages = [plain, hooked, recent, update];
  expect(retireUserRowPromptUpdates(messages, [], false)).toBe(messages);
  const retained = retireUserRowPromptUpdates(messages, [rebuild], false);
  expect(retained.slice(2)).toEqual([recent, update]);
  expect(retained[0]).not.toHaveProperty("__openclaw.modelPromptProjection");
  // Other model-only text on the row survives the retirement.
  expect(retained[1]).toHaveProperty(
    "__openclaw.modelPromptProjection.text",
    "recalled memory\n\nhooked",
  );
  // The rebuilding request drops prompt-update rows and every older delta.
  const rebuilding = retireUserRowPromptUpdates(messages, [], true);
  expect(rebuilding).toHaveLength(3);
  expect(rebuilding[2]).not.toHaveProperty("__openclaw.modelPromptProjection");
});
