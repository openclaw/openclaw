import {
  embeddedAgentLog,
  formatErrorMessage,
  resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveSessionAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import type {
  PluginConversationBindingResolvedEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { CodexAppServerServerRequestError } from "./app-server/client.js";
import {
  codexSandboxPolicyForTurn,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
  type OpenClawExecPolicyForCodexAppServer,
} from "./app-server/config.js";
import type {
  CodexServiceTier,
  CodexTurnInterruptParams,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
  JsonValue,
} from "./app-server/protocol.js";
import { resolveCodexAppServerConversationReasoningEffort } from "./app-server/reasoning-defaults.js";
import {
  resolveCodexNativeExecutionBlock,
  resolveCodexNativeSandboxBlock,
} from "./app-server/sandbox-guard.js";
import {
  clearCodexAppServerBinding,
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerCollaborationMode,
  type CodexAppServerConversationReasoningDefaults,
  type CodexAppServerReasoningEffort,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveReasoningEffort,
} from "./app-server/thread-lifecycle.js";
import { readUserInputParams } from "./app-server/user-input-bridge.js";
import { buildUserInputResponse, emptyUserInputResponse } from "./app-server/user-input-shared.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  createCodexConversationBindingData,
  readCodexConversationBindingData,
  readCodexConversationBindingDataRecord,
  resolveCodexDefaultWorkspaceDir,
  type CodexAppServerConversationBindingData,
} from "./conversation-binding-data.js";
import {
  answerCodexUserInputFreeform,
  buildCodexPlanDecisionReply,
  cancelCodexUserInput,
  CODEX_PENDING_CONTROL_TTL_MS,
  createCodexUserInputPromptControl,
  hasCodexProposedPlan,
} from "./conversation-chat-controls.js";
import { trackCodexConversationActiveTurn } from "./conversation-control.js";
import { createCodexConversationTurnCollector } from "./conversation-turn-collector.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";
import { resumeCodexCliSessionOnNode } from "./node-cli-sessions.js";

const DEFAULT_BOUND_TURN_TIMEOUT_MS = 20 * 60_000;
const MISSING_PROPOSED_PLAN_REFERENCE_RE =
  /\b(?:previous|above|earlier)\b[\s\S]{0,120}<proposed_plan>|<proposed_plan>[\s\S]{0,120}\b(?:previous|above|earlier)\b/iu;
const NATIVE_CONVERSATION_INTERACTIVE_APPROVALS_UNAVAILABLE =
  "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.";
const CODEX_USER_INPUT_TIMEOUT_REPLY =
  "Codex input request timed out before an answer was sent. I stopped the Codex turn so it will not continue with a default answer.";
const CODEX_USER_INPUT_TIMEOUT_INTERRUPT_FAILED_REPLY =
  "Codex input request timed out before an answer was sent, but OpenClaw could not stop the Codex turn. Use `/codex stop` if it is still running.";
const CODEX_TURN_TRANSITION_SERVER_REQUEST_ERROR = {
  code: -1,
  message: "client request resolved because the turn state was changed",
  data: { reason: "turnTransition" },
} satisfies ConstructorParameters<typeof CodexAppServerServerRequestError>[0];

export {
  createCodexConversationBindingData,
  createCodexCliNodeConversationBindingData,
  readCodexConversationBindingData,
  resolveCodexDefaultWorkspaceDir,
} from "./conversation-binding-data.js";

type CodexConversationRunOptions = {
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  timeoutMs?: number;
  resumeCodexCliSessionOnNode?: ResumeCodexCliSessionOnNodeFn;
  sendProgressReply?: SendCodexConversationProgressReply;
};

export type SendCodexConversationProgressReply = (params: {
  event: PluginHookInboundClaimEvent;
  ctx: PluginHookInboundClaimContext;
  payload: ReplyPayload;
}) => Promise<void>;

type ResumeCodexCliSessionOnNodeFn = (
  params: Omit<Parameters<typeof resumeCodexCliSessionOnNode>[0], "runtime">,
) => ReturnType<typeof resumeCodexCliSessionOnNode>;

type CodexConversationStartParams = {
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  sessionFile: string;
  workspaceDir?: string;
  agentDir?: string;
  sessionKey?: string;
  threadId?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  liveProgress?: boolean;
  collaborationMode?: CodexAppServerCollaborationMode;
  reasoningEffort?: CodexAppServerReasoningEffort;
  reasoningEffortDefaults?: CodexAppServerConversationReasoningDefaults;
};

type BoundTurnResult = {
  reply: ReplyPayload;
};

type CodexConversationConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];

type CodexConversationGlobalState = {
  queues: Map<string, Promise<void>>;
};

async function resolveConversationAppServerRuntime(params: {
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir: string;
}): Promise<{
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
  runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
}> {
  const execPolicy = resolveConversationExecPolicy({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const sandboxForPolicy =
    execPolicy.touched && execPolicy.security === "full" && execPolicy.ask !== "off"
      ? await resolveSandboxContext({
          config: params.config,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
        })
      : undefined;
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
    execPolicy,
    openClawSandboxActive: Boolean(sandboxForPolicy?.enabled),
  });
  assertNativeConversationApprovalPolicySupported({ execPolicy, runtime });
  return { execPolicy, runtime };
}

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
      liveProgress: params.liveProgress ?? existingBinding?.liveProgress,
      collaborationMode: params.collaborationMode ?? existingBinding?.collaborationMode,
      reasoningEffort: params.reasoningEffort ?? existingBinding?.reasoningEffort,
      reasoningEffortDefaults:
        params.reasoningEffortDefaults ?? existingBinding?.reasoningEffortDefaults,
      config: params.config,
      sessionKey: params.sessionKey,
    });
  } else {
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
      liveProgress: params.liveProgress ?? existingBinding?.liveProgress,
      collaborationMode: params.collaborationMode ?? existingBinding?.collaborationMode,
      reasoningEffort: params.reasoningEffort ?? existingBinding?.reasoningEffort,
      reasoningEffortDefaults:
        params.reasoningEffortDefaults ?? existingBinding?.reasoningEffortDefaults,
      config: params.config,
      sessionKey: params.sessionKey,
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
  const prompt = event.bodyForAgent?.trim() || event.content?.trim() || "";
  if (!prompt) {
    return { handled: true };
  }
  if (data.kind === "codex-app-server-session") {
    const inputResult = answerCodexUserInputFreeform({
      answerText: prompt,
      ctx: {
        channel: event.channel,
        senderId: event.senderId ?? ctx.senderId,
        accountId: event.accountId ?? ctx.accountId,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
        messageThreadId: event.threadId,
      },
      sessionFile: data.sessionFile,
    });
    if (inputResult.matched) {
      return { handled: true, reply: { text: inputResult.message } };
    }
  }
  if (event.commandAuthorized !== true) {
    // Diagnostic: only log when the inbound_claim is about to silently
    // drop a typed freeform reply to a pending Codex request_user_input
    // control. The most likely cause is a scope mismatch (channel /
    // senderId / sessionKey / messageThreadId differ between the
    // pending that was queued by sendProgressReply and the inbound
    // ctx for the typed reply). Gated to the silent-fallthrough case
    // to avoid logging the content of authorized conversation
    // prompts (which can include secrets or private data).
    embeddedAgentLog.warn("codex bound conversation typed freeform reply did not match a pending input", {
      inbound: {
        channel: event.channel,
        senderId: event.senderId ?? ctx.senderId,
        accountId: event.accountId ?? ctx.accountId,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
        messageThreadId: event.threadId,
        commandAuthorized: event.commandAuthorized,
      },
      binding: {
        kind: data.kind,
        sessionFile: data.kind === "codex-app-server-session" ? data.sessionFile : undefined,
      },
    });
    return { handled: true };
  }
  const nativeExecutionBlock =
    data.kind === "codex-cli-node-session"
      ? resolveCodexNativeSandboxBlock({
          config: options.config,
          sessionKey: event.sessionKey ?? ctx.sessionKey,
          surface: "Codex CLI node conversation binding",
        })
      : resolveCodexNativeExecutionBlock({
          config: options.config,
          sessionKey: event.sessionKey ?? ctx.sessionKey,
          surface: "Codex app-server conversation binding",
        });
  if (nativeExecutionBlock) {
    return { handled: true, reply: { text: nativeExecutionBlock } };
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
    const result = await runCodexBoundConversationPrompt({
      data,
      prompt,
      event,
      ctx,
      config: options.config,
      sessionKey: event.sessionKey ?? ctx.sessionKey,
      pluginConfig: options.pluginConfig,
      timeoutMs: options.timeoutMs,
      sendProgressReply: options.sendProgressReply,
    });
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

export async function runCodexBoundConversationPrompt(params: {
  data: CodexAppServerConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  ctx: PluginHookInboundClaimContext;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  sessionKey?: string;
  timeoutMs?: number;
  sendProgressReply?: SendCodexConversationProgressReply;
}): Promise<BoundTurnResult> {
  return await enqueueBoundTurn(params.data.sessionFile, () =>
    runBoundTurnWithMissingThreadRecovery(params),
  );
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

type CodexThreadBindingParams = {
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
  liveProgress?: boolean;
  collaborationMode?: CodexAppServerCollaborationMode;
  reasoningEffort?: CodexAppServerReasoningEffort;
  reasoningEffortDefaults?: CodexAppServerConversationReasoningDefaults;
  config?: CodexAppServerAuthProfileLookup["config"];
  agentId?: string;
  sessionKey?: string;
};

type ConversationAppServerRuntime = Awaited<ReturnType<typeof resolveConversationAppServerRuntime>>;

type CodexThreadBindingRuntime = ConversationAppServerRuntime & {
  agentLookup: ReturnType<typeof buildAgentLookup>;
  client: Awaited<ReturnType<typeof getLeasedSharedCodexAppServerClient>>;
  modelProvider?: string;
};

async function resolveThreadBindingRuntime(
  params: CodexThreadBindingParams,
): Promise<CodexThreadBindingRuntime> {
  const { execPolicy, runtime } = await resolveConversationAppServerRuntime({
    pluginConfig: params.pluginConfig,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  const agentLookup = buildAgentLookup({ agentDir: params.agentDir, config: params.config });
  const modelProvider = resolveThreadRequestModelProvider({
    authProfileId: params.authProfileId,
    modelProvider: params.modelProvider,
    ...agentLookup,
  });
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...agentLookup,
  });
  return { execPolicy, runtime, agentLookup, modelProvider, client };
}

function buildThreadRequestRuntimeOptions(
  params: CodexThreadBindingParams,
  resolved: CodexThreadBindingRuntime,
): {
  approvalPolicy: ConversationAppServerRuntime["runtime"]["approvalPolicy"];
  approvalsReviewer: ConversationAppServerRuntime["runtime"]["approvalsReviewer"];
  sandbox: ConversationAppServerRuntime["runtime"]["sandbox"];
  serviceTier?: CodexServiceTier;
} {
  const serviceTier = params.serviceTier ?? resolved.runtime.serviceTier;
  return {
    approvalPolicy: resolved.execPolicy?.touched
      ? resolved.runtime.approvalPolicy
      : (params.approvalPolicy ?? resolved.runtime.approvalPolicy),
    approvalsReviewer: resolved.runtime.approvalsReviewer,
    sandbox: resolved.execPolicy?.touched
      ? resolved.runtime.sandbox
      : (params.sandbox ?? resolved.runtime.sandbox),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

async function writeThreadBindingFromResponse(
  params: CodexThreadBindingParams,
  resolved: CodexThreadBindingRuntime,
  response: CodexThreadResumeResponse | CodexThreadStartResponse,
): Promise<void> {
  const runtimeApprovalPolicy =
    typeof resolved.runtime.approvalPolicy === "string"
      ? resolved.runtime.approvalPolicy
      : undefined;
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
        ...resolved.agentLookup,
      }),
      collaborationMode: params.collaborationMode,
      reasoningEffort: params.reasoningEffort,
      reasoningEffortDefaults: params.reasoningEffortDefaults,
      approvalPolicy: resolved.execPolicy?.touched
        ? runtimeApprovalPolicy
        : (params.approvalPolicy ?? runtimeApprovalPolicy),
      sandbox: resolved.execPolicy?.touched
        ? resolved.runtime.sandbox
        : (params.sandbox ?? resolved.runtime.sandbox),
      serviceTier: params.serviceTier ?? resolved.runtime.serviceTier,
      liveProgress: params.liveProgress,
    },
    {
      ...resolved.agentLookup,
    },
  );
}

async function attachExistingThread(
  params: CodexThreadBindingParams & {
    threadId: string;
  },
): Promise<void> {
  const resolved = await resolveThreadBindingRuntime(params);
  try {
    const response: CodexThreadResumeResponse = await resolved.client.request(
      CODEX_CONTROL_METHODS.resumeThread,
      {
        threadId: params.threadId,
        ...(params.model ? { model: params.model } : {}),
        ...(resolved.modelProvider ? { modelProvider: resolved.modelProvider } : {}),
        personality: CODEX_NATIVE_PERSONALITY_NONE,
        ...buildThreadRequestRuntimeOptions(params, resolved),
        persistExtendedHistory: true,
      },
      { timeoutMs: resolved.runtime.requestTimeoutMs },
    );
    await writeThreadBindingFromResponse(params, resolved, response);
  } finally {
    releaseLeasedSharedCodexAppServerClient(resolved.client);
  }
}

async function createThread(params: CodexThreadBindingParams): Promise<void> {
  const resolved = await resolveThreadBindingRuntime(params);
  try {
    const response: CodexThreadStartResponse = await resolved.client.request(
      "thread/start",
      {
        cwd: params.workspaceDir,
        ...(params.model ? { model: params.model } : {}),
        ...(resolved.modelProvider ? { modelProvider: resolved.modelProvider } : {}),
        personality: CODEX_NATIVE_PERSONALITY_NONE,
        ...buildThreadRequestRuntimeOptions(params, resolved),
        developerInstructions:
          "This Codex thread is bound to an OpenClaw conversation. Answer normally; OpenClaw will deliver your final response back to the conversation.",
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      },
      { timeoutMs: resolved.runtime.requestTimeoutMs },
    );
    await writeThreadBindingFromResponse(params, resolved, response);
  } finally {
    releaseLeasedSharedCodexAppServerClient(resolved.client);
  }
}

async function runBoundTurn(params: {
  data: CodexAppServerConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  ctx: PluginHookInboundClaimContext;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  sessionKey?: string;
  timeoutMs?: number;
  sendProgressReply?: SendCodexConversationProgressReply;
}): Promise<BoundTurnResult> {
  const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir, config: params.config });
  const binding = await readCodexAppServerBinding(params.data.sessionFile, agentLookup);
  const threadId = binding?.threadId;
  if (!threadId) {
    throw new Error("bound Codex conversation has no thread binding");
  }
  if (!binding) {
    throw new Error("bound Codex conversation has no thread binding");
  }
  const workspaceDir = binding.cwd || params.data.workspaceDir;
  const { execPolicy, runtime } = await resolveConversationAppServerRuntime({
    pluginConfig: params.pluginConfig,
    config: params.config,
    sessionKey: params.sessionKey,
    workspaceDir,
  });
  assertNativeConversationApprovalPolicySupported({ execPolicy, runtime });

  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: binding.authProfileId,
    ...agentLookup,
  });
  const sendProgressReply = async (payload: ReplyPayload): Promise<void> => {
    await params.sendProgressReply?.({
      event: params.event,
      ctx: params.ctx,
      payload,
    });
  };
  const createCollector = () =>
    createCodexConversationTurnCollector(threadId, {
      onProgress: binding.liveProgress
        ? (text) =>
            sendProgressReply({
              text,
            }).catch(() => undefined)
        : undefined,
    });
  let collector = createCollector();
  const notificationCleanup = client.addNotificationHandler((notification) =>
    collector.handleNotification(notification),
  );
  const reasoningEffort = resolveCodexAppServerConversationReasoningEffort({
    mode: binding.collaborationMode,
    bindingDefaults: binding.reasoningEffortDefaults,
    legacyReasoningEffort: binding.reasoningEffort,
    configDefaults: runtime.conversationReasoningDefaults,
  });
  const normalizedReasoningEffort = reasoningEffort
    ? resolveReasoningEffort(reasoningEffort, binding.model ?? "")
    : null;
  const collaborationMode = buildBoundConversationCollaborationMode(
    binding,
    normalizedReasoningEffort,
  );
  let activeTurnId: string | undefined;
  let userInputTimedOut = false;
  let userInputTimeoutInterruptFailed = false;
  const interruptActiveTurnAfterUserInputTimeout = async () => {
    const turnId = activeTurnId;
    if (!turnId) {
      return;
    }
    await client.request(
      "turn/interrupt",
      { threadId, turnId } satisfies CodexTurnInterruptParams,
      { timeoutMs: runtime.requestTimeoutMs },
    );
    userInputTimedOut = true;
  };
  const requestCleanup = client.addRequestHandler(
    async (request): Promise<JsonValue | undefined> => {
      if (request.method === "item/tool/call") {
        return {
          contentItems: [
            {
              type: "inputText",
              text: "OpenClaw native Codex conversation binding does not expose dynamic OpenClaw tools yet.",
            },
          ],
          success: false,
        };
      }
      if (request.method === "item/tool/requestUserInput") {
        const requestParams = readUserInputParams(request.params);
        if (!requestParams) {
          return undefined;
        }
        if (
          requestParams.threadId !== threadId ||
          !activeTurnId ||
          requestParams.turnId !== activeTurnId
        ) {
          return undefined;
        }
        if (requestParams.questions.length === 0) {
          return emptyUserInputResponse();
        }
        if (!params.sendProgressReply) {
          return emptyUserInputResponse();
        }
        return await new Promise<JsonValue>((resolve, reject) => {
          const resumeTurnTimeout = collector.suspendTimeout();
          let inputTimeout: ReturnType<typeof setTimeout> | undefined;
          let resolved = false;
          const settle = (complete: () => void) => {
            if (resolved) {
              return;
            }
            resolved = true;
            if (inputTimeout) {
              clearTimeout(inputTimeout);
            }
            resumeTurnTimeout();
            complete();
          };
          const finish = (response: JsonValue) => {
            settle(() => {
              resolve(response);
            });
          };
          const fail = (error: unknown) => {
            settle(() => {
              reject(error);
            });
          };
          const { token, payload } = createCodexUserInputPromptControl({
            questions: requestParams.questions,
            scope: {
              sessionFile: params.data.sessionFile,
              threadId,
              channel: params.event.channel,
              senderId: params.event.senderId ?? params.ctx.senderId,
              accountId: params.event.accountId ?? params.ctx.accountId,
              sessionKey: params.event.sessionKey ?? params.ctx.sessionKey,
              messageThreadId: params.event.threadId,
            },
            resolveText: (text) => finish(buildUserInputResponse(requestParams.questions, text)),
          });
          inputTimeout = setTimeout(() => {
            cancelCodexUserInput({ token });
            void interruptActiveTurnAfterUserInputTimeout()
              .then(() =>
                fail(
                  new CodexAppServerServerRequestError(CODEX_TURN_TRANSITION_SERVER_REQUEST_ERROR),
                ),
              )
              .catch((error: unknown) => {
                userInputTimeoutInterruptFailed = true;
                finish(emptyUserInputResponse());
                throw error;
              })
              .catch(() => undefined);
          }, CODEX_PENDING_CONTROL_TTL_MS);
          inputTimeout.unref?.();
          void sendProgressReply(payload).catch(() => {
            cancelCodexUserInput({ token });
            finish(emptyUserInputResponse());
          });
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
    const completion = await runConversationTurn(params.prompt);
    if (userInputTimeoutInterruptFailed) {
      return {
        reply: {
          text: CODEX_USER_INPUT_TIMEOUT_INTERRUPT_FAILED_REPLY,
        },
      };
    }
    if (userInputTimedOut) {
      return {
        reply: {
          text: CODEX_USER_INPUT_TIMEOUT_REPLY,
        },
      };
    }
    let replyText = completion.replyText.trim();
    let planText = completion.planText.trim();
    let planReplyText = resolvePlanReplyText({ binding, replyText, planText });
    if (
      !planReplyText &&
      binding.collaborationMode === "plan" &&
      referencesMissingProposedPlan(replyText)
    ) {
      const retryCompletion = await runConversationTurn(buildMissingProposedPlanRetryPrompt());
      replyText = retryCompletion.replyText.trim();
      planText = retryCompletion.planText.trim();
      planReplyText = resolvePlanReplyText({ binding, replyText, planText });
    }
    if (planReplyText) {
      return {
        reply: buildCodexPlanDecisionReply({
          text: planReplyText,
          scope: {
            sessionFile: params.data.sessionFile,
            threadId,
            channel: params.event.channel,
            senderId: params.event.senderId ?? params.ctx.senderId,
            accountId: params.event.accountId ?? params.ctx.accountId,
            sessionKey: params.event.sessionKey ?? params.ctx.sessionKey,
            messageThreadId: params.event.threadId,
          },
        }),
      };
    }
    return {
      reply: {
        text: replyText || "Codex completed without a text reply.",
      },
    };
  } finally {
    notificationCleanup();
    requestCleanup();
    releaseLeasedSharedCodexAppServerClient(client);
  }

  async function runConversationTurn(
    prompt: string,
  ): Promise<{ replyText: string; planText: string }> {
    collector = createCollector();
    const response: CodexTurnStartResponse = await client.request(
      "turn/start",
      {
        threadId,
        input: buildCodexConversationTurnInput({
          prompt,
          event: params.event,
        }),
        cwd: workspaceDir,
        approvalPolicy: execPolicy?.touched
          ? runtime.approvalPolicy
          : (binding!.approvalPolicy ?? runtime.approvalPolicy),
        approvalsReviewer: runtime.approvalsReviewer,
        sandboxPolicy: codexSandboxPolicyForTurn(
          execPolicy?.touched ? runtime.sandbox : (binding!.sandbox ?? runtime.sandbox),
          workspaceDir,
        ),
        ...(binding!.model ? { model: binding!.model } : {}),
        personality: CODEX_NATIVE_PERSONALITY_NONE,
        ...(normalizedReasoningEffort ? { effort: normalizedReasoningEffort } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
        ...((binding!.serviceTier ?? runtime.serviceTier)
          ? { serviceTier: binding!.serviceTier ?? runtime.serviceTier }
          : {}),
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
    const turnId = response.turn.id;
    activeTurnId = turnId;
    const activeCleanup = trackCodexConversationActiveTurn({
      sessionFile: params.data.sessionFile,
      threadId: threadId!,
      turnId,
    });
    collector.setTurnId(turnId);
    return await collector
      .wait({
        timeoutMs: params.timeoutMs ?? DEFAULT_BOUND_TURN_TIMEOUT_MS,
      })
      .finally(activeCleanup);
  }
}

function resolvePlanReplyText(params: {
  binding: CodexAppServerThreadBinding;
  replyText: string;
  planText: string;
}): string {
  if (hasCodexProposedPlan(params.replyText)) {
    return params.replyText;
  }
  if (hasCodexProposedPlan(params.planText)) {
    return params.planText;
  }
  return params.binding.collaborationMode === "plan" ? params.planText : "";
}

function referencesMissingProposedPlan(replyText: string): boolean {
  return MISSING_PROPOSED_PLAN_REFERENCE_RE.test(replyText);
}

function buildMissingProposedPlanRetryPrompt(): string {
  return [
    "Your previous reply said a plan was already provided inside a <proposed_plan> block.",
    "No proposed_plan block was delivered to OpenClaw.",
    "OpenClaw also did not receive a native plan payload.",
    "Send the complete implement-ready plan now.",
    "Wrap the entire plan exactly in <proposed_plan> and </proposed_plan>.",
    "Do not refer to earlier or previous messages.",
  ].join(" ");
}

function assertNativeConversationApprovalPolicySupported(params: {
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
  runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
}): void {
  if (params.execPolicy?.touched === true && params.runtime.approvalPolicy !== "never") {
    throw new Error(NATIVE_CONVERSATION_INTERACTIVE_APPROVALS_UNAVAILABLE);
  }
}

async function runBoundTurnWithMissingThreadRecovery(params: {
  data: CodexAppServerConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  ctx: PluginHookInboundClaimContext;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  sessionKey?: string;
  timeoutMs?: number;
  sendProgressReply?: SendCodexConversationProgressReply;
}): Promise<BoundTurnResult> {
  try {
    return await runBoundTurn(params);
  } catch (error) {
    if (!isCodexThreadNotFoundError(error)) {
      throw error;
    }
    const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir, config: params.config });
    const binding = await readCodexAppServerBinding(params.data.sessionFile, agentLookup);
    const execPolicy = resolveConversationExecPolicy({
      config: params.config,
      sessionKey: params.sessionKey,
    });
    const useCurrentRuntimePolicy = execPolicy.touched;
    await startCodexConversationThread({
      pluginConfig: params.pluginConfig,
      sessionFile: params.data.sessionFile,
      workspaceDir: binding?.cwd || params.data.workspaceDir,
      ...agentLookup,
      model: binding?.model,
      modelProvider: binding?.modelProvider,
      authProfileId: binding?.authProfileId,
      approvalPolicy: useCurrentRuntimePolicy ? undefined : binding?.approvalPolicy,
      sandbox: useCurrentRuntimePolicy ? undefined : binding?.sandbox,
      serviceTier: binding?.serviceTier,
      liveProgress: binding?.liveProgress,
      collaborationMode: binding?.collaborationMode,
      reasoningEffort: binding?.reasoningEffort,
      reasoningEffortDefaults: binding?.reasoningEffortDefaults,
      config: params.config,
      sessionKey: params.sessionKey,
    });
    return await runBoundTurn(params);
  }
}

function resolveConversationExecPolicy(params: {
  config?: CodexConversationConfig;
  agentId?: string;
  sessionKey?: string;
}) {
  const agentId =
    params.agentId ??
    (params.config
      ? resolveSessionAgentIds({
          sessionKey: params.sessionKey,
          config: params.config,
        }).sessionAgentId
      : undefined);
  return resolveOpenClawExecPolicyForCodexAppServer({
    config: params.config,
    agentId,
    execOverrides: readSessionExecOverrides({
      config: params.config,
      agentId,
      sessionKey: params.sessionKey,
    }),
    approvals: loadExecApprovals(),
  });
}

function readSessionExecOverrides(params: {
  config?: CodexConversationConfig;
  agentId?: string;
  sessionKey?: string;
}): { security?: string; ask?: string } | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.config || !sessionKey) {
    return undefined;
  }
  const storePath = resolveStorePath(params.config.session?.store, { agentId: params.agentId });
  const entry = resolveSessionStoreEntry({
    store: loadSessionStore(storePath, { skipCache: true }),
    sessionKey,
  }).existing;
  if (!entry?.execSecurity && !entry?.execAsk) {
    return undefined;
  }
  return {
    security: entry.execSecurity,
    ask: entry.execAsk,
  };
}

function buildBoundConversationCollaborationMode(
  binding: CodexAppServerThreadBinding,
  reasoningEffort: CodexAppServerReasoningEffort | null,
):
  | {
      mode: CodexAppServerCollaborationMode;
      settings: {
        model: string | null;
        reasoning_effort: CodexAppServerReasoningEffort | null;
        developer_instructions: string | null;
      };
    }
  | undefined {
  if (!binding.collaborationMode && !reasoningEffort) {
    return undefined;
  }
  // The Codex app-server contract requires Settings.model to be a
  // string. Older session bindings may not have a stored model
  // (model was optional in early versions of CodexAppServerThreadBinding).
  // Skip the collaboration mode object in that case so the turn
  // request stays valid; the user can re-bind to pick a model.
  if (!binding.model) {
    return undefined;
  }
  return {
    mode: binding.collaborationMode ?? "default",
    settings: {
      model: binding.model,
      reasoning_effort: reasoningEffort,
      developer_instructions: null,
    },
  };
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    /\bthread not found:/iu.test(message) ||
    /\bbound Codex conversation has no thread binding\b/u.test(message)
  );
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
  if (isCodexAppServerNativeAuthProfile(params) && modelProvider.toLowerCase() === "openai") {
    return undefined;
  }
  return modelProvider.toLowerCase() === "openai" ? "openai" : modelProvider;
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
