import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import type { MemoryAudience } from "../../plugins/memory-provider-types.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  type createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { resolveCliChildEnv } from "./execution-env.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";
import type { RunCliAgentParams } from "./types.js";

type McpProjectionParams = Parameters<typeof resolveMcpLoopbackScopedTools>[0];
type McpRunOverrides = Pick<RunCliAgentParams, "config" | "execOverrides" | "toolsAllow">;
const nodeConfig = (): OpenClawConfig => ({ tools: { exec: { host: "node" } } });

const runtimeOwnerToken = "loopback-owner-token";
const token = "loopback-token";
const processToken = "stable-loopback-token";
const loopbackRuntime = () => ({
  port: 31783,
  ownerToken: runtimeOwnerToken,
  nonOwnerToken: "loopback-non-owner-token",
});

export function createCliMcpTool(name: string, label: string, description: string) {
  return {
    name,
    label,
    description,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  };
}

export function mockCliMcpPreparation(overrides: Record<string, unknown> = {}) {
  const mint = vi.fn(createTestMcpLoopbackClientGrant);
  const revoke = vi.fn(() => true);
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => undefined,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    getActiveMcpLoopbackRuntime: loopbackRuntime,
    createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
    mintMcpLoopbackClientGrant: mint,
    bindMcpLoopbackClientGrantAdmission: () => true,
    revokeMcpLoopbackClientGrant: revoke,
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    getCliLiveSessionGeneration: () => undefined,
    loadManifestModelCatalog: () => [],
    ...overrides,
  });
  return { mint, revoke };
}

export function registerCliMcpPreparationTests({
  getFixture,
  createConfig,
}: {
  getFixture: () => ReturnType<typeof createCliRunnerPrepareFixture>;
  createConfig: () => OpenClawConfig;
}) {
  it("keeps prepared Gemini runtime settings in native-only child environments", async () => {
    const fixture = getFixture();
    const home = path.join(fixture.session.dir, "restricted-home");
    setRawCliBackendForPrepareTest({
      id: "google-gemini-cli",
      pluginId: "google",
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
      prepareExecution: async (ctx) => ({
        env: { ...ctx.env, GEMINI_CLI_HOME: home },
        clearEnv: ["GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_HOME"],
        toolAvailabilityEnforced: true,
      }),
      config: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({ getActiveMcpLoopbackRuntime: vi.fn(loopbackRuntime) });
    const context = await fixture.prepare({
      sessionKey: "agent:main:main",
      provider: "google-gemini-cli",
      model: "gemini-2.5-pro",
      nativeAuthOnly: true,
      config: {},
    });
    try {
      const { env } = resolveCliChildEnv(context.preparedBackend, context.params);
      expect(env.GEMINI_CLI_HOME).toBe(home);
      const settingsPath = expectDefined(
        env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
        "Gemini system settings path",
      );
      expect(settingsPath).toBe(context.preparedBackend.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      expect(settings.mcp.allowed).toEqual(["openclaw"]);
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it("preserves already-admitted authority through MCP grant transfer", async () => {
    const messageActionTurnCapability = "test-current-message-authority";
    const activateCapture = vi.fn(() => ({ captureNativeToolAuthority: () => true }));
    const deactivateCapture = vi.fn(() => true);
    const transferGrant = vi.fn(() => true);
    const { mint, revoke } = mockCliMcpPreparation({
      activateMcpLoopbackClientGrantCapture: activateCapture,
      deactivateMcpLoopbackClientGrantCapture: deactivateCapture,
      transferMcpLoopbackClientGrant: transferGrant,
      resolveMcpLoopbackScopedTools: () => ({
        agentId: "main",
        tools: [createCliMcpTool("message", "Message", "Send a message")],
      }),
    });
    setRawCliBackendForPrepareTest({
      id: "native-cli",
      pluginId: "native-plugin",
      bundleMcp: true,
      bundleMcpMode: "codex-config-overrides",
      config: { command: "native-cli", args: ["--print"], input: "arg", sessionMode: "existing" },
    });
    const sessionKey = "agent:main:telegram:group:chat123";
    const senderId = "canonical-sender";
    const sender = {
      senderName: "Canonical Name",
      senderUsername: "canonical-user",
      senderE164: "+15551234567",
      groupId: "chat123",
      groupChannel: "ops",
      groupSpace: "workspace-a",
    };
    const sessionEntry = { execHost: "node", execNode: "mac-a" } as const;
    const forwarded = {
      runtimePolicySessionKey: "agent:worker:discord:default:direct:canonical-sender",
      modelProvider: "anthropic",
      runId: "run-test-room-event-tools",
      execOverrides: { host: "node", security: "allowlist", ask: "always", node: "mac-b" },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
      trigger: "user",
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
      spawnedBy: "agent:main:telegram:group:parent",
    } satisfies Partial<RunCliAgentParams>;
    const { preparedBackend, params, workspaceDir, mcpDeliveryCapture, systemPrompt } =
      await getFixture().prepare({
        ...forwarded,
        ...sender,
        sessionKey,
        agentId: "worker",
        provider: "native-cli",
        messageActionTurnCapability,
        sessionEntry: sessionEntry as never,
        currentInboundEventKind: "room_event",
        messageChannel: "telegram",
        messageProvider: "discord",
        senderId,
        channelContext: {
          sender: { id: "sender-1", displayName: "not-forwarded" },
          chat: { id: "chat-1", title: "not-forwarded" },
        },
      });

    expect(preparedBackend.env).toMatchObject({
      OPENCLAW_MCP_TOKEN: token,
      OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
    });
    expect(JSON.stringify(preparedBackend.env)).not.toContain(messageActionTurnCapability);
    const settings = { permissionMode: undefined, toolOverrides: undefined };
    expect(mint).toHaveBeenCalledWith({
      context: {
        ...forwarded,
        ...sender,
        sessionKey,
        requesterOrigin: { ...sender, sessionKey, messageProvider: "discord", senderId },
        runtimePolicyAgentId: "worker",
        agentId: "main",
        sessionId: "session-test",
        workspaceDir,
        modelId: "test-model",
        messageProvider: "telegram",
        accountId: undefined,
        inboundEventKind: "room_event",
        senderIsOwner: false,
        nodeExecAllowed: true,
        execSession: sessionEntry,
        channelContext: { sender: { id: senderId }, chat: { id: "chat-1" } },
      },
      runtimeOwnerToken,
      admittedRunContext: params.admittedRunContext,
      toolPolicyConfig: {},
      sessionEventSourcePolicy: { toolsAllow: undefined, settings },
      messageActionTurnCapability,
      bindQuestionAnswerAuthority: expect.any(Function),
      toolAuth: {
        agentDir: expect.any(String),
        store: expect.objectContaining({ version: 1, profiles: {} }),
      },
    });
    const capture = preparedBackend.mcpClientGrantCapture;
    expect(capture?.transportToken).toBe(token);
    capture?.adoptProcessToken(processToken);
    const assertCurrent = () => {};
    capture?.activate("capture-test", assertCurrent);
    capture?.deactivate("capture-test");
    const transfer = { sourceToken: token, targetToken: processToken, runtimeOwnerToken };
    expect(transferGrant.mock.calls).toEqual([[transfer]]);
    const processCapture = { token: processToken, runtimeOwnerToken, captureKey: "capture-test" };
    expect(activateCapture.mock.calls).toEqual([[{ ...processCapture, assertCurrent }]]);
    expect(deactivateCapture.mock.calls).toEqual([[processCapture]]);
    capture?.revokeProcessToken();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(processToken);
    expect(mcpDeliveryCapture).toBe(true);
    expect(systemPrompt).toContain("`send`: `target` + `message`; target required this turn");
    expect(systemPrompt).not.toContain("current source is default target");
    await preparedBackend.cleanup?.();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenLastCalledWith(token);
  });

  it.each<[name: string, managed: boolean, overrides?: McpRunOverrides]>([
    ["local", true],
    ["exact tools", false, { toolsAllow: ["message"] }],
    ["global node", false, { config: nodeConfig() }],
    [
      "agent node",
      false,
      { config: { agents: { entries: { main: { tools: { exec: { host: "node" } } } } } } },
    ],
    ["run node", false, { execOverrides: { host: "node" } }],
    ["gateway over node", true, { config: nodeConfig(), execOverrides: { host: "gateway" } }],
  ])(
    "stamps managed shell into the final MCP grant for %s",
    async (_name, managed, overrides = {}) => {
      const projectTools = (scope: McpProjectionParams) => ({
        agentId: "main",
        tools: ["exec", "process", "message"]
          .filter((name) => !scope.context.toolsAllow || scope.context.toolsAllow.includes(name))
          .map((name) => ({ name })),
      });
      const { mint } = mockCliMcpPreparation({
        resolveMcpLoopbackScopedTools: projectTools,
        resolveMcpLoopbackPolicyTools: projectTools,
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
        config: createJsonlStdinBackendConfig("managed-cli"),
      });
      const context = await getFixture().prepare({
        provider: "managed-cli",
        agentId: "main",
        ...overrides,
        config: { ...createConfig(), ...overrides.config },
      });
      expect(context.hostOwnedTools).toEqual(managed ? ["exec", "process"] : undefined);
      expect(mint.mock.calls[0]?.[0]?.context.toolsAllow).toEqual(
        overrides.toolsAllow ?? (managed ? ["exec", "process", "message"] : undefined),
      );
    },
  );

  it("hands the admitted turn's memory audience to the CLI grant and releases it at run end", async () => {
    const sessionKey = "agent:main:telegram:direct:owner";
    const memoryAudience: MemoryAudience = Object.freeze({
      kind: "owner-private",
      agentId: "main",
    });
    const release = vi.fn();
    const resolveAudience = vi.fn(async () => ({ memoryAudience, release }));
    const { mint, revoke } = mockCliMcpPreparation({
      resolveCliMcpMemoryAudience: resolveAudience,
    });
    const sessionEntry = { sessionId: "session-test", chatType: "direct", updatedAt: 1 } as const;

    const context = await getFixture().prepare({
      sessionKey,
      senderIsOwner: true,
      sessionEntry,
      config: createConfig(),
    });

    expect(resolveAudience).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionEntry, senderIsOwner: true }),
      { agentId: "main", sessionKey },
    );
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryAudience,
        context: expect.not.objectContaining({ memoryAudience: expect.anything() }),
      }),
    );
    expect(release).not.toHaveBeenCalled();
    await context.preparedBackend.cleanup?.();
    expect(revoke).toHaveBeenCalledWith(token);
    expect(release).toHaveBeenCalledOnce();
  });

  it("binds one live prepared admission to tool projection and the CLI MCP grant", async () => {
    const bindAdmission = vi.fn(() => true);
    const projectTools = vi.fn((_scope: McpProjectionParams) => ({ agentId: "main", tools: [] }));
    mockCliMcpPreparation({
      resolveMcpLoopbackScopedTools: projectTools,
      bindMcpLoopbackClientGrantAdmission: bindAdmission,
    });
    const admission = prepareSystemAgentRunAdmission(
      {},
      "run-prepared-mcp",
      "main",
      "cli-mcp-projection",
    );
    try {
      const context = await getFixture().prepare({
        runId: "run-prepared-mcp",
        preparedRunAdmission: admission,
        config: createConfig(),
      });

      try {
        const { admittedRunContext } = context.params;
        expect(admittedRunContext.operationalRunInstance).toBe(admission.operationalRunInstance);
        expect(projectTools.mock.calls[0]?.[0].admittedRunContext).toBe(admittedRunContext);
        expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeDefined();
        expect(bindAdmission.mock.calls).toEqual([
          [{ token, runtimeOwnerToken, admittedRunContext }],
        ]);
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    } finally {
      admission.close();
    }
  });
}

export function setRawCliBackendForPrepareTest(backend: CliBackendPlugin & { pluginId: string }) {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [backend],
  });
}

export function createJsonlStdinBackendConfig(command: string): CliBackendPlugin["config"] {
  return { command, args: ["--print"], output: "jsonl", input: "stdin", sessionMode: "existing" };
}

export function setCliBackendForPrepareTest(
  params: {
    authEpochMode?: CliBackendPlugin["authEpochMode"];
    autoSelectAuthProfile?: boolean;
    bundleMcp?: boolean;
    command?: string;
    id?: string;
    liveSession?: boolean;
    modelAliases?: Record<string, string>;
    modelProvider?: string;
    pluginId?: string;
    prepareExecution?: CliBackendPlugin["prepareExecution"];
    sessionMode?: "always" | "existing" | "none";
    reseedFromRawTranscriptWhenUncompacted?: boolean;
  } = {},
) {
  const id = params.id ?? "claude-cli";
  // Keep preparation behind the same runtime resolver seam that production
  // uses; direct backend constants would bypass provider ownership.
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        id,
        pluginId: params.pluginId ?? "anthropic",
        modelProvider: params.modelProvider ?? "anthropic",
        bundleMcp: params.bundleMcp ?? false,
        ...(params.authEpochMode ? { authEpochMode: params.authEpochMode } : {}),
        ...(params.bundleMcp ? { bundleMcpMode: "claude-config-file" as const } : {}),
        ...(params.autoSelectAuthProfile !== undefined
          ? { autoSelectAuthProfile: params.autoSelectAuthProfile }
          : {}),
        ...(params.prepareExecution ? { prepareExecution: params.prepareExecution } : {}),
        config: {
          ...createJsonlStdinBackendConfig(params.command ?? "claude"),
          systemPromptFileArg: "--append-system-prompt-file",
          systemPromptWhen: "always",
          resumeArgs: ["--resume", "{sessionId}"],
          sessionMode: params.sessionMode ?? "existing",
          ...(params.modelAliases ? { modelAliases: params.modelAliases } : {}),
          ...(params.liveSession ? { liveSession: "claude-stdio" as const } : {}),
          ...(params.reseedFromRawTranscriptWhenUncompacted
            ? { reseedFromRawTranscriptWhenUncompacted: true }
            : {}),
        },
      },
    ],
  });
}
