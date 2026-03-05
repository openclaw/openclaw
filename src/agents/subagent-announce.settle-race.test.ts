import { beforeEach, describe, expect, it, vi } from "vitest";

type GatewayCall = {
  method?: string;
  timeoutMs?: number;
  expectFinal?: boolean;
  params?: Record<string, unknown>;
};

const gatewayCalls: GatewayCall[] = [];
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
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

let embeddedRunActive = true;
let waitForEndResult = false;

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: () => embeddedRunActive,
  queueEmbeddedPiMessage: () => false,
  waitForEmbeddedPiRunEnd: async () => waitForEndResult,
}));

vi.mock("./subagent-registry.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  isSubagentSessionRunActive: () => true,
  resolveRequesterForChildSession: () => null,
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";

type AnnounceFlowParams = Parameters<typeof runSubagentAnnounceFlow>[0];

const baseParams = {
  childSessionKey: "agent:main:subagent:worker",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "test task",
  timeoutMs: 1_000,
  cleanup: "keep",
  roundOneReply: "done",
  waitForCompletion: false,
} satisfies Omit<AnnounceFlowParams, "childRunId">;

beforeEach(() => {
  gatewayCalls.length = 0;
  sessionStore = {
    "agent:main:main": { sessionId: "sid-main" },
    "agent:main:subagent:worker": { sessionId: "sid-worker" },
  };
  configOverride = { session: { mainKey: "main", scope: "per-sender" } };
  embeddedRunActive = true;
  waitForEndResult = false;
});

describe("subagent announce settle race (#36081)", () => {
  it("proceeds with announce when embedded run is still active but outcome is terminal", async () => {
    embeddedRunActive = true;
    waitForEndResult = false;

    const result = await runSubagentAnnounceFlow({
      ...baseParams,
      childRunId: "run-with-outcome",
      outcome: { status: "ok" },
    });

    expect(result).toBe(true);
    const agentCalls = gatewayCalls.filter((c) => c.method === "agent");
    expect(agentCalls.length).toBeGreaterThan(0);
  });

  it("proceeds with announce when outcome is error (terminal)", async () => {
    embeddedRunActive = true;
    waitForEndResult = false;

    const result = await runSubagentAnnounceFlow({
      ...baseParams,
      childRunId: "run-with-error-outcome",
      outcome: { status: "error", error: "test error" },
    });

    expect(result).toBe(true);
  });

  it("defers when embedded run is active and no terminal outcome", async () => {
    embeddedRunActive = true;
    waitForEndResult = false;

    const result = await runSubagentAnnounceFlow({
      ...baseParams,
      childRunId: "run-no-outcome",
      outcome: undefined,
    });

    expect(result).toBe(false);
  });

  it("defers when embedded run is active with unknown outcome", async () => {
    embeddedRunActive = true;
    waitForEndResult = false;

    const result = await runSubagentAnnounceFlow({
      ...baseParams,
      childRunId: "run-unknown-outcome",
      outcome: { status: "unknown" },
    });

    expect(result).toBe(false);
  });

  it("proceeds normally when waitForEmbeddedPiRunEnd settles", async () => {
    embeddedRunActive = false;
    waitForEndResult = true;

    const result = await runSubagentAnnounceFlow({
      ...baseParams,
      childRunId: "run-settled",
      outcome: { status: "ok" },
    });

    expect(result).toBe(true);
  });
});
