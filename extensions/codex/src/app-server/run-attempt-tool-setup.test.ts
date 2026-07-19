import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";

const mocks = vi.hoisted(() => ({
  buildDynamicTools: vi.fn(),
  createCodexDynamicToolBridge: vi.fn(),
  hasAuthorizationPolicies: vi.fn(),
  materializeRequesterScopedMcpToolsForHarnessRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  createAuthorizationInvocationContext: (params: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(params).filter(([, value]) => value != null)),
  createAuthorizationPrincipal: (params: { provider?: string; accountId?: string }) => ({
    kind: "unknown",
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
  }),
  embeddedAgentLog: { warn: vi.fn() },
  hasAuthorizationPolicies: mocks.hasAuthorizationPolicies,
  isHostScopedAgentToolActive: vi.fn(() => false),
  materializeRequesterScopedMcpToolsForHarnessRun:
    mocks.materializeRequesterScopedMcpToolsForHarnessRun,
  resolveAgentDir: vi.fn(() => "/agent"),
  resolveTurnAuthorityAuthorization: vi.fn(
    (turnAuthority: { authorization?: unknown } | undefined) => turnAuthority?.authorization,
  ),
}));

vi.mock("./dynamic-tool-build.js", () => ({
  buildDynamicTools: mocks.buildDynamicTools,
  formatCodexDynamicToolBuildStageSummary: vi.fn(() => ""),
  resolveCodexMessageToolProvider: vi.fn(() => "discord"),
  shouldWarnCodexDynamicToolBuildStageSummary: vi.fn(() => false),
}));

vi.mock("./dynamic-tool-profile.js", () => ({
  filterCodexDynamicTools: vi.fn((tools: unknown[]) => tools),
  resolveCodexDynamicToolsLoadingForRuntime: vi.fn(() => undefined),
}));

vi.mock("./dynamic-tools.js", () => ({
  createCodexDynamicToolBridge: mocks.createCodexDynamicToolBridge,
}));

vi.mock("./run-attempt-lifecycle.js", () => ({
  emitCodexAppServerEvent: vi.fn(),
}));

vi.mock("./run-attempt-tools.js", () => ({
  resolveCodexDynamicToolDirectNames: vi.fn(() => []),
}));

import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";

type RuntimeOverrides = {
  authorization?: unknown;
  params?: Record<string, unknown>;
};

function createRuntime(overrides: RuntimeOverrides = {}): CodexAttemptRuntime {
  const params = {
    runId: "run-1",
    sessionId: "session-1",
    sessionKey: "agent:main:discord:channel:maintenance",
    config: {},
    provider: "openai",
    modelId: "gpt-5",
    model: {
      api: "openai-responses",
      contextWindow: 128_000,
      input: ["text"],
    },
    messageProvider: "telegram",
    messageChannel: "telegram",
    agentAccountId: "legacy-account",
    senderId: "legacy-sender",
    senderName: "Legacy Name",
    senderUsername: "legacy-user",
    senderE164: "+15559999999",
    memberRoleIds: ["legacy-role"],
    senderIsOwner: true,
    isAuthorizedSender: true,
    ...overrides.params,
  };
  return {
    connection: {
      params,
      appServer: { connectionClass: "isolated" },
      preDynamicStartupStages: {
        snapshot: () => ({ totalMs: 0, stages: [] }),
      },
      mutable: {},
      startupAuthProfileId: undefined,
      resolvedWorkspace: "/workspace",
      effectiveWorkspace: "/workspace",
      effectiveCwd: "/workspace",
      sandboxSessionKey: "agent:main:discord:channel:maintenance",
      sandbox: undefined,
      runAbortController: new AbortController(),
      sessionAgentId: "main",
      pluginConfig: {},
      profilerEnabled: false,
      agentDir: "/agent",
    },
    bundleMcpThreadConfig: { diagnostics: [] },
    runtimeParams: params,
    effectiveRuntimeModelId: "gpt-5",
    nativeToolSurfaceEnabled: false,
    nativeProviderWebSearchSupport: "unsupported",
    hookChannelId: "discord:maintenance",
    authorization: overrides.authorization ?? {
      principal: { kind: "service", serviceId: "legacy-test" },
      sessionKey: "agent:main:discord:channel:maintenance",
      runId: "run-1",
      trigger: "user",
    },
  } as unknown as CodexAttemptRuntime;
}

function materializeInput(): {
  requesterSenderId?: string;
  agentAccountId?: string;
  messageChannel?: string;
  policyContext: Record<string, unknown>;
} {
  const input = mocks.materializeRequesterScopedMcpToolsForHarnessRun.mock.calls[0]?.[0];
  expect(input).toBeDefined();
  return input as {
    requesterSenderId?: string;
    agentAccountId?: string;
    messageChannel?: string;
    policyContext: Record<string, unknown>;
  };
}

beforeEach(() => {
  mocks.buildDynamicTools.mockReset().mockResolvedValue([]);
  mocks.createCodexDynamicToolBridge.mockReset().mockReturnValue({});
  mocks.hasAuthorizationPolicies.mockReset().mockReturnValue(false);
  mocks.materializeRequesterScopedMcpToolsForHarnessRun.mockReset().mockResolvedValue(undefined);
});

describe("prepareCodexAttemptTools requester identity", () => {
  it("uses admitted sender id and aliases instead of forged legacy fields", async () => {
    const authorization = {
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "canonical-account",
        senderId: "canonical-sender",
        aliases: {
          name: "Canonical Name",
          username: "canonical-user",
          e164: "+15550000001",
        },
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      sessionKey: "agent:main:discord:channel:maintenance",
      sessionId: "session-1",
      runId: "run-1",
      conversationId: "discord:maintenance",
      trigger: "user",
    };

    await prepareCodexAttemptTools(
      createRuntime({
        authorization,
        params: {
          turnAuthority: { authorization },
          senderId: "forged-sender",
          senderName: "Forged Name",
          senderUsername: "forged-user",
          senderE164: "+15559999999",
          memberRoleIds: ["guests"],
          senderIsOwner: true,
          isAuthorizedSender: false,
        },
      }),
    );

    const input = materializeInput();
    expect(input).toMatchObject({
      requesterSenderId: "canonical-sender",
      agentAccountId: "canonical-account",
      messageChannel: "discord",
    });
    expect(input.policyContext).toMatchObject({
      agentId: "main",
      senderMessageProvider: "discord",
      senderAccountId: "canonical-account",
      requireSenderRouteBinding: true,
      senderId: "canonical-sender",
      senderName: "Canonical Name",
      senderUsername: "canonical-user",
      senderE164: "+15550000001",
      memberRoleIds: ["maintainers"],
      senderIsOwner: false,
      isAuthorizedSender: true,
    });
  });

  it("keeps legacy sender identity when admitted authority is absent", async () => {
    await prepareCodexAttemptTools(createRuntime());

    const input = materializeInput();
    expect(input).toMatchObject({
      requesterSenderId: "legacy-sender",
      agentAccountId: "legacy-account",
      messageChannel: "telegram",
    });
    expect(input.policyContext).toMatchObject({
      senderMessageProvider: "telegram",
      senderAccountId: "legacy-account",
      requireSenderRouteBinding: false,
      senderId: "legacy-sender",
      senderName: "Legacy Name",
      senderUsername: "legacy-user",
      senderE164: "+15559999999",
      memberRoleIds: ["legacy-role"],
      senderIsOwner: true,
      isAuthorizedSender: true,
    });
  });

  it("clears legacy sender identity when policy is active without turn authority", async () => {
    mocks.hasAuthorizationPolicies.mockReturnValue(true);
    await prepareCodexAttemptTools(
      createRuntime({
        params: {
          messageProvider: "discord",
          messageChannel: "discord",
          agentAccountId: "molty",
        },
        authorization: {
          principal: {
            kind: "sender",
            provider: "telegram",
            accountId: "legacy-account",
            senderId: "legacy-sender",
            aliases: { name: "Legacy Name", username: "legacy-user", e164: "+15559999999" },
            senderIsOwner: true,
            isAuthorizedSender: true,
            roleIds: ["legacy-role"],
          },
          sessionKey: "agent:main:discord:channel:maintenance",
          runId: "run-1",
          trigger: "user",
        },
      }),
    );

    const input = materializeInput();
    expect(input).toMatchObject({
      agentAccountId: "molty",
      messageChannel: "discord",
    });
    expect(input.requesterSenderId).toBeUndefined();
    expect(input.policyContext).toMatchObject({
      senderMessageProvider: "discord",
      senderAccountId: "molty",
      requireSenderRouteBinding: false,
      senderIsOwner: undefined,
      isAuthorizedSender: undefined,
    });
    expect(input.policyContext.senderId).toBeUndefined();
    expect(input.policyContext.senderName).toBeUndefined();
    expect(input.policyContext.senderUsername).toBeUndefined();
    expect(input.policyContext.senderE164).toBeUndefined();
    expect(input.policyContext.memberRoleIds).toBeUndefined();
    const bridgeInput = mocks.createCodexDynamicToolBridge.mock.calls[0]?.[0] as
      | { hookContext?: { authorization?: { principal?: unknown } } }
      | undefined;
    expect(bridgeInput?.hookContext?.authorization?.principal).toEqual({
      kind: "unknown",
      provider: "discord",
      accountId: "molty",
    });
  });
});
