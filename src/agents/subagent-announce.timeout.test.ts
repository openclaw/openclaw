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
let requesterDepthResolver: (sessionKey?: string) => number = () => 0;
let subagentSessionRunActive = true;
let shouldIgnorePostCompletion = false;
let pendingDescendantRuns = 0;
let fallbackRequesterResolution: {
  requesterSessionKey: string;
  requesterOrigin?: { channel?: string; to?: string; accountId?: string };
} | null = null;

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
  getSubagentDepthFromSessionStore: (sessionKey?: string) => requesterDepthResolver(sessionKey),
}));

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: () => false,
  queueEmbeddedPiMessage: () => false,
  waitForEmbeddedPiRunEnd: async () => true,
}));

vi.mock("./subagent-registry.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => pendingDescendantRuns,
  listSubagentRunsForRequester: () => [],
  isSubagentSessionRunActive: () => subagentSessionRunActive,
  shouldIgnorePostCompletionAnnounceForSession: () => shouldIgnorePostCompletion,
  resolveRequesterForChildSession: () => fallbackRequesterResolution,
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
): Promise<boolean> {
  return await runSubagentAnnounceFlow({
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
    requesterDepthResolver = () => 0;
    subagentSessionRunActive = true;
    shouldIgnorePostCompletion = false;
    pendingDescendantRuns = 0;
    fallbackRequesterResolution = null;
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

  it("honors configured announce timeout for completion direct agent call", async () => {
    setConfiguredAnnounceTimeout(90_000);
    await runAnnounceFlowForTest("run-config-timeout-send", {
      requesterOrigin: {
        channel: "discord",
        to: "12345",
      },
      expectsCompletionMessage: true,
    });

    const completionDirectAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(completionDirectAgentCall?.timeoutMs).toBe(90_000);
  });

  it("regression, skips parent announce while descendants are still pending", async () => {
    requesterDepthResolver = () => 1;
    pendingDescendantRuns = 2;

    const didAnnounce = await runAnnounceFlowForTest("run-pending-descendants", {
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "agent:main:subagent:parent",
    });

    expect(didAnnounce).toBe(false);
    expect(
      findGatewayCall((call) => call.method === "agent" && call.expectFinal === true),
    ).toBeUndefined();
  });

  it("regression, supports cron announceType without declaration order errors", async () => {
    const didAnnounce = await runAnnounceFlowForTest("run-announce-type", {
      announceType: "cron job",
      expectsCompletionMessage: true,
      requesterOrigin: { channel: "discord", to: "channel:cron" },
    });

    expect(didAnnounce).toBe(true);
    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ announceType?: string }>) ?? [];
    expect(internalEvents[0]?.announceType).toBe("cron job");
  });

  it("regression, routes child announce to parent session instead of grandparent when parent session still exists", async () => {
    const parentSessionKey = "agent:main:subagent:parent";
    requesterDepthResolver = (sessionKey?: string) =>
      sessionKey === parentSessionKey ? 1 : sessionKey?.includes(":subagent:") ? 1 : 0;
    subagentSessionRunActive = false;
    shouldIgnorePostCompletion = false;
    fallbackRequesterResolution = {
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "discord", to: "chan-main", accountId: "acct-main" },
    };
    // No sessionId on purpose: existence in store should still count as alive.
    sessionStore[parentSessionKey] = { updatedAt: Date.now() };

    await runAnnounceFlowForTest("run-parent-route", {
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      childSessionKey: `${parentSessionKey}:subagent:child`,
    });

    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCall?.params?.sessionKey).toBe(parentSessionKey);
    expect(directAgentCall?.params?.deliver).toBe(false);
  });

  it("regression, falls back to grandparent only when parent subagent session is missing", async () => {
    const parentSessionKey = "agent:main:subagent:parent-missing";
    requesterDepthResolver = (sessionKey?: string) =>
      sessionKey === parentSessionKey ? 1 : sessionKey?.includes(":subagent:") ? 1 : 0;
    subagentSessionRunActive = false;
    shouldIgnorePostCompletion = false;
    fallbackRequesterResolution = {
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "discord", to: "chan-main", accountId: "acct-main" },
    };

    await runAnnounceFlowForTest("run-parent-fallback", {
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      childSessionKey: `${parentSessionKey}:subagent:child`,
    });

    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCall?.params?.sessionKey).toBe("agent:main:main");
    expect(directAgentCall?.params?.deliver).toBe(true);
    expect(directAgentCall?.params?.channel).toBe("discord");
    expect(directAgentCall?.params?.to).toBe("chan-main");
    expect(directAgentCall?.params?.accountId).toBe("acct-main");
  });
});
