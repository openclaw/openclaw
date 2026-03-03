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

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: () => false,
  queueEmbeddedPiMessage: () => false,
  waitForEmbeddedPiRunEnd: async () => true,
}));

vi.mock("./subagent-registry.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  isSubagentSessionRunActive: () => true,
  resolveRequesterForChildSession: () => null,
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";

type AnnounceFlowParams = Parameters<typeof runSubagentAnnounceFlow>[0];

const defaultSessionConfig = {
  mainKey: "main",
  scope: "per-sender",
} as const;

const baseAnnounceFlowParams = {
  childSessionKey: "agent:main:subagent:worker",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "do thing",
  timeoutMs: 1_000,
  cleanup: "keep",
  roundOneReply: "done",
  waitForCompletion: false,
  outcome: { status: "ok" as const },
} satisfies Omit<AnnounceFlowParams, "childRunId">;

function setConfiguredAnnounceTimeout(timeoutMs: number): void {
  configOverride = {
    session: defaultSessionConfig,
    agents: {
      defaults: {
        subagents: {
          announceTimeoutMs: timeoutMs,
        },
      },
    },
  };
}

async function runAnnounceFlowForTest(
  childRunId: string,
  overrides: Partial<AnnounceFlowParams> = {},
): Promise<void> {
  await runSubagentAnnounceFlow({
    ...baseAnnounceFlowParams,
    childRunId,
    ...overrides,
  });
}

function findGatewayCall(predicate: (call: GatewayCall) => boolean): GatewayCall | undefined {
  return gatewayCalls.find(predicate);
}

describe("subagent announce timeout config", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    sessionStore = {};
    configOverride = {
      session: defaultSessionConfig,
    };
  });

  it("uses 60s timeout by default for direct announce agent call", async () => {
    await runAnnounceFlowForTest("run-default-timeout");

    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCall?.timeoutMs).toBe(60_000);
  });

  it("honors configured announce timeout for direct announce agent call", async () => {
    setConfiguredAnnounceTimeout(90_000);
    await runAnnounceFlowForTest("run-config-timeout-agent");

    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCall?.timeoutMs).toBe(90_000);
  });

  it("honors configured announce timeout for completion direct send call", async () => {
    setConfiguredAnnounceTimeout(90_000);
    await runAnnounceFlowForTest("run-config-timeout-send", {
      requesterOrigin: {
        channel: "discord",
        to: "12345",
      },
      expectsCompletionMessage: true,
    });

    const sendCall = findGatewayCall((call) => call.method === "send");
    expect(sendCall?.timeoutMs).toBe(90_000);
  });
});
