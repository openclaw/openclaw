/**
 * Tests for announce-side chain guard (maxChainLength enforcement).
 * Verifies [continuation:chain-hop:N] task-prefix tracking using the repo's
 * max-depth convention: a shard already at hop N cannot spawn hop N+1 when
 * maxChainLength is N.
 *
 * Coverage gap from CODEWALK.md: "No existing test for announce-side chain guard"
 *
 * @author Elliott 🌻
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- State ---
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;

// --- Same mock pattern as subagent-announce.timeout.test.ts ---

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: Record<string, unknown>) => {
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    return {};
  }),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions-main.json",
  resolveMainSessionKey: (key: string) => key,
  updateSessionStore: vi.fn(async (_path: string, fn: (s: Record<string, unknown>) => void) => {
    const store = { ...sessionStore };
    fn(store);
  }),
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 1,
}));

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: () => false,
  queueEmbeddedPiMessage: () => false,
  waitForEmbeddedPiRunEnd: async () => true,
}));

vi.mock("./subagent-registry.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  countPendingDescendantRunsExcludingRun: () => 0,
  isSubagentSessionRunActive: () => true,
  listSubagentRunsForRequester: () => [],
  replaceSubagentRunAfterSteer: () => true,
  resolveRequesterForChildSession: () => null,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";
import * as subagentSpawn from "./subagent-spawn.js";

type AnnounceFlowParams = Parameters<typeof runSubagentAnnounceFlow>[0];

function makeConfig(
  overrides: {
    maxChainLength?: number;
    costCapTokens?: number;
    enabled?: boolean;
  } = {},
) {
  return {
    session: { mainKey: "main", scope: "per-sender" as const },
    agents: {
      defaults: {
        continuation: {
          enabled: overrides.enabled ?? true,
          maxChainLength: overrides.maxChainLength ?? 10,
          costCapTokens: overrides.costCapTokens ?? 500_000,
          minDelayMs: 0,
          maxDelayMs: 0, // zero delay to avoid timer issues
          generationGuardTolerance: 0,
        },
      },
    },
  };
}

function buildChainShardParams(hopIndex: number): AnnounceFlowParams {
  const taskPrefix = hopIndex > 0 ? `[continuation:chain-hop:${hopIndex}] ` : "";
  return {
    childSessionKey: `agent:main:subagent:shard-hop-${hopIndex}`,
    childRunId: `run-hop-${hopIndex}`,
    requesterSessionKey: "agent:main:discord:dm:test-chain",
    requesterDisplayKey: "test-chain",
    task: `${taskPrefix}Delegated task: do research`,
    roundOneReply: `Research result.\n[[CONTINUE_DELEGATE: continue next step]]`,
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
}

describe("announce-side chain guard (maxChainLength enforcement)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionStore = {};
    configOverride = makeConfig();
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:chain-next",
      runId: "run-chain-next",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it("allows chain hop when nextChainHop <= maxChainLength", async () => {
    const params = buildChainShardParams(5);
    await runSubagentAnnounceFlow(params);
    // With minDelayMs=0, maxDelayMs=0, spawn is immediate (no timer)

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:6]");
  });

  it("allows chain hop when the next shard reaches the configured boundary", async () => {
    const params = buildChainShardParams(9);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:10]");
  });

  it("blocks chain hop once the completing shard already occupies maxChainLength", async () => {
    const params = buildChainShardParams(10);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("blocks chain hop well beyond maxChainLength", async () => {
    const params = buildChainShardParams(15);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("allows first bracket-started hop (no prefix → hop 0)", async () => {
    const params = buildChainShardParams(0);
    params.task = "Delegated task: do research";
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:1]");
  });

  it("respects custom maxChainLength from config at the exact boundary", async () => {
    configOverride = makeConfig({ maxChainLength: 3 });

    const params = buildChainShardParams(2);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:3]");
  });

  it("respects custom maxChainLength from config after the boundary is reached", async () => {
    configOverride = makeConfig({ maxChainLength: 3 });

    const params = buildChainShardParams(3);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("blocks on cost cap even when chain length is within bounds", async () => {
    sessionStore = {
      "agent:main:discord:dm:test-chain": {
        sessionId: "test",
        updatedAt: Date.now(),
        continuationChainTokens: 600_000,
      },
    };

    const params = buildChainShardParams(1);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
