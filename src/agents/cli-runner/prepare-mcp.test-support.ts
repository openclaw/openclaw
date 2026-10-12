import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  type createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";
import type { RunCliAgentParams } from "./types.js";

type McpProjectionParams = Parameters<typeof resolveMcpLoopbackScopedTools>[0];

/** Reuses the preparation suite's backend and lifecycle fixture for MCP admission proof. */
export function registerCliMcpPreparationTests({
  getFixture,
  createConfig,
}: {
  getFixture: () => ReturnType<typeof createCliRunnerPrepareFixture>;
  createConfig: () => OpenClawConfig;
}) {
  it("preserves already-admitted authority through MCP grant transfer", async () => {
    const explicitAgentId = "worker";
    const messageActionTurnCapability = "test-current-message-authority";
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const activateMcpLoopbackClientGrantCapture = vi.fn(() => ({
      captureNativeToolAuthority: vi.fn((_names: readonly string[] | null) => true),
    }));
    const deactivateMcpLoopbackClientGrantCapture = vi.fn(() => true);
    const transferMcpLoopbackClientGrant = vi.fn(() => true);
    const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
    const revokeMcpLoopbackClientGrant = vi.fn(() => true);
    const resolveMcpLoopbackScopedTools = vi.fn(() => ({
      agentId: "main",
      tools: [
        {
          name: "message",
          label: "Message",
          description: "Send a message",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      ],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      activateMcpLoopbackClientGrantCapture,
      deactivateMcpLoopbackClientGrantCapture,
      transferMcpLoopbackClientGrant,
      mintMcpLoopbackClientGrant,
      revokeMcpLoopbackClientGrant,
      resolveMcpLoopbackScopedTools,
    });
    setRawCliBackendForPrepareTest({
      id: "native-cli",
      pluginId: "native-plugin",
      bundleMcp: true,
      bundleMcpMode: "codex-config-overrides",
      config: {
        command: "native-cli",
        args: ["--print"],
        input: "arg",
        sessionMode: "existing",
      },
    });
    const context = await getFixture().prepare({
      sessionKey: "agent:main:telegram:group:chat123",
      runtimePolicySessionKey: "agent:worker:discord:default:direct:canonical-sender",
      agentId: explicitAgentId,
      provider: "native-cli",
      modelProvider: "anthropic",
      runId: "run-test-room-event-tools",
      messageActionTurnCapability,
      sessionEntry: {
        execHost: "node",
        execNode: "mac-a",
      } as never,
      execOverrides: {
        host: "node",
        security: "allowlist",
        ask: "always",
        node: "mac-b",
      },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
      trigger: "user",
      currentInboundEventKind: "room_event",
      messageChannel: "telegram",
      messageProvider: "discord",
      clientCaps: ["tool-events", "inline-widgets"],
      pinnedWidgetAuthoring: true,
      currentChannelId: "telegram:-100123:topic:42",
      currentThreadTs: "42",
      currentMessageId: "reply-message-1",
      currentInboundAudio: true,
      sourceReplyDeliveryMode: "message_tool_only",
      taskSuggestionDeliveryMode: "gateway",
      requireExplicitMessageTarget: true,
      approvalReviewerDeviceId: "reviewer-device",
      senderId: "canonical-sender",
      senderName: "Canonical Name",
      senderUsername: "canonical-user",
      senderE164: "+15551234567",
      groupId: "chat123",
      groupChannel: "ops",
      groupSpace: "workspace-a",
      spawnedBy: "agent:main:telegram:group:parent",
      channelContext: {
        sender: { id: "sender-1", displayName: "not-forwarded" },
        chat: { id: "chat-1", title: "not-forwarded" },
      },
    });

    expect(context.preparedBackend.env).toMatchObject({
      OPENCLAW_MCP_TOKEN: "loopback-token",
      OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
    });
    expect(JSON.stringify(context.preparedBackend.env)).not.toContain(messageActionTurnCapability);
    expect(mintMcpLoopbackClientGrant).toHaveBeenCalledWith({
      context: {
        sessionKey: "agent:main:telegram:group:chat123",
        runtimePolicySessionKey: "agent:worker:discord:default:direct:canonical-sender",
        runtimePolicyAgentId: "worker",
        agentId: "main",
        sessionId: "session-test",
        runId: "run-test-room-event-tools",
        workspaceDir: context.workspaceDir,
        modelProvider: "anthropic",
        modelId: "test-model",
        messageProvider: "telegram",
        clientCaps: ["tool-events", "inline-widgets"],
        pinnedWidgetAuthoring: true,
        currentChannelId: "telegram:-100123:topic:42",
        currentThreadTs: "42",
        currentMessageId: "reply-message-1",
        currentInboundAudio: true,
        accountId: undefined,
        inboundEventKind: "room_event",
        sourceReplyDeliveryMode: "message_tool_only",
        taskSuggestionDeliveryMode: "gateway",
        requireExplicitMessageTarget: true,
        senderIsOwner: false,
        nodeExecAllowed: true,
        execSession: {
          execHost: "node",
          execNode: "mac-a",
        },
        execOverrides: {
          host: "node",
          security: "allowlist",
          ask: "always",
          node: "mac-b",
        },
        bashElevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
          fullAccessAvailable: false,
          fullAccessBlockedReason: "runtime",
        },
        trigger: "user",
        approvalReviewerDeviceId: "reviewer-device",
        channelContext: {
          sender: { id: "canonical-sender" },
          chat: { id: "chat-1" },
        },
        senderName: "Canonical Name",
        senderUsername: "canonical-user",
        senderE164: "+15551234567",
        groupId: "chat123",
        groupChannel: "ops",
        groupSpace: "workspace-a",
        spawnedBy: "agent:main:telegram:group:parent",
      },
      runtimeOwnerToken: "loopback-owner-token",
      admittedRunContext: context.params.admittedRunContext,
      sessionEventSourcePolicy: {
        toolsAllow: undefined,
        settings: { permissionMode: undefined, toolOverrides: undefined },
      },
      messageActionTurnCapability,
      bindQuestionAnswerAuthority: expect.any(Function),
      toolAuth: {
        agentDir: expect.any(String),
        store: expect.objectContaining({ version: 1, profiles: {} }),
      },
    });
    expect(context.preparedBackend.mcpClientGrantCapture?.transportToken).toBe("loopback-token");
    context.preparedBackend.mcpClientGrantCapture?.adoptProcessToken("stable-loopback-token");
    const assertCaptureCurrent = () => {};
    context.preparedBackend.mcpClientGrantCapture?.activate("capture-test", assertCaptureCurrent);
    context.preparedBackend.mcpClientGrantCapture?.deactivate("capture-test");
    expect(transferMcpLoopbackClientGrant).toHaveBeenCalledExactlyOnceWith({
      sourceToken: "loopback-token",
      targetToken: "stable-loopback-token",
      runtimeOwnerToken: "loopback-owner-token",
    });
    expect(activateMcpLoopbackClientGrantCapture).toHaveBeenCalledExactlyOnceWith({
      token: "stable-loopback-token",
      runtimeOwnerToken: "loopback-owner-token",
      captureKey: "capture-test",
      assertCurrent: assertCaptureCurrent,
    });
    expect(deactivateMcpLoopbackClientGrantCapture).toHaveBeenCalledExactlyOnceWith({
      token: "stable-loopback-token",
      runtimeOwnerToken: "loopback-owner-token",
      captureKey: "capture-test",
    });
    context.preparedBackend.mcpClientGrantCapture?.revokeProcessToken();
    expect(revokeMcpLoopbackClientGrant).toHaveBeenCalledExactlyOnceWith("stable-loopback-token");
    expect(context.mcpDeliveryCapture).toBe(true);
    expect(context.systemPrompt).toContain(
      "`send`: `target` + `message`; target required this turn",
    );
    expect(context.systemPrompt).not.toContain("current source is default target");
    await context.preparedBackend.cleanup?.();
    expect(revokeMcpLoopbackClientGrant).toHaveBeenCalledTimes(2);
    expect(revokeMcpLoopbackClientGrant).toHaveBeenLastCalledWith("loopback-token");
  });

  it.each<{
    name: string;
    restricted?: boolean;
    managed: boolean;
    config?: OpenClawConfig;
    execOverrides?: RunCliAgentParams["execOverrides"];
  }>([
    { name: "local", managed: true },
    { name: "exact tools", restricted: true, managed: false },
    { name: "global node", config: { tools: { exec: { host: "node" } } }, managed: false },
    {
      name: "agent node",
      config: { agents: { entries: { main: { tools: { exec: { host: "node" } } } } } },
      managed: false,
    },
    { name: "run node", execOverrides: { host: "node" }, managed: false },
    {
      name: "run gateway overrides global node",
      config: { tools: { exec: { host: "node" } } },
      execOverrides: { host: "gateway" },
      managed: true,
    },
  ])("stamps managed shell into the final MCP grant for $name", async (entry) => {
    const { managed } = entry;
    const { restricted } = entry;
    const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
    const resolveMcpLoopbackScopedTools = vi.fn((scope: McpProjectionParams) => ({
      agentId: "main",
      tools: ["exec", "process", "message"]
        .filter((name) => !scope.context.toolsAllow || scope.context.toolsAllow.includes(name))
        .map((name) => ({ name })),
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: vi.fn(() => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      })),
      mintMcpLoopbackClientGrant,
      resolveMcpLoopbackScopedTools,
      resolveMcpLoopbackPolicyTools: resolveMcpLoopbackScopedTools,
    });
    setRawCliBackendForPrepareTest({
      id: "managed-cli",
      pluginId: "managed-plugin",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "selectable",
      hostOwnedTools: ["exec", "process"],
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs: ({ baseArgs }) => baseArgs,
      config: {
        command: "managed-cli",
        args: ["--print"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
      },
    });
    const context = await getFixture().prepare({
      provider: "managed-cli",
      agentId: "main",
      config: { ...createConfig(), ...entry.config },
      execOverrides: entry.execOverrides,
      ...(restricted ? { toolsAllow: ["message"] } : {}),
    });
    expect(context.hostOwnedTools).toEqual(managed ? ["exec", "process"] : undefined);
    expect(mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context.toolsAllow).toEqual(
      restricted ? ["message"] : managed ? ["exec", "process", "message"] : undefined,
    );
  });

  it("binds one live prepared admission to tool projection and the CLI MCP grant", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const bindMcpLoopbackClientGrantAdmission = vi.fn(() => true);
    const resolveMcpLoopbackScopedTools = vi.fn((_scope: McpProjectionParams) => ({
      agentId: "main",
      tools: [],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      resolveMcpLoopbackScopedTools,
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      bindMcpLoopbackClientGrantAdmission,
    });
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      {},
      "run-prepared-mcp",
      "main",
      "cli-mcp-projection",
    );
    try {
      const context = await getFixture().prepare({
        runId: "run-prepared-mcp",
        preparedRunAdmission,
        config: createConfig(),
      });

      try {
        expect(context.params.admittedRunContext.operationalRunInstance).toBe(
          preparedRunAdmission.operationalRunInstance,
        );
        expect(resolveMcpLoopbackScopedTools.mock.calls[0]?.[0].admittedRunContext).toBe(
          context.params.admittedRunContext,
        );
        expect(getAdmittedRunDelegatedAuthority(context.params.admittedRunContext)).toBeDefined();
        expect(bindMcpLoopbackClientGrantAdmission).toHaveBeenCalledExactlyOnceWith({
          token: "loopback-token",
          runtimeOwnerToken: "loopback-owner-token",
          admittedRunContext: context.params.admittedRunContext,
        });
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    } finally {
      preparedRunAdmission.close();
    }
  });
}

export function setRawCliBackendForPrepareTest(backend: CliBackendPlugin & { pluginId: string }) {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [backend],
  });
}
