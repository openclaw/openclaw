import { beforeEach, describe, expect, it, vi } from "vitest";

type GatewayCall = {
  method?: string;
  timeoutMs?: number;
  expectFinal?: boolean;
  params?: Record<string, unknown>;
};

const gatewayCalls: GatewayCall[] = [];
let callGatewayImpl: (request: GatewayCall) => Promise<unknown> = async () => ({});
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: GatewayCall) => {
    gatewayCalls.push(request);
    return await callGatewayImpl(request);
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
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: () => false,
  queueEmbeddedPiMessage: () => false,
  waitForEmbeddedPiRunEnd: async () => true,
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";
import {
  addSubagentRunForTests,
  countPendingDescendantRuns,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

function findFinalDirectAgentCall(): GatewayCall | undefined {
  return gatewayCalls.find((call) => call.method === "agent" && call.expectFinal === true);
}

describe("subagent announce yield + spawn race", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    callGatewayImpl = async () => ({});
    sessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    resetSubagentRegistryForTests({ persist: false });
  });

  it("defers announce when a yield-aborted parent still has a concurrently spawned pending child", async () => {
    const parentSessionKey = "agent:main:subagent:orchestrator-race";

    addSubagentRunForTests({
      runId: "run-orchestrator-race",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate",
      cleanup: "keep",
      createdAt: 100,
      startedAt: 100,
      endedAt: 110,
      expectsCompletionMessage: true,
    });
    addSubagentRunForTests({
      runId: "run-worker-race",
      childSessionKey: `${parentSessionKey}:subagent:worker`,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "child task",
      cleanup: "keep",
      createdAt: 111,
      startedAt: 111,
      expectsCompletionMessage: true,
    });

    // Regression guard: when sessions_spawn commits before the announce check,
    // the parent must still see the pending child and defer its completion.
    expect(countPendingDescendantRuns(parentSessionKey)).toBe(1);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: parentSessionKey,
      childRunId: "run-orchestrator-race",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate",
      timeoutMs: 1_000,
      cleanup: "keep",
      roundOneReply: "Yielded after concurrent sessions_spawn.",
      waitForCompletion: false,
      expectsCompletionMessage: true,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(false);
    expect(countPendingDescendantRuns(parentSessionKey)).toBe(1);
    expect(findFinalDirectAgentCall()).toBeUndefined();
  });
});
