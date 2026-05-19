import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginConversationBindingResolvedEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  codexSandboxPolicyForTurn,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
} from "./app-server/config.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoading,
} from "./app-server/dynamic-tool-profile.js";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
} from "./app-server/dynamic-tool-timeout.js";
import {
  createCodexDynamicToolBridge,
  type CodexDynamicToolBridge,
} from "./app-server/dynamic-tools.js";
import { readCodexDynamicToolCallParams } from "./app-server/protocol-validators.js";
import {
  type CodexDynamicToolSpec,
  type CodexServiceTier,
  type CodexThreadResumeResponse,
  type CodexThreadStartResponse,
  type CodexTurnStartResponse,
  type JsonValue,
} from "./app-server/protocol.js";
import {
  clearCodexAppServerBinding,
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerAuthProfileLookup,
} from "./app-server/session-binding.js";
import { getSharedCodexAppServerClient } from "./app-server/shared-client.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  codexDynamicToolsFingerprint,
} from "./app-server/thread-lifecycle.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  createCodexConversationBindingData,
  readCodexConversationBindingData,
  readCodexConversationBindingDataRecord,
  resolveCodexDefaultWorkspaceDir,
  type CodexAppServerConversationBindingData,
} from "./conversation-binding-data.js";
import { trackCodexConversationActiveTurn } from "./conversation-control.js";
import { createCodexConversationTurnCollector } from "./conversation-turn-collector.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";
import { resumeCodexCliSessionOnNode } from "./node-cli-sessions.js";

const DEFAULT_BOUND_TURN_TIMEOUT_MS = 20 * 60_000;

export {
  createCodexCliNodeConversationBindingData,
  readCodexConversationBindingData,
  resolveCodexDefaultWorkspaceDir,
} from "./conversation-binding-data.js";

type CodexConversationRunOptions = {
  pluginConfig?: unknown;
  config?: OpenClawConfig;
  timeoutMs?: number;
  resumeCodexCliSessionOnNode?: ResumeCodexCliSessionOnNodeFn;
};

type ResumeCodexCliSessionOnNodeFn = (
  params: Omit<Parameters<typeof resumeCodexCliSessionOnNode>[0], "runtime">,
) => ReturnType<typeof resumeCodexCliSessionOnNode>;

type CodexConversationStartParams = {
  pluginConfig?: unknown;
  config?: OpenClawConfig;
  sessionFile: string;
  workspaceDir?: string;
  agentDir?: string;
  threadId?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
};

type BoundTurnResult = {
  reply: ReplyPayload;
};

type CodexConversationGlobalState = {
  queues: Map<string, Promise<void>>;
};

const CODEX_CONVERSATION_GLOBAL_STATE = Symbol.for("openclaw.codex.conversationBinding");

function getGlobalState(): CodexConversationGlobalState {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_CONVERSATION_GLOBAL_STATE]?: CodexConversationGlobalState;
  };
  globalState[CODEX_CONVERSATION_GLOBAL_STATE] ??= { queues: new Map() };
  return globalState[CODEX_CONVERSATION_GLOBAL_STATE];
}

export async function startCodexConversationThread(
  params: CodexConversationStartParams,
): Promise<CodexAppServerConversationBindingData> {
  const workspaceDir =
    params.workspaceDir?.trim() || resolveCodexDefaultWorkspaceDir(params.pluginConfig);
  const agentDir = params.agentDir?.trim();
  const agentLookup = buildAgentLookup({ agentDir, config: params.config });
  const existingBinding = await readCodexAppServerBinding(params.sessionFile, {
    ...agentLookup,
  });
  const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
    authProfileId: params.authProfileId ?? existingBinding?.authProfileId,
    ...agentLookup,
  });
  if (params.threadId?.trim()) {
    await attachExistingThread({
      pluginConfig: params.pluginConfig,
      sessionFile: params.sessionFile,
      threadId: params.threadId.trim(),
      workspaceDir,
      ...(agentDir ? { agentDir } : {}),
      model: params.model,
      modelProvider: params.modelProvider,
      authProfileId,
      approvalPolicy: params.approvalPolicy,
      sandbox: params.sandbox,
      serviceTier: params.serviceTier,
      config: params.config,
    });
  } else {
    const dynamicToolBridge = await buildConversationDynamicToolBridge({
      pluginConfig: params.pluginConfig,
      config: params.config,
      workspaceDir,
      ...(agentDir ? { agentDir } : {}),
    });
    await createThread({
      pluginConfig: params.pluginConfig,
      sessionFile: params.sessionFile,
      workspaceDir,
      ...(agentDir ? { agentDir } : {}),
      model: params.model,
      modelProvider: params.modelProvider,
      authProfileId,
      approvalPolicy: params.approvalPolicy,
      sandbox: params.sandbox,
      serviceTier: params.serviceTier,
      config: params.config,
      dynamicTools: dynamicToolBridge.specs,
      dynamicToolsFingerprint: codexDynamicToolsFingerprint(dynamicToolBridge.specs),
    });
  }
  return createCodexConversationBindingData({
    sessionFile: params.sessionFile,
    workspaceDir,
    ...(agentDir ? { agentDir } : {}),
  });
}

export async function handleCodexConversationInboundClaim(
  event: PluginHookInboundClaimEvent,
  ctx: PluginHookInboundClaimContext,
  options: CodexConversationRunOptions = {},
): Promise<{ handled: boolean; reply?: ReplyPayload } | undefined> {
  const data = readCodexConversationBindingData(ctx.pluginBinding);
  if (!data) {
    return undefined;
  }
  if (event.commandAuthorized !== true) {
    return { handled: true };
  }
  const prompt = event.bodyForAgent?.trim() || event.content?.trim() || "";
  if (!prompt) {
    return { handled: true };
  }
  if (data.kind === "codex-cli-node-session") {
    const resume = options.resumeCodexCliSessionOnNode;
    if (!resume) {
      return {
        handled: true,
        reply: {
          text: "Codex CLI node binding is unavailable because Gateway node runtime is not attached.",
        },
      };
    }
    try {
      const result = await enqueueBoundTurn(`${data.nodeId}:${data.sessionId}`, async () => {
        const resumed = await resume({
          nodeId: data.nodeId,
          sessionId: data.sessionId,
          prompt,
          cwd: data.cwd,
          timeoutMs: options.timeoutMs,
        });
        return { reply: { text: resumed.text.trim() || "Codex completed without a text reply." } };
      });
      return { handled: true, reply: result.reply };
    } catch (error) {
      return {
        handled: true,
        reply: {
          text: `Codex CLI node turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}`,
        },
      };
    }
  }
  try {
    const result = await enqueueBoundTurn(data.sessionFile, () =>
      runBoundTurnWithMissingThreadRecovery({
        data,
        prompt,
        event,
        ctx,
        pluginConfig: options.pluginConfig,
        config: options.config,
        timeoutMs: options.timeoutMs,
      }),
    );
    return { handled: true, reply: result.reply };
  } catch (error) {
    return {
      handled: true,
      reply: {
        text: `Codex app-server turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}`,
      },
    };
  }
}

export async function handleCodexConversationBindingResolved(
  event: PluginConversationBindingResolvedEvent,
): Promise<void> {
  if (event.status !== "denied") {
    return;
  }
  const data = readCodexConversationBindingDataRecord(event.request.data ?? {});
  if (!data || data.kind !== "codex-app-server-session") {
    return;
  }
  await clearCodexAppServerBinding(data.sessionFile);
}

async function attachExistingThread(params: {
  pluginConfig?: unknown;
  sessionFile: string;
  threadId: string;
  workspaceDir: string;
  agentDir?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  config?: CodexAppServerAuthProfileLookup["config"];
  dynamicTools?: CodexDynamicToolSpec[];
  dynamicToolsFingerprint?: string;
}): Promise<void> {
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
  });
  const agentLookup = buildAgentLookup({ agentDir: params.agentDir, config: params.config });
  const modelProvider = resolveThreadRequestModelProvider({
    authProfileId: params.authProfileId,
    modelProvider: params.modelProvider,
    ...agentLookup,
  });
  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...agentLookup,
  });
  const response: CodexThreadResumeResponse = await client.request(
    CODEX_CONTROL_METHODS.resumeThread,
    {
      threadId: params.threadId,
      ...(params.model ? { model: params.model } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
      approvalsReviewer: runtime.approvalsReviewer,
      sandbox: params.sandbox ?? runtime.sandbox,
      ...((params.serviceTier ?? runtime.serviceTier)
        ? { serviceTier: params.serviceTier ?? runtime.serviceTier }
        : {}),
      persistExtendedHistory: true,
    },
    { timeoutMs: runtime.requestTimeoutMs },
  );
  const thread = response.thread;
  const runtimeApprovalPolicy =
    typeof runtime.approvalPolicy === "string" ? runtime.approvalPolicy : undefined;
  await writeCodexAppServerBinding(
    params.sessionFile,
    {
      threadId: thread.id,
      cwd: thread.cwd ?? params.workspaceDir,
      authProfileId: params.authProfileId,
      model: response.model ?? params.model,
      modelProvider: normalizeCodexAppServerBindingModelProvider({
        authProfileId: params.authProfileId,
        modelProvider: response.modelProvider ?? params.modelProvider,
        ...agentLookup,
      }),
      approvalPolicy: params.approvalPolicy ?? runtimeApprovalPolicy,
      sandbox: params.sandbox ?? runtime.sandbox,
      serviceTier: params.serviceTier ?? runtime.serviceTier,
      threadBindingOrigin: "explicit",
    },
    {
      ...agentLookup,
    },
  );
}

async function createThread(params: {
  pluginConfig?: unknown;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  config?: CodexAppServerAuthProfileLookup["config"];
  dynamicTools?: CodexDynamicToolSpec[];
  dynamicToolsFingerprint?: string;
}): Promise<void> {
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
  });
  const agentLookup = buildAgentLookup({ agentDir: params.agentDir, config: params.config });
  const modelProvider = resolveThreadRequestModelProvider({
    authProfileId: params.authProfileId,
    modelProvider: params.modelProvider,
    ...agentLookup,
  });
  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...agentLookup,
  });
  const response: CodexThreadStartResponse = await client.request(
    "thread/start",
    {
      cwd: params.workspaceDir,
      ...(params.model ? { model: params.model } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
      approvalsReviewer: runtime.approvalsReviewer,
      sandbox: params.sandbox ?? runtime.sandbox,
      ...((params.serviceTier ?? runtime.serviceTier)
        ? { serviceTier: params.serviceTier ?? runtime.serviceTier }
        : {}),
      developerInstructions:
        "This Codex thread is bound to an OpenClaw conversation. Answer normally; OpenClaw will deliver your final response back to the conversation.",
      dynamicTools: params.dynamicTools ?? [],
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    },
    { timeoutMs: runtime.requestTimeoutMs },
  );
  const runtimeApprovalPolicy =
    typeof runtime.approvalPolicy === "string" ? runtime.approvalPolicy : undefined;
  await writeCodexAppServerBinding(
    params.sessionFile,
    {
      threadId: response.thread.id,
      cwd: response.thread.cwd ?? params.workspaceDir,
      authProfileId: params.authProfileId,
      model: response.model ?? params.model,
      modelProvider: normalizeCodexAppServerBindingModelProvider({
        authProfileId: params.authProfileId,
        modelProvider: response.modelProvider ?? params.modelProvider,
        ...agentLookup,
      }),
      approvalPolicy: params.approvalPolicy ?? runtimeApprovalPolicy,
      sandbox: params.sandbox ?? runtime.sandbox,
      serviceTier: params.serviceTier ?? runtime.serviceTier,
      dynamicToolsFingerprint: params.dynamicToolsFingerprint ?? codexDynamicToolsFingerprint([]),
      threadBindingOrigin: "managed",
    },
    {
      ...agentLookup,
    },
  );
}

async function runBoundTurn(params: {
  data: CodexAppServerConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  ctx: PluginHookInboundClaimContext;
  pluginConfig?: unknown;
  config?: OpenClawConfig;
  timeoutMs?: number;
}): Promise<BoundTurnResult> {
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
  });
  const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir });
  let binding = await readCodexAppServerBinding(params.data.sessionFile, agentLookup);
  let threadId = binding?.threadId;
  if (!threadId) {
    throw new Error("bound Codex conversation has no thread binding");
  }
  if (!binding) {
    throw new Error("bound Codex conversation has no sidecar binding");
  }
  const turnAbortController = new AbortController();
  const toolBridge = await buildConversationDynamicToolBridge({
    pluginConfig: params.pluginConfig,
    config: params.config,
    workspaceDir: binding?.cwd || params.data.workspaceDir,
    ...(params.data.agentDir ? { agentDir: params.data.agentDir } : {}),
    event: params.event,
    ctx: params.ctx,
    signal: turnAbortController.signal,
  });
  const dynamicToolsFingerprint = codexDynamicToolsFingerprint(toolBridge.specs);
  // Older bound sidecars predate dynamic-tool fingerprints and origin markers.
  // Only known managed sidecars may be refreshed automatically; no-origin
  // legacy bindings might be explicit /codex resume selections and must keep
  // their selected thread until the user refreshes it deliberately.
  // Empty catalogs are recorded in place to avoid losing bound thread context.
  if (binding.dynamicToolsFingerprint === undefined && toolBridge.specs.length === 0) {
    await writeCodexAppServerBinding(
      params.data.sessionFile,
      {
        ...binding,
        dynamicToolsFingerprint,
      },
      agentLookup,
    );
    binding = await readCodexAppServerBinding(params.data.sessionFile, agentLookup);
    if (!binding) {
      throw new Error(
        "bound Codex conversation has no sidecar binding after dynamic tool fingerprint update",
      );
    }
  }
  const shouldRefreshDynamicTools =
    (binding.dynamicToolsFingerprint === undefined &&
      binding.threadBindingOrigin === "managed" &&
      toolBridge.specs.length > 0) ||
    (binding.dynamicToolsFingerprint !== undefined &&
      !areCodexDynamicToolFingerprintsCompatible({
        previous: binding.dynamicToolsFingerprint,
        next: dynamicToolsFingerprint,
      }));
  if (shouldRefreshDynamicTools) {
    await createThread({
      pluginConfig: params.pluginConfig,
      sessionFile: params.data.sessionFile,
      workspaceDir: binding.cwd || params.data.workspaceDir,
      ...(params.data.agentDir ? { agentDir: params.data.agentDir } : {}),
      model: binding.model,
      modelProvider: binding.modelProvider,
      authProfileId: binding.authProfileId,
      approvalPolicy: binding.approvalPolicy,
      sandbox: binding.sandbox,
      serviceTier: binding.serviceTier,
      config: params.config,
      dynamicTools: toolBridge.specs,
      dynamicToolsFingerprint,
    });
    binding = await readCodexAppServerBinding(params.data.sessionFile, agentLookup);
    threadId = binding?.threadId;
    if (!threadId) {
      throw new Error("bound Codex conversation has no thread binding after dynamic tool refresh");
    }
  }
  const activeBinding = binding;
  if (!activeBinding) {
    throw new Error("bound Codex conversation has no sidecar binding after dynamic tool refresh");
  }

  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: activeBinding.authProfileId,
    ...agentLookup,
  });
  const collector = createCodexConversationTurnCollector(threadId);
  let activeTurnId: string | undefined;
  const notificationCleanup = client.addNotificationHandler((notification) =>
    collector.handleNotification(notification),
  );
  const requestCleanup = client.addRequestHandler(
    async (request): Promise<JsonValue | undefined> => {
      if (request.method === "item/tool/call") {
        // Other bound turns may share this app-server client, so only dispatch
        // tool calls that target this turn's thread and active turn id.
        const call = readCodexDynamicToolCallParams(request.params);
        if (
          !call ||
          call.threadId !== threadId ||
          activeTurnId === undefined ||
          call.turnId !== activeTurnId
        ) {
          return undefined;
        }
        return handleDynamicToolCallWithTimeout({
          call,
          toolBridge,
          signal: turnAbortController.signal,
          timeoutMs: resolveDynamicToolCallTimeoutMs({
            call,
            config: params.config,
          }),
        });
      }
      if (
        request.method === "item/commandExecution/requestApproval" ||
        request.method === "item/fileChange/requestApproval"
      ) {
        return {
          decision: "decline",
          reason:
            "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.",
        };
      }
      if (request.method === "item/permissions/requestApproval") {
        return { permissions: {}, scope: "turn" };
      }
      if (request.method.includes("requestApproval")) {
        return {
          decision: "decline",
          reason:
            "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.",
        };
      }
      return undefined;
    },
  );
  try {
    const response: CodexTurnStartResponse = await client.request(
      "turn/start",
      {
        threadId,
        input: buildCodexConversationTurnInput({
          prompt: params.prompt,
          event: params.event,
        }),
        cwd: activeBinding.cwd || params.data.workspaceDir,
        approvalPolicy: activeBinding.approvalPolicy ?? runtime.approvalPolicy,
        approvalsReviewer: runtime.approvalsReviewer,
        sandboxPolicy: codexSandboxPolicyForTurn(
          activeBinding.sandbox ?? runtime.sandbox,
          activeBinding.cwd || params.data.workspaceDir,
        ),
        ...(activeBinding.model ? { model: activeBinding.model } : {}),
        ...((activeBinding.serviceTier ?? runtime.serviceTier)
          ? { serviceTier: activeBinding.serviceTier ?? runtime.serviceTier }
          : {}),
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
    const turnId = response.turn.id;
    activeTurnId = turnId;
    const activeCleanup = trackCodexConversationActiveTurn({
      sessionFile: params.data.sessionFile,
      threadId,
      turnId,
    });
    collector.setTurnId(turnId);
    const completion = await collector
      .wait({
        timeoutMs: params.timeoutMs ?? DEFAULT_BOUND_TURN_TIMEOUT_MS,
      })
      .finally(activeCleanup);
    const replyText = completion.replyText.trim();
    return {
      reply: {
        text: replyText || "Codex completed without a text reply.",
      },
    };
  } finally {
    turnAbortController.abort("codex conversation turn finished");
    notificationCleanup();
    requestCleanup();
  }
}

async function runBoundTurnWithMissingThreadRecovery(params: {
  data: CodexAppServerConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  ctx: PluginHookInboundClaimContext;
  pluginConfig?: unknown;
  config?: OpenClawConfig;
  timeoutMs?: number;
}): Promise<BoundTurnResult> {
  try {
    return await runBoundTurn(params);
  } catch (error) {
    if (!isCodexThreadNotFoundError(error)) {
      throw error;
    }
    const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir });
    const binding = await readCodexAppServerBinding(params.data.sessionFile, agentLookup);
    await startCodexConversationThread({
      pluginConfig: params.pluginConfig,
      sessionFile: params.data.sessionFile,
      workspaceDir: binding?.cwd || params.data.workspaceDir,
      ...agentLookup,
      model: binding?.model,
      modelProvider: binding?.modelProvider,
      authProfileId: binding?.authProfileId,
      approvalPolicy: binding?.approvalPolicy,
      sandbox: binding?.sandbox,
      serviceTier: binding?.serviceTier,
      config: params.config,
    });
    return await runBoundTurn(params);
  }
}

async function buildConversationDynamicToolBridge(params: {
  pluginConfig?: unknown;
  config?: OpenClawConfig;
  workspaceDir: string;
  agentDir?: string;
  event?: PluginHookInboundClaimEvent;
  ctx?: PluginHookInboundClaimContext;
  signal?: AbortSignal;
}): Promise<CodexDynamicToolBridge> {
  const signal = params.signal ?? new AbortController().signal;
  const codexConfig = readCodexPluginConfig(params.pluginConfig);
  const { createOpenClawCodingTools } = await import("openclaw/plugin-sdk/agent-harness");
  // The bound conversation is the security boundary for tool replies and
  // session state. ctx.channelId is only the provider id (for example,
  // "telegram"), so it must never be used as a conversation fallback.
  const boundConversationId =
    params.ctx?.pluginBinding?.conversationId ??
    params.ctx?.conversationId ??
    params.event?.conversationId;
  const allTools = createOpenClawCodingTools({
    includeCoreTools: false,
    config: params.config,
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    workspaceDir: params.workspaceDir,
    spawnWorkspaceDir: params.workspaceDir,
    sessionId: boundConversationId,
    sessionKey: params.ctx?.sessionKey,
    runId: params.ctx?.runId,
    messageProvider: params.event?.channel,
    agentAccountId: params.event?.accountId,
    messageTo: boundConversationId,
    messageThreadId: params.event?.threadId,
    currentChannelId: boundConversationId,
    currentMessageId: params.event?.messageId,
    senderId: params.event?.senderId,
    senderName: params.event?.senderName,
    senderUsername: params.event?.senderUsername,
    allowGatewaySubagentBinding: true,
    abortSignal: signal,
  });
  const tools = filterCodexDynamicTools(allTools, codexConfig);
  return createCodexDynamicToolBridge({
    tools,
    signal,
    hookContext: {
      config: params.config,
      sessionId: boundConversationId,
      sessionKey: params.ctx?.sessionKey,
      runId: params.ctx?.runId,
      channelId: boundConversationId,
    },
    loading: resolveCodexDynamicToolsLoading(codexConfig),
  });
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  return /\bthread not found:/iu.test(formatErrorMessage(error));
}

function enqueueBoundTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
  const state = getGlobalState();
  const previous = state.queues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const queued = next.then(
    () => undefined,
    () => undefined,
  );
  state.queues.set(key, queued);
  void next
    .finally(() => {
      if (state.queues.get(key) === queued) {
        state.queues.delete(key);
      }
    })
    .catch(() => undefined);
  return next;
}

function resolveThreadRequestModelProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider || modelProvider.toLowerCase() === "codex") {
    return undefined;
  }
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    (modelProvider.toLowerCase() === "openai" || modelProvider.toLowerCase() === "openai-codex")
  ) {
    return undefined;
  }
  return modelProvider.toLowerCase() === "openai-codex" ? "openai" : modelProvider;
}

function buildAgentLookup(params: {
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): Pick<CodexAppServerAuthProfileLookup, "agentDir" | "config"> {
  const agentDir = params.agentDir?.trim();
  return {
    ...(agentDir ? { agentDir } : {}),
    ...(params.config ? { config: params.config } : {}),
  };
}
