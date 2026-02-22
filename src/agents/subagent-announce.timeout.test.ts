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
  isSubagentSessionRunActive: () => true,
  resolveRequesterForChildSession: () => null,
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";

describe("subagent announce timeout config", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    sessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("uses 60s timeout by default for direct announce agent call", async () => {
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-default-timeout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1_000,
      cleanup: "keep",
      roundOneReply: "done",
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    const directAgentCall = gatewayCalls.find(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCall?.timeoutMs).toBe(60_000);
  });

  it("honors configured announce timeout for direct announce agent call", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        defaults: {
          subagents: {
            announceTimeoutMs: 90_000,
          },
        },
      },
    };

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-config-timeout-agent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1_000,
      cleanup: "keep",
      roundOneReply: "done",
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    const directAgentCall = gatewayCalls.find(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCall?.timeoutMs).toBe(90_000);
  });

  it("honors configured announce timeout for completion direct send call", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        defaults: {
          subagents: {
            announceTimeoutMs: 90_000,
          },
        },
      },
    };

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-config-timeout-send",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "discord",
        to: "12345",
      },
      task: "do thing",
      timeoutMs: 1_000,
      cleanup: "keep",
      roundOneReply: "done",
      waitForCompletion: false,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall?.timeoutMs).toBe(90_000);
  });
});
