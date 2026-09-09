// Msteams tests cover employee-container dispatch behavior.
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const gatewayRuntimeMockState = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
}));

const loginRuntimeMockState = vi.hoisted(() => ({
  runDeviceLoginFlow: vi.fn(),
}));

const authProfilesMockState = vi.hoisted(() => ({
  setAuthProfileOrder: vi.fn(),
}));

const fsMockState = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

const replyDispatcherMockState = vi.hoisted(() => ({
  deliver: vi.fn(),
  settle: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: fsMockState.readFile,
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: gatewayRuntimeMockState.callGatewayFromCli,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-login-flow-runtime", () => ({
  codexChannelLoginRuntime: {
    runDeviceLoginFlow: loginRuntimeMockState.runDeviceLoginFlow,
  },
}));

vi.mock("../../../src/agents/auth-profiles.js", () => ({
  setAuthProfileOrder: authProfilesMockState.setAuthProfileOrder,
}));

vi.mock("./reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcherOptions: {
      onSettled: replyDispatcherMockState.settle,
    },
    delivery: {
      deliver: replyDispatcherMockState.deliver,
    },
    replyOptions: {},
  }),
}));

function createContext(): MSTeamsTurnContext {
  return {
    activity: {
      id: "teams-message-1",
      type: "message",
      text: "Hello from Teams",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: "bf-user-id",
        aadObjectId: "user-aad",
        name: "Kevin User",
      },
      recipient: {
        id: "bot-id",
        name: "OpenClaw",
      },
      conversation: {
        id: "19:personal-chat",
        conversationType: "personal",
      },
      channelData: {},
      attachments: [],
    },
    sendActivity: vi.fn(async () => ({ id: "activity-id" })),
    sendActivities: async () => [],
  } as unknown as MSTeamsTurnContext;
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        dmPolicy: "allowlist",
        allowFrom: ["user-aad"],
        employeeContainerDispatch: {
          enabled: true,
          gatewayUrlTemplate: "ws://employee-agent-{agentId}:18789",
          tokenConfigPathTemplate:
            "/srv/openclaw/data/employee-agents/{agentId}/config/openclaw.json",
          waitTimeoutMs: 5000,
        },
      },
    },
  } as OpenClawConfig;
}

describe("msteams employee container dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.readFile.mockResolvedValue(
      JSON.stringify({
        gateway: { auth: { token: "test-token" } },
        agents: { entries: { main: { name: "Kevin User" } } },
        plugins: {
          entries: { openai: { enabled: true }, codex: { enabled: true } },
        },
      }),
    );
    loginRuntimeMockState.runDeviceLoginFlow.mockImplementation(async (opts) => {
      await opts.sendMessage("Open https://auth.openai.com/device and enter code ABCD-EFGH.");
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:test", provider: "openai", mode: "oauth" }],
      };
    });
    authProfilesMockState.setAuthProfileOrder.mockResolvedValue({
      order: { openai: ["openai:test"] },
    });
    gatewayRuntimeMockState.callGatewayFromCli
      .mockResolvedValueOnce({ runId: "run-1" })
      .mockResolvedValueOnce({
        status: "ok",
        terminalReply: { text: "Reply from employee main" },
      });
    replyDispatcherMockState.deliver.mockResolvedValue({
      finalization: Promise.resolve(),
    });
    replyDispatcherMockState.settle.mockResolvedValue(undefined);
    installMSTeamsTestRuntime({
      resolveAgentRoute: () => ({
        agentId: "kkilgo",
        accountId: "default",
        sessionKey: "agent:kkilgo:msteams:direct:user-aad",
      }),
    });
  });

  it("runs a bound direct Teams turn in the employee container main agent", async () => {
    const cfg = createConfig();
    const runtime = { error: vi.fn() } as unknown as RuntimeEnv;
    const handler = createMSTeamsMessageHandler(createMSTeamsMessageHandlerDeps({ cfg, runtime }));

    await handler(createContext());
    expect(fsMockState.readFile).toHaveBeenCalledWith(
      "/srv/openclaw/data/employee-agents/kkilgo/config/openclaw.json",
      "utf8",
    );
    expect(gatewayRuntimeMockState.callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "agent",
      {
        url: "ws://employee-agent-kkilgo:18789",
        token: "test-token",
        timeout: "5000",
      },
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:msteams:direct:user-aad",
        message: "Hello from Teams",
        deliver: false,
        sourceReplyDeliveryMode: "automatic",
      }),
      { scopes: ["operator.write"], deviceIdentity: null },
    );
    expect(gatewayRuntimeMockState.callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "agent.wait",
      {
        url: "ws://employee-agent-kkilgo:18789",
        token: "test-token",
        timeout: "15000",
      },
      { runId: "run-1", timeoutMs: 5000 },
      { scopes: ["operator.write"], deviceIdentity: null },
    );
    expect(replyDispatcherMockState.deliver).toHaveBeenCalledWith(
      { text: "Reply from employee main" },
      expect.objectContaining({ kind: "final", stage: "final" }),
    );
    expect(replyDispatcherMockState.settle).toHaveBeenCalledTimes(1);
  });

  it("starts Codex device-code login when the employee container lacks OpenAI auth", async () => {
    gatewayRuntimeMockState.callGatewayFromCli.mockReset();
    gatewayRuntimeMockState.callGatewayFromCli
      .mockResolvedValueOnce({ runId: "run-unauthenticated" })
      .mockRejectedValueOnce(
        new Error(
          "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        ),
      );
    const cfg = createConfig();
    const runtime = { error: vi.fn() } as unknown as RuntimeEnv;
    const handler = createMSTeamsMessageHandler(createMSTeamsMessageHandlerDeps({ cfg, runtime }));

    await handler(createContext());

    expect(loginRuntimeMockState.runDeviceLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        agentId: "main",
        config: expect.objectContaining({
          agents: expect.objectContaining({
            entries: expect.objectContaining({
              main: expect.objectContaining({
                agentDir:
                  "/srv/openclaw/data/employee-agents/kkilgo/state/.openclaw/agents/main/agent",
              }),
            }),
          }),
        }),
      }),
    );
    expect(authProfilesMockState.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/srv/openclaw/data/employee-agents/kkilgo/state/.openclaw/agents/main/agent",
      provider: "openai",
      order: ["openai:test"],
    });
    expect(replyDispatcherMockState.deliver).toHaveBeenCalledWith(
      { text: "Open https://auth.openai.com/device and enter code ABCD-EFGH." },
      expect.objectContaining({ kind: "final", stage: "final" }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("starts Codex device-code login when agent.wait returns an OpenAI auth error status", async () => {
    gatewayRuntimeMockState.callGatewayFromCli.mockReset();
    gatewayRuntimeMockState.callGatewayFromCli
      .mockResolvedValueOnce({ runId: "run-unauthenticated" })
      .mockResolvedValueOnce({
        status: "error",
        error:
          "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      });
    const cfg = createConfig();
    const runtime = { error: vi.fn() } as unknown as RuntimeEnv;
    const handler = createMSTeamsMessageHandler(createMSTeamsMessageHandlerDeps({ cfg, runtime }));

    await handler(createContext());

    expect(loginRuntimeMockState.runDeviceLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        agentId: "main",
      }),
    );
    expect(authProfilesMockState.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/srv/openclaw/data/employee-agents/kkilgo/state/.openclaw/agents/main/agent",
      provider: "openai",
      order: ["openai:test"],
    });
    expect(replyDispatcherMockState.deliver).toHaveBeenCalledWith(
      { text: "Open https://auth.openai.com/device and enter code ABCD-EFGH." },
      expect.objectContaining({ kind: "final", stage: "final" }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not start Codex device-code login when the employee gateway rejects device pairing", async () => {
    gatewayRuntimeMockState.callGatewayFromCli.mockReset();
    gatewayRuntimeMockState.callGatewayFromCli.mockRejectedValueOnce(
      new Error("device pairing required (requestId: 608add51-977d-4413-9b73-d9a0a5ed0894)"),
    );
    const cfg = createConfig();
    const runtime = { error: vi.fn() } as unknown as RuntimeEnv;
    const handler = createMSTeamsMessageHandler(createMSTeamsMessageHandlerDeps({ cfg, runtime }));

    await expect(handler(createContext())).rejects.toThrow("device pairing required");

    expect(loginRuntimeMockState.runDeviceLoginFlow).not.toHaveBeenCalled();
    expect(replyDispatcherMockState.deliver).not.toHaveBeenCalledWith(
      { text: "Open https://auth.openai.com/device and enter code ABCD-EFGH." },
      expect.objectContaining({ kind: "final", stage: "final" }),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("msteams employee container dispatch failed"),
    );
  });
});
