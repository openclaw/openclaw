import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import type { ToolUsageRankingSnapshot } from "../tool-usage-ranking.js";
import {
  buildSystemPromptRouteKey,
  clearEmbeddedSessionPromptStates,
  getSessionToolUsageRanking,
  persistSessionSystemPrompt,
  prepareSessionSystemPrompt,
  prepareSessionToolSurface,
  prepareSessionToolUsageRanking,
  retainEmbeddedSessionPromptState,
} from "./session-prompt-state.js";

const ids = ["openclaw:example:alpha", "openclaw:example:beta"];
const route = buildSystemPromptRouteKey({
  provider: "example",
  model: "one",
  harness: "openclaw",
  surface: "tools",
});
const sessions: string[] = [];
function lease(id: string) {
  sessions.push(id);
  return retainEmbeddedSessionPromptState(id);
}
afterEach(() => clearEmbeddedSessionPromptStates(sessions.splice(0)));
function writer(entries: SessionEntry[]) {
  return async (customType: string, data: unknown) => {
    entries.push({
      type: "custom",
      customType,
      data: structuredClone(data),
      id: `checkpoint-${entries.length}`,
      parentId: null,
      timestamp: "2026-11-01T00:00:00Z",
    });
  };
}

it("freezes usage selection through turns and restart, and refreshes only at route/history boundaries", async () => {
  const current = lease("usage-prefix");
  const entries: SessionEntry[] = [];
  let storedOrder = ids;
  const readRankedIds = vi.fn(async () => storedOrder);
  const input = {
    state: current.state,
    routeKey: route,
    entries,
    enabled: true,
    catalogIds: ids,
    now: 100,
    readRankedIds,
  };
  const initial = await prepareSessionToolUsageRanking(input);
  const prompt = (ranking: ToolUsageRankingSnapshot | undefined) =>
    `## Tooling\n${ranking?.orderedToolIds.join("\n")}`;
  prepareSessionSystemPrompt({ ...input, systemPrompt: prompt(initial) }).commit();
  await persistSessionSystemPrompt(current.state, writer(entries));
  storedOrder = ids.toReversed();
  for (let turn = 1; turn <= 4; turn++) {
    const frozen = await prepareSessionToolUsageRanking({ ...input, now: 100 + turn });
    expect(frozen).toBe(initial);
    expect(
      prepareSessionSystemPrompt({ ...input, systemPrompt: prompt(frozen) }).systemPrompt,
    ).toBe(prompt(initial));
  }
  expect(readRankedIds).toHaveBeenCalledTimes(1);
  current[Symbol.dispose]();
  const restarted = lease("usage-prefix");
  const restored = await prepareSessionToolUsageRanking({
    ...input,
    state: restarted.state,
    now: 200,
  });
  expect(restored).toEqual(initial);
  expect(readRankedIds).toHaveBeenCalledTimes(1);
  const changedRoute = buildSystemPromptRouteKey({
    provider: "example",
    model: "two",
    harness: "openclaw",
    surface: "tools",
  });
  expect(
    (
      await prepareSessionToolUsageRanking({
        ...input,
        state: restarted.state,
        routeKey: changedRoute,
        now: 300,
      })
    )?.orderedToolIds,
  ).toEqual(storedOrder);
  expect(readRankedIds).toHaveBeenCalledTimes(2);
  entries.push({
    type: "reset",
    reason: "reset",
    id: "reset",
    parentId: null,
    timestamp: "2026-11-01T01:00:00Z",
  });
  await prepareSessionToolUsageRanking({
    ...input,
    state: restarted.state,
    routeKey: changedRoute,
    now: 400,
  });
  expect(readRankedIds).toHaveBeenCalledTimes(3);
  restarted[Symbol.dispose]();
});

it("does not rewrite restored ranking checkpoints", async () => {
  const entries: SessionEntry[] = [];
  const readRankedIds = vi.fn(async () => ids);
  const checkpointCounts: number[] = [];
  for (const catalogIds of [ids, ids, [...ids, "openclaw:new:tool"]]) {
    const current = lease("usage-restored");
    try {
      const input = {
        state: current.state,
        routeKey: route,
        entries,
        catalogIds,
        enabled: true,
        now: 100,
        readRankedIds,
      };
      await prepareSessionToolUsageRanking(input);
      prepareSessionToolSurface({ ...input, toolPolicy: "same", tools: [] });
      prepareSessionSystemPrompt({ ...input, systemPrompt: "Same frozen prompt." }).commit();
      await persistSessionSystemPrompt(current.state, writer(entries));
      checkpointCounts.push(entries.length);
    } finally {
      current[Symbol.dispose]();
    }
  }
  expect(checkpointCounts).toEqual([1, 1, 2]);
  expect(readRankedIds).toHaveBeenCalledOnce();
});

it("inherits a durable parent snapshot without reading the child's scores, but never inherits authority", async () => {
  const parent = lease("usage-parent");
  const snapshot = await prepareSessionToolUsageRanking({
    state: parent.state,
    routeKey: route,
    entries: [],
    enabled: true,
    catalogIds: ids,
    now: 100,
    readRankedIds: async () => ids,
  });
  const persistedSeed = structuredClone(getSessionToolUsageRanking("usage-parent"));
  expect(persistedSeed).toEqual(snapshot);
  parent[Symbol.dispose]();
  const child = lease("usage-child");
  const readRankedIds = vi.fn(async () => ["openclaw:other:private"]);
  const entries: SessionEntry[] = [];
  const input = {
    state: child.state,
    routeKey: route,
    entries,
    enabled: true,
    catalogIds: [ids[1]!],
    inherited: persistedSeed,
    now: 200,
    readRankedIds,
  };
  const inherited = await prepareSessionToolUsageRanking(input);
  expect(inherited?.orderedToolIds).toEqual([ids[1]]);
  expect(readRankedIds).not.toHaveBeenCalled();
  prepareSessionSystemPrompt({ ...input, systemPrompt: "child authorized catalog only" }).commit();
  await persistSessionSystemPrompt(child.state, writer(entries));
  child[Symbol.dispose]();
  const resumed = lease("usage-child");
  expect(
    await prepareSessionToolUsageRanking({ ...input, state: resumed.state, inherited: undefined }),
  ).toEqual(inherited);
  expect(readRankedIds).not.toHaveBeenCalled();
  resumed[Symbol.dispose]();
});

it("keeps disabled sessions read-free and admits catalog newcomers without refreshing learned order", async () => {
  const current = lease("usage-disabled");
  const readRankedIds = vi.fn(async () => ids);
  const input = {
    state: current.state,
    routeKey: route,
    entries: [],
    enabled: false,
    catalogIds: ids,
    now: 100,
    readRankedIds,
  };
  expect(await prepareSessionToolUsageRanking(input)).toBeUndefined();
  expect(await prepareSessionToolUsageRanking({ ...input, enabled: true })).toBeUndefined();
  expect(readRankedIds).not.toHaveBeenCalled();
  const switched = {
    ...input,
    enabled: true,
    routeKey: buildSystemPromptRouteKey({
      model: "one",
      harness: "openclaw",
      surface: "code-mode",
    }),
  };
  const first = await prepareSessionToolUsageRanking(switched);
  const next = await prepareSessionToolUsageRanking({
    ...switched,
    catalogIds: [...ids, "openclaw:new:tool"],
    now: 150,
  });
  expect(next?.orderedToolIds).toEqual(first?.orderedToolIds);
  expect(next?.at).toBe(first?.at);
  expect(next?.newcomers?.["openclaw:new:tool"]).toBe(150);
  expect(readRankedIds).toHaveBeenCalledTimes(1);
  current[Symbol.dispose]();
});
