/**
 * Tests for announce-side chain guard (maxChainLength enforcement).
 * Verifies [continuation:chain-hop:N] task-prefix tracking using the repo's
 * max-depth convention: a shard already at hop N cannot spawn hop N+1 when
 * maxChainLength is N.
 *
 * Coverage gap from CODEWALK.md: "No existing test for announce-side chain guard"
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks that DO intercept the SUT (non-barrel modules) ---

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: Record<string, unknown>) => {
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    return {};
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

vi.mock("./subagent-announce.registry.runtime.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  countPendingDescendantRunsExcludingRun: () => 0,
  isSubagentSessionRunActive: () => true,
  listSubagentRunsForRequester: () => [],
  replaceSubagentRunAfterSteer: () => true,
  resolveRequesterForChildSession: () => null,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
}));

vi.mock("../auto-reply/continuation/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation/state.js")>()),
  registerContinuationTimerHandle: vi.fn(),
  retainContinuationTimerRef: vi.fn(),
  releaseContinuationTimerRef: vi.fn(),
  unregisterContinuationTimerHandle: vi.fn(),
}));

vi.mock("../auto-reply/continuation-delegate-store.js", () => ({
  consumePendingDelegates: vi.fn(() => []),
}));

import { consumePendingDelegates } from "../auto-reply/continuation-delegate-store.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveStorePath } from "../config/sessions.js";
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
        },
      },
    },
  };
}

/**
 * Write session data directly to the session store file.
 * vitest 4.x forks pool doesn't intercept vi.mock for barrel re-exports
 * (config.js -> io.js, sessions.js -> store.js) so we use the real
 * filesystem-backed session store instead.
 */
function writeSessionStore(data: Record<string, unknown>) {
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(data), "utf8");
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
    // Write empty session store so loadSessionEntryByKey finds no entries
    writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig() as any);
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:chain-next",
      runId: "run-chain-next",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    clearRuntimeConfigSnapshot();
  });

  it("allows chain hop when nextChainHop <= maxChainLength", async () => {
    const params = buildChainShardParams(5);
    await runSubagentAnnounceFlow(params);
    // Fire-and-forget spawn: flush microtasks
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:6]");
  });

  it("allows chain hop when the next shard reaches the configured boundary", async () => {
    const params = buildChainShardParams(9);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:1]");
  });

  it("respects custom maxChainLength from config at the exact boundary", async () => {
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 3 }) as any);

    const params = buildChainShardParams(2);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:3]");
  });

  it("respects custom maxChainLength from config after the boundary is reached", async () => {
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 3 }) as any);

    const params = buildChainShardParams(3);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("blocks on cost cap even when chain length is within bounds", async () => {
    writeSessionStore({
      "agent:main:discord:dm:test-chain": {
        sessionId: "test",
        updatedAt: Date.now(),
        continuationChainTokens: 600_000,
      },
    });

    const params = buildChainShardParams(1);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tool-delegate chain guard (nextToolHop > toolMaxChainLength)
// ---------------------------------------------------------------------------

/**
 * Build params for a tool-delegate chain guard test.
 * The roundOneReply has NO bracket [[CONTINUE_DELEGATE:...]] so the bracket
 * path stays dormant and only tool delegates (from consumePendingDelegates)
 * are evaluated.
 */
function buildToolDelegateParams(hopIndex: number): AnnounceFlowParams {
  const taskPrefix = hopIndex > 0 ? `[continuation:chain-hop:${hopIndex}] ` : "";
  return {
    childSessionKey: `agent:main:subagent:tool-hop-${hopIndex}`,
    childRunId: `run-tool-hop-${hopIndex}`,
    requesterSessionKey: "agent:main:discord:dm:test-chain",
    requesterDisplayKey: "test-chain",
    task: `${taskPrefix}Tool-delegated from sub-agent (depth 1): do research`,
    roundOneReply: "Research complete.", // no bracket delegate
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
}

const mockedConsumePendingDelegates = vi.mocked(consumePendingDelegates);

describe("tool-delegate chain guard (nextToolHop > toolMaxChainLength)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 10 }) as any);
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:tool-chain-next",
      runId: "run-tool-chain-next",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    mockedConsumePendingDelegates.mockReturnValue([]);
    clearRuntimeConfigSnapshot();
  });

  it("allows tool delegate at maxChainLength-1 (next hop = maxChainLength)", async () => {
    // childChainHop=9, bracketConsumedHop=0, toolHopBase=9, nextToolHop=10 = maxChainLength → allowed
    mockedConsumePendingDelegates.mockReturnValue([{ task: "tool task at boundary minus one" }]);

    const params = buildToolDelegateParams(9);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:10]");
    expect(spawnArgs.task).toContain("Tool-delegated");
  });

  it("allows tool delegate at maxChainLength (next hop = maxChainLength, off-by-one fix)", async () => {
    // With maxChainLength=5: childChainHop=4, nextToolHop=5 = maxChainLength → allowed (> not >=)
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 5 }) as any);
    mockedConsumePendingDelegates.mockReturnValue([{ task: "tool task exactly at boundary" }]);

    const params = buildToolDelegateParams(4);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:5]");
  });

  it("rejects tool delegate at maxChainLength+1 (next hop exceeds max)", async () => {
    // childChainHop=10, nextToolHop=11 > maxChainLength(10) → rejected
    mockedConsumePendingDelegates.mockReturnValue([{ task: "tool task beyond boundary" }]);

    const params = buildToolDelegateParams(10);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("rejects tool delegate well beyond maxChainLength", async () => {
    mockedConsumePendingDelegates.mockReturnValue([{ task: "tool task way beyond boundary" }]);

    const params = buildToolDelegateParams(15);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("respects custom maxChainLength for tool delegates", async () => {
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 3 }) as any);
    mockedConsumePendingDelegates.mockReturnValue([{ task: "tool task at custom boundary" }]);

    // hop 2 → next=3 = maxChainLength → allowed
    const paramsAllow = buildToolDelegateParams(2);
    await runSubagentAnnounceFlow(paramsAllow);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    spawnSpy.mockClear();

    // hop 3 → next=4 > maxChainLength → rejected
    const paramsReject = buildToolDelegateParams(3);
    await runSubagentAnnounceFlow(paramsReject);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
