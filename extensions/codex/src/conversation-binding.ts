// Codex plugin module implements conversation binding behavior.
import { isDeepStrictEqual } from "node:util";
import {
  embeddedAgentLog,
  formatErrorMessage,
  resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir, resolveSessionAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  isCodexAppServerUnsafeSubscriptionError,
  runCodexTurnStartWithNativeTurnRetry,
  runCodexTurnStartWithLease,
  settleCodexAppServerClientLease,
  validateCodexThreadCreationResponse,
} from "./app-server/attempt-client-cleanup.js";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import {
  codexSandboxPolicyForTurn,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveCodexAppServerRuntime,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
  type OpenClawExecPolicyForCodexAppServer,
} from "./app-server/config.js";
import {
  assertCodexThreadStartResponse,
  assertCodexTurnStartResponse,
} from "./app-server/protocol-validators.js";
import type {
  CodexServiceTier,
  CodexThreadResumeParams,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
  JsonObject,
} from "./app-server/protocol.js";
import {
  resolveCodexNativeExecutionBlock,
  resolveCodexNativeSandboxBlock,
} from "./app-server/sandbox-guard.js";
import {
  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
  normalizeCodexAppServerBindingModelProvider,
  resolveCodexAppServerBindingModelProvider,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import {
  leaseSharedCodexAppServerClient,
  type CodexAppServerClientLease,
} from "./app-server/shared-client.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerModelProvider,
  resolveCodexAppServerRequestModelSelection,
} from "./app-server/thread-lifecycle.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import {
  CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS,
  getCodexAppServerTurnRouter,
  type CodexThreadRouteReservation,
} from "./app-server/turn-router.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  readCodexConversationBindingData,
  type CodexAppServerConversationBindingData,
  type CodexAppServerConversationSource,
} from "./conversation-binding-data.js";
import { trackCodexConversationActiveTurn } from "./conversation-control.js";
import { createCodexTerminalTextCollector } from "./conversation-turn-collector.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";
import type { resumeCodexCliSessionOnNode } from "./node-cli-sessions.js";

const DEFAULT_BOUND_TURN_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_AGENT_ID = "main";
const VALID_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS_PATTERN = /[^a-z0-9_-]+/g;
const LEADING_DASH_PATTERN = /^-+/;
const TRAILING_DASH_PATTERN = /-+$/;
const NATIVE_CONVERSATION_INTERACTIVE_APPROVALS_UNAVAILABLE =
  "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.";

type CodexConversationRunOptions = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  timeoutMs?: number;
  resumeCodexCliSessionOnNode?: ResumeCodexCliSessionOnNodeFn;
};

type ResumeCodexCliSessionOnNodeFn = (
  params: Omit<Parameters<typeof resumeCodexCliSessionOnNode>[0], "runtime">,
) => ReturnType<typeof resumeCodexCliSessionOnNode>;

class CodexBoundThreadMissingError extends Error {
  constructor(cause: unknown) {
    super(formatErrorMessage(cause), { cause });
    this.name = "CodexBoundThreadMissingError";
  }
}

class CodexConversationInitializationError extends Error {
  constructor(cause: unknown) {
    super(formatErrorMessage(cause), { cause });
    this.name = "CodexConversationInitializationError";
  }
}

type CodexConversationConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];
type ResolvedCodexConversationConfig = NonNullable<CodexConversationConfig>;

const boundTurns = new KeyedAsyncQueue();

async function resolveConversationAppServerRuntime(params: {
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  agentId?: string;
  agentDir?: string;
  sessionKey?: string;
  execOverrides?: PluginHookInboundClaimContext["execOverrides"];
  workspaceDir: string;
  modelProvider?: string;
  model?: string;
}): Promise<{
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
  runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
  modelBackedReviewerAvailable: boolean;
}> {
  const execPolicy = resolveConversationExecPolicy({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  });
  const sandboxForPolicy =
    execPolicy.touched && execPolicy.security === "full" && execPolicy.ask !== "off"
      ? await resolveSandboxContext({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
        })
      : undefined;
  const { appServer: runtime, modelBackedReviewerAvailable } = resolveCodexAppServerRuntime({
    pluginConfig: params.pluginConfig,
    execPolicy,
    modelProvider: params.modelProvider,
    model: params.model,
    config: params.config,
    agentDir: params.agentDir,
    openClawSandboxActive: Boolean(sandboxForPolicy?.enabled),
  });
  return { execPolicy, runtime, modelBackedReviewerAvailable };
}

function assertConversationBindingExpectation(
  current: CodexAppServerThreadBinding | undefined,
  expected: CodexAppServerThreadBinding | undefined,
): void {
  // Runtime/client preparation happens before the bounded lease. Require the
  // same snapshot so a concurrent policy/auth patch is never overwritten.
  if (isDeepStrictEqual(current, expected)) {
    return;
  }
  throw conversationBindingConflict(expected?.threadId, current?.threadId);
}

function conversationBindingConflict(expectedThreadId?: string, currentThreadId?: string): Error {
  const detail =
    expectedThreadId && expectedThreadId === currentThreadId ? " with different settings" : "";
  return new Error(
    `Codex conversation binding changed while preparing its thread (expected ${expectedThreadId ?? "no thread"}, found ${currentThreadId ?? "no thread"}${detail})`,
  );
}

export async function handleCodexConversationInboundClaim(
  event: PluginHookInboundClaimEvent,
  ctx: PluginHookInboundClaimContext,
  options: CodexConversationRunOptions,
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
  const agentId = data.agentId ?? ctx.agentId;
  const nativeExecutionBlock =
    data.kind === "codex-cli-node-session"
      ? resolveCodexNativeSandboxBlock({
          config: options.config,
          agentId,
          sessionKey: event.sessionKey ?? ctx.sessionKey,
          surface: "Codex CLI node conversation binding",
        })
      : resolveCodexNativeExecutionBlock({
          config: options.config,
          agentId,
          sessionKey: event.sessionKey ?? ctx.sessionKey,
          agentId: data.agentId,
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
      const result = await boundTurns.enqueue(`${data.nodeId}:${data.sessionId}`, async () => {
        const resumed = await resume({
          nodeId: data.nodeId,
          sessionId: data.sessionId,
          prompt,
          cwd: data.cwd,
          timeoutMs: options.timeoutMs,
        });
        return { text: resumed.text.trim() || "Codex completed without a text reply." };
      });
      return { handled: true, reply: result };
    } catch (error) {
      return {
        handled: true,
        reply: {
          text: `Codex CLI node turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}`,
        },
      };
    }
  }
  const appServerData: CodexAppServerConversationBindingData = agentId
    ? {
        ...data,
        agentId,
        agentDir: data.agentDir ?? resolveAgentDir(options.config ?? {}, agentId),
      }
    : data;
  try {
    const result = await boundTurns.enqueue(appServerData.bindingId, async () => {
      return await runBoundTurnWithMissingThreadRecovery({
        bindingStore: options.bindingStore,
        data: appServerData,
        prompt,
        event,
        config: options.config,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
        execOverrides: ctx.execOverrides,
        pluginConfig: options.pluginConfig,
        timeoutMs: options.timeoutMs,
      });
    });
    return { handled: true, reply: result };
  } catch (error) {
    if (error instanceof CodexConversationInitializationError) {
      return {
        handled: true,
        reply: {
          text: `Codex binding initialization failed: ${formatCodexDisplayText(
            formatErrorMessage(error),
          )} Run /codex detach, then retry /codex bind.`,
        },
      };
    }
    return {
      handled: true,
      reply: {
        text: `Codex app-server turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}`,
      },
    };
  }
}

type CodexThreadRuntimeParams = {
  pluginConfig?: unknown;
  workspaceDir: string;
  agentDir?: string;
  model?: string;
  modelProvider?: string;
  explicitModelProvider?: boolean;
  policyModelProvider?: string;
  authProfileId?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  config?: CodexAppServerAuthProfileLookup["config"];
  agentId?: string;
  sessionKey?: string;
  execOverrides?: PluginHookInboundClaimContext["execOverrides"];
};

type ConversationAppServerRuntime = Awaited<ReturnType<typeof resolveConversationAppServerRuntime>>;

type CodexThreadBindingPolicy = {
  runtime: ConversationAppServerRuntime["runtime"];
  agentLookup: ReturnType<typeof buildAgentLookup>;
  model?: string;
  modelProvider?: string;
  approvalPolicy: ConversationAppServerRuntime["runtime"]["approvalPolicy"];
  sandbox: ConversationAppServerRuntime["runtime"]["sandbox"];
  serviceTier?: CodexServiceTier;
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
  modelBackedApprovalsReviewerUnavailable: boolean;
  reviewerModelProvider?: string;
};

type CodexThreadBindingRuntime = CodexThreadBindingPolicy & {
  clientLease: CodexAppServerClientLease;
};

type PreparedConversationTurnRoute = {
  collector: ReturnType<typeof createCodexTerminalTextCollector>;
  reservation: CodexThreadRouteReservation;
};

type PreparedConversationThread = {
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding;
  workspaceDir: string;
  resolved: CodexThreadBindingRuntime;
  thread: CodexThreadResumeResponse["thread"];
  turnRoute: PreparedConversationTurnRoute;
};

type ConversationThreadPlan =
  | { kind: "resume"; expected: CodexAppServerThreadBinding }
  | {
      kind: "initialize";
      expected: CodexAppServerThreadBinding | undefined;
      start: CodexAppServerConversationBindingData["start"];
    }
  | { kind: "recover"; expected: CodexAppServerThreadBinding };

type ConversationTurnParams = {
  bindingStore: CodexAppServerBindingStore;
  data: CodexAppServerConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  sessionKey?: string;
  execOverrides?: PluginHookInboundClaimContext["execOverrides"];
  timeoutMs?: number;
};

async function resolveThreadBindingPolicy(
  params: CodexThreadRuntimeParams,
): Promise<CodexThreadBindingPolicy> {
  const agentLookup = buildAgentLookup({ agentDir: params.agentDir, config: params.config });
  const requestedModelProvider = params.modelProvider?.trim() || "codex";
  const requestedProviderId = requestedModelProvider.toLowerCase();
  const modelProvider = params.explicitModelProvider
    ? requestedProviderId === "codex"
      ? undefined
      : requestedProviderId === "openai"
        ? "openai"
        : requestedModelProvider
    : resolveCodexAppServerModelProvider({
        provider: requestedModelProvider,
        authProfileId: params.authProfileId,
        ...agentLookup,
      });
  const requestedModel = params.model?.trim();
  const modelSelection = requestedModel
    ? resolveCodexAppServerRequestModelSelection({
        model: requestedModel,
        modelProvider,
        authProfileId: params.authProfileId,
        ...agentLookup,
      })
    : undefined;
  const reviewerPolicyContext = resolveCodexModelBackedReviewerPolicyContext({
    provider: params.policyModelProvider ?? modelSelection?.modelProvider ?? modelProvider,
    model: modelSelection?.model ?? params.model,
  });
  const { execPolicy, runtime, modelBackedReviewerAvailable } =
    await resolveConversationAppServerRuntime({
      pluginConfig: params.pluginConfig,
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      execOverrides: params.execOverrides,
      workspaceDir: params.workspaceDir,
      modelProvider: reviewerPolicyContext.modelProvider,
      model: reviewerPolicyContext.model,
      agentDir: params.agentDir,
    });
  const modelBackedApprovalsReviewerUnavailable = !modelBackedReviewerAvailable;
  const useCurrentPolicy = execPolicy?.touched || modelBackedApprovalsReviewerUnavailable;
  const approvalPolicy = useCurrentPolicy
    ? runtime.approvalPolicy
    : (params.approvalPolicy ?? runtime.approvalPolicy);
  const sandbox = useCurrentPolicy ? runtime.sandbox : (params.sandbox ?? runtime.sandbox);
  return {
    runtime,
    agentLookup,
    model: modelSelection?.model,
    modelProvider: modelSelection?.modelProvider ?? modelProvider,
    approvalPolicy,
    sandbox,
    serviceTier: params.serviceTier ?? runtime.serviceTier,
    execPolicy,
    modelBackedApprovalsReviewerUnavailable,
    reviewerModelProvider: reviewerPolicyContext.modelProvider,
  };
}

function assertThreadBindingPolicySupported(
  policy: CodexThreadBindingPolicy,
  options: { allowUnknownProvider?: boolean } = {},
): void {
  if (
    options.allowUnknownProvider &&
    !policy.reviewerModelProvider &&
    policy.execPolicy?.touched !== true
  ) {
    return;
  }
  if (
    policy.approvalPolicy !== "never" &&
    (policy.execPolicy?.touched === true ||
      (policy.modelBackedApprovalsReviewerUnavailable &&
        policy.runtime.approvalsReviewer === "user"))
  ) {
    throw new Error(NATIVE_CONVERSATION_INTERACTIVE_APPROVALS_UNAVAILABLE);
  }
}

async function resolveThreadBindingRuntime(
  params: CodexThreadRuntimeParams,
  options: { allowUnknownProvider?: boolean } = {},
): Promise<CodexThreadBindingRuntime> {
  const policy = await resolveThreadBindingPolicy(params);
  assertThreadBindingPolicySupported(policy, options);
  const clientLease = await leaseSharedCodexAppServerClient({
    startOptions: policy.runtime.start,
    timeoutMs: policy.runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...policy.agentLookup,
  });
  return {
    ...policy,
    clientLease,
  };
}

function buildThreadRequestRuntimeOptions(resolved: CodexThreadBindingRuntime): {
  approvalPolicy: ConversationAppServerRuntime["runtime"]["approvalPolicy"];
  approvalsReviewer: ConversationAppServerRuntime["runtime"]["approvalsReviewer"];
  sandbox?: ConversationAppServerRuntime["runtime"]["sandbox"];
  config?: JsonObject;
  serviceTier?: CodexServiceTier;
} {
  return {
    approvalPolicy: resolved.approvalPolicy,
    approvalsReviewer: resolved.runtime.approvalsReviewer,
    ...(resolved.runtime.networkProxy
      ? { config: resolved.runtime.networkProxy.configPatch }
      : { sandbox: resolved.sandbox }),
    ...(resolved.serviceTier ? { serviceTier: resolved.serviceTier } : {}),
  };
}

async function resolveThreadResponseRuntime(params: {
  runtimeParams: CodexThreadRuntimeParams;
  resolved: CodexThreadBindingRuntime;
  response: {
    model: string;
    modelProvider: string;
  };
}): Promise<CodexThreadBindingRuntime> {
  const model = params.response.model.trim();
  const modelProvider = params.response.modelProvider.trim();
  const policy = await resolveThreadBindingPolicy({
    ...params.runtimeParams,
    model,
    modelProvider,
    policyModelProvider: modelProvider,
  });
  return { ...policy, clientLease: params.resolved.clientLease };
}

function buildConversationThreadResumeParams(params: {
  threadId: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy: ConversationAppServerRuntime["runtime"]["approvalPolicy"];
  approvalsReviewer: ConversationAppServerRuntime["runtime"]["approvalsReviewer"];
  sandbox?: ConversationAppServerRuntime["runtime"]["sandbox"];
  config?: JsonObject;
  serviceTier?: CodexServiceTier;
}): CodexThreadResumeParams {
  return {
    threadId: params.threadId,
    ...(params.model ? { model: params.model } : {}),
    ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    approvalPolicy: params.approvalPolicy,
    approvalsReviewer: params.approvalsReviewer,
    ...(params.config ? { config: params.config } : { sandbox: params.sandbox }),
    ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
    persistExtendedHistory: true,
    excludeTurns: true,
  };
}

function reserveConversationTurnRoute(
  client: CodexAppServerClientLease["client"],
  threadId: string,
): PreparedConversationTurnRoute {
  return {
    collector: createCodexTerminalTextCollector(threadId),
    reservation: getCodexAppServerTurnRouter(client).reserveThread({ threadId }),
  };
}

function conversationTurnRouteHandlers(collector: PreparedConversationTurnRoute["collector"]) {
  return {
    onNotification: (notification: Parameters<typeof collector.handleNotification>[0]) =>
      collector.handleNotification(notification),
  };
}

async function runBoundTurn(
  prepared: PreparedConversationThread,
  params: Pick<ConversationTurnParams, "data" | "event" | "prompt" | "timeoutMs">,
): Promise<ReplyPayload> {
  const threadId = prepared.binding.threadId;
  const { resolved, workspaceDir } = prepared;
  const client = resolved.clientLease.client;
  const route = prepared.turnRoute.reservation;
  const collector = prepared.turnRoute.collector;
  const { runtime, approvalPolicy, sandbox, serviceTier } = resolved;
  let abandonClient = false;
  try {
    if (prepared.thread.status?.type === "active") {
      const nativeTurnCompleted = await route.waitForTurnCompletion({
        timeoutMs: Math.min(runtime.requestTimeoutMs, CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS),
      });
      if (!nativeTurnCompleted) {
        throw new Error(`Codex thread ${threadId} remained busy before the bound turn could start`);
      }
      await route.drain();
    }
    const turnParams = {
      threadId,
      input: buildCodexConversationTurnInput({
        prompt: params.prompt,
        event: params.event,
      }),
      cwd: workspaceDir,
      approvalPolicy,
      approvalsReviewer: runtime.approvalsReviewer,
      ...(runtime.networkProxy
        ? {}
        : { sandboxPolicy: codexSandboxPolicyForTurn(sandbox, workspaceDir) }),
      ...(resolved.model ? { model: resolved.model } : {}),
      personality: CODEX_NATIVE_PERSONALITY_NONE,
      ...(serviceTier ? { serviceTier } : {}),
    };
    const startTurn = async () => {
      route.armTurn();
      try {
        return await runCodexTurnStartWithLease(resolved.clientLease, async () =>
          assertCodexTurnStartResponse(
            await client.request("turn/start", turnParams, {
              timeoutMs: runtime.requestTimeoutMs,
            }),
          ),
        );
      } catch (error) {
        await route.cancelTurn();
        throw error;
      }
    };
    let response: CodexTurnStartResponse;
    try {
      response = await runCodexTurnStartWithNativeTurnRetry({
        startTurn,
        waitForActiveTurnCompletion: () =>
          route.waitForTurnCompletion({
            timeoutMs: Math.min(
              runtime.requestTimeoutMs,
              CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS,
            ),
          }),
        afterActiveTurnCompletion: async () => await route.drain(),
        onRetry: () => {
          embeddedAgentLog.info(
            "codex bound turn/start raced active native work; waiting before one retry",
            { threadId },
          );
        },
      });
    } catch (error) {
      if (isCodexThreadNotFoundError(error)) {
        throw new CodexBoundThreadMissingError(error);
      }
      throw error;
    }
    const turnId = response.turn.id;
    const activeTurn = {
      identity: prepared.identity,
      threadId,
      turnId,
      interrupt: async () => {
        await client.request(
          "turn/interrupt",
          { threadId, turnId },
          { timeoutMs: runtime.requestTimeoutMs },
        );
      },
      steer: async (message: string) => {
        await client.request(
          "turn/steer",
          {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: "text", text: message, text_elements: [] }],
          },
          { timeoutMs: runtime.requestTimeoutMs },
        );
      },
    };
    const activeCleanup = trackCodexConversationActiveTurn(activeTurn);
    collector.bindTurn(turnId, response.turn);
    let replyText: string;
    try {
      await route.bindTurn(turnId);
      const completion = await collector.wait({
        timeoutMs: params.timeoutMs ?? DEFAULT_BOUND_TURN_TIMEOUT_MS,
        signal: route.signal,
      });
      replyText = completion.replyText.trim();
    } catch (error) {
      if (!collector.completed) {
        try {
          await activeTurn.interrupt();
        } catch (interruptError) {
          abandonClient = true;
          embeddedAgentLog.debug("codex bound turn interrupt cleanup failed", {
            threadId,
            turnId,
            error: interruptError,
          });
        }
      }
      throw error;
    } finally {
      activeCleanup();
    }
    return { text: replyText || "Codex completed without a text reply." };
  } catch (error) {
    abandonClient ||= isCodexAppServerUnsafeSubscriptionError(error);
    throw error;
  } finally {
    route.release();
    await settleCodexAppServerClientLease(resolved.clientLease, {
      threadId: route.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      abandon: abandonClient,
    });
  }
}

async function runBoundTurnWithMissingThreadRecovery(
  params: ConversationTurnParams,
): Promise<ReplyPayload> {
  const identity = conversationBindingIdentity(params.data);
  const binding = await params.bindingStore.read(identity);
  if (!binding && params.data.legacyBinding) {
    throw new CodexConversationInitializationError(
      new Error(
        "Legacy Codex conversation binding has not been migrated. Run openclaw doctor --fix, or detach and bind again.",
      ),
    );
  }
  const plan = selectConversationThreadPlan(params.data, binding);
  let prepared: PreparedConversationThread;
  let recovered = false;
  try {
    prepared = await prepareConversationThread(params, plan);
  } catch (error) {
    if (plan.kind === "initialize" && plan.start) {
      throw new CodexConversationInitializationError(error);
    }
    if (!(error instanceof CodexBoundThreadMissingError) || plan.kind !== "resume") {
      throw error;
    }
    prepared = await prepareConversationThread(params, {
      kind: "recover",
      expected: plan.expected,
    });
    recovered = true;
  }
  try {
    return await runBoundTurn(prepared, params);
  } catch (error) {
    if (!(error instanceof CodexBoundThreadMissingError) || plan.kind !== "resume" || recovered) {
      throw error;
    }
    const recoveredThread = await prepareConversationThread(params, {
      kind: "recover",
      expected: prepared.binding,
    });
    return await runBoundTurn(recoveredThread, params);
  }
}

function selectConversationThreadPlan(
  data: CodexAppServerConversationBindingData,
  binding: CodexAppServerThreadBinding | undefined,
): ConversationThreadPlan {
  const start = data.start;
  if (!binding || (start && binding.conversationStartId !== start.id)) {
    return { kind: "initialize", expected: binding, start };
  }
  return { kind: "resume", expected: binding };
}

function conversationSourceIdentity(
  source: CodexAppServerConversationSource,
): Extract<CodexAppServerBindingIdentity, { kind: "session" }> {
  return {
    kind: "session",
    agentId: source.agentId,
    sessionId: source.sessionId,
    ...(source.sessionKey ? { sessionKey: source.sessionKey } : {}),
  };
}

function conversationSourceChangedError(): Error {
  return new Error("Codex source session changed before conversation ownership could transfer");
}

async function withRequiredConversationSourceLease<T>(
  params: Pick<ConversationTurnParams, "bindingStore" | "data">,
  run: () => Promise<T>,
): Promise<T> {
  const source = params.data.source;
  if (!source) {
    return await run();
  }
  const identity = conversationSourceIdentity(source);
  return await params.bindingStore.withLease(identity, async () => {
    const binding = await params.bindingStore.read(identity);
    if (binding?.threadId !== source.threadId) {
      throw conversationSourceChangedError();
    }
    return await run();
  });
}

async function reconcileConversationSourceTransfer(params: {
  bindingStore: CodexAppServerBindingStore;
  data: Pick<CodexAppServerConversationBindingData, "source">;
  conversationIdentity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding;
  sourceRequired: boolean;
}): Promise<CodexAppServerThreadBinding> {
  const source = params.data.source;
  if (!source || params.binding.conversationSourceTransferComplete) {
    return params.binding;
  }
  const sourceIdentity = conversationSourceIdentity(source);
  return await params.bindingStore.withLease(sourceIdentity, async () => {
    // The target row is the durable commit record. This marker closes the
    // crash window between committing it and clearing the previous owner.
    const sourceBinding = await params.bindingStore.read(sourceIdentity);
    if (sourceBinding?.threadId === source.threadId) {
      const released = await params.bindingStore.mutate(sourceIdentity, {
        kind: "clear",
        threadId: source.threadId,
      });
      if (!released) {
        if (params.sourceRequired) {
          await rollbackConversationSourceTransfer(params, conversationSourceChangedError());
        }
        throw conversationSourceChangedError();
      }
    } else if (params.sourceRequired) {
      await rollbackConversationSourceTransfer(params, conversationSourceChangedError());
    }

    const marked = await params.bindingStore.mutate(params.conversationIdentity, {
      kind: "patch",
      threadId: params.binding.threadId,
      patch: { conversationSourceTransferComplete: true },
    });
    if (!marked) {
      throw conversationBindingConflict(params.binding.threadId);
    }
    const stored = await params.bindingStore.read(params.conversationIdentity);
    if (
      stored?.threadId !== params.binding.threadId ||
      !stored.conversationSourceTransferComplete
    ) {
      throw conversationBindingConflict(params.binding.threadId, stored?.threadId);
    }
    return stored;
  });
}

async function rollbackConversationSourceTransfer(
  params: Pick<
    Parameters<typeof reconcileConversationSourceTransfer>[0],
    "bindingStore" | "conversationIdentity" | "binding"
  >,
  cause: Error,
): Promise<never> {
  const rolledBack = await params.bindingStore.mutate(params.conversationIdentity, {
    kind: "clear",
    threadId: params.binding.threadId,
  });
  if (!rolledBack) {
    throw new Error("Codex conversation ownership rollback failed", { cause });
  }
  throw cause;
}

async function prepareConversationThread(
  params: ConversationTurnParams,
  plan: ConversationThreadPlan,
): Promise<PreparedConversationThread> {
  const expected = plan.expected;
  const requested = plan.kind === "initialize" ? plan.start : undefined;
  const inherited = plan.kind === "initialize" && requested ? undefined : expected;
  const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir, config: params.config });
  const identity = conversationBindingIdentity(params.data);
  const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
    authProfileId: requested?.authProfileId ?? inherited?.authProfileId,
    ...agentLookup,
  });
  const workspaceDir = requested
    ? params.data.workspaceDir
    : (inherited?.cwd ?? params.data.workspaceDir);
  const runtimeParams: CodexThreadRuntimeParams = {
    pluginConfig: params.pluginConfig,
    workspaceDir,
    ...agentLookup,
    model: requested?.model ?? inherited?.model,
    modelProvider: requested?.modelProvider ?? inherited?.modelProvider,
    explicitModelProvider: Boolean(requested?.modelProvider),
    policyModelProvider: inherited
      ? resolveCodexAppServerBindingModelProvider({
          modelProvider: inherited.modelProvider,
          authProfileId: inherited.authProfileId,
          ...agentLookup,
        })
      : undefined,
    authProfileId,
    approvalPolicy: inherited?.approvalPolicy,
    sandbox: inherited?.sandbox,
    serviceTier: inherited?.serviceTier,
    config: params.config,
    agentId: params.data.agentId,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  };
  let resolved = await resolveThreadBindingRuntime(runtimeParams, {
    allowUnknownProvider: plan.kind !== "resume",
  });
  const client = resolved.clientLease.client;
  const requestTimeoutMs = Math.min(
    resolved.runtime.requestTimeoutMs,
    CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
  );
  let subscribedThreadId: string | undefined;
  let turnRoute: PreparedConversationTurnRoute | undefined;
  try {
    return await params.bindingStore.withLease(identity, async () => {
      assertConversationBindingExpectation(await params.bindingStore.read(identity), expected);
      let sourceTransferComplete = expected?.conversationSourceTransferComplete === true;
      if (params.data.source && expected && !sourceTransferComplete) {
        const reconciled = await reconcileConversationSourceTransfer({
          bindingStore: params.bindingStore,
          data: params.data,
          conversationIdentity: identity,
          binding: expected,
          sourceRequired: false,
        });
        sourceTransferComplete = reconciled.conversationSourceTransferComplete === true;
      }
      const needsSourceTransfer = Boolean(params.data.source) && !sourceTransferComplete;
      const prepare = async (): Promise<PreparedConversationThread> => {
        const resumeThreadId =
          plan.kind === "resume" ? plan.expected.threadId : requested?.threadId?.trim();
        let response: CodexThreadResumeResponse | CodexThreadStartResponse;
        if (resumeThreadId && !resolved.runtime.networkProxy) {
          turnRoute = reserveConversationTurnRoute(client, resumeThreadId);
          await turnRoute.reservation.activate(conversationTurnRouteHandlers(turnRoute.collector));
          subscribedThreadId = resumeThreadId;
          // Bound conversations have no OpenClaw transcript projection to rebuild
          // continuity, so keep the native thread and let Codex own compaction.
          response = await resumeCodexAppServerThread({
            client,
            abandonClient: resolved.clientLease.abandon,
            request: buildConversationThreadResumeParams({
              threadId: resumeThreadId,
              model: resolved.model,
              modelProvider: resolved.modelProvider,
              ...buildThreadRequestRuntimeOptions(resolved),
            }),
            timeoutMs: requestTimeoutMs,
          });
        } else {
          response = await validateCodexThreadCreationResponse(
            resolved.clientLease,
            await client.request(
              "thread/start",
              {
                cwd: runtimeParams.workspaceDir,
                ...(resolved.model ? { model: resolved.model } : {}),
                ...(resolved.modelProvider ? { modelProvider: resolved.modelProvider } : {}),
                personality: CODEX_NATIVE_PERSONALITY_NONE,
                ...buildThreadRequestRuntimeOptions(resolved),
                developerInstructions:
                  "This Codex thread is bound to an OpenClaw conversation. Answer normally; OpenClaw will deliver your final response back to the conversation.",
                experimentalRawEvents: true,
                persistExtendedHistory: true,
              },
              { timeoutMs: requestTimeoutMs },
            ),
            assertCodexThreadStartResponse,
          );
          subscribedThreadId = response.thread.id;
          turnRoute = reserveConversationTurnRoute(client, response.thread.id);
          await turnRoute.reservation.activate(conversationTurnRouteHandlers(turnRoute.collector));
        }
        const active = await resolveThreadResponseRuntime({ runtimeParams, resolved, response });
        resolved = active;
        const runtimeApprovalPolicy =
          typeof resolved.approvalPolicy === "string" ? resolved.approvalPolicy : undefined;
        const activeModelProvider = normalizeCodexAppServerBindingModelProvider({
          authProfileId,
          modelProvider: active.modelProvider,
          ...resolved.agentLookup,
        });
        const modelChanged =
          active.model !== expected?.model || activeModelProvider !== expected?.modelProvider;
        const committed = await params.bindingStore.mutate(
          identity,
          plan.kind === "resume"
            ? {
                kind: "patch",
                threadId: response.thread.id,
                patch: {
                  model: active.model,
                  modelProvider: activeModelProvider,
                  ...(modelChanged
                    ? {
                        nativeContextUsage: undefined,
                        modelContextWindow: undefined,
                      }
                    : {}),
                  approvalPolicy: runtimeApprovalPolicy,
                  sandbox: resolved.sandbox,
                  serviceTier: resolved.serviceTier,
                  networkProxyProfileName: resolved.runtime.networkProxy?.profileName,
                  networkProxyConfigFingerprint: resolved.runtime.networkProxy?.configFingerprint,
                },
              }
            : {
                kind: "set",
                binding: {
                  threadId: response.thread.id,
                  cwd: response.thread.cwd ?? workspaceDir,
                  authProfileId,
                  model: active.model,
                  modelProvider: activeModelProvider,
                  approvalPolicy: runtimeApprovalPolicy,
                  sandbox: resolved.sandbox,
                  serviceTier: resolved.serviceTier,
                  networkProxyProfileName: resolved.runtime.networkProxy?.profileName,
                  networkProxyConfigFingerprint: resolved.runtime.networkProxy?.configFingerprint,
                  conversationStartId: requested?.id ?? inherited?.conversationStartId,
                  ...(sourceTransferComplete
                    ? { conversationSourceTransferComplete: true as const }
                    : {}),
                },
              },
        );
        if (!committed) {
          throw conversationBindingConflict(expected?.threadId);
        }
        let storedBinding = await params.bindingStore.read(identity);
        if (storedBinding?.threadId !== response.thread.id) {
          throw conversationBindingConflict(response.thread.id, storedBinding?.threadId);
        }
        if (plan.kind === "initialize" && needsSourceTransfer) {
          storedBinding = await reconcileConversationSourceTransfer({
            bindingStore: params.bindingStore,
            data: params.data,
            conversationIdentity: identity,
            binding: storedBinding,
            sourceRequired: true,
          });
        }
        if (!turnRoute) {
          throw conversationBindingConflict(response.thread.id);
        }
        assertThreadBindingPolicySupported(active);
        return {
          identity,
          binding: storedBinding,
          workspaceDir: storedBinding.cwd || workspaceDir,
          resolved,
          thread: response.thread,
          turnRoute,
        };
      };
      return plan.kind === "initialize" && needsSourceTransfer
        ? await withRequiredConversationSourceLease(params, prepare)
        : await prepare();
    });
  } catch (error) {
    turnRoute?.reservation.release();
    await settleCodexAppServerClientLease(resolved.clientLease, {
      threadId: subscribedThreadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      abandon: isCodexAppServerUnsafeSubscriptionError(error),
    });
    if (plan.kind === "resume" && isCodexThreadNotFoundError(error)) {
      throw new CodexBoundThreadMissingError(error);
    }
    throw error;
  }
}

function resolveConversationExecPolicy(params: {
  config?: CodexConversationConfig;
  agentId?: string;
  sessionKey?: string;
  execOverrides?: PluginHookInboundClaimContext["execOverrides"];
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
    execOverrides: params.execOverrides,
    approvals: loadExecApprovals(),
  });
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  // thread/resume distinguishes an unknown live thread from a missing persisted rollout.
  // Both mean this durable binding must be replaced instead of retried forever.
  return /\b(?:thread not found:|no rollout found for thread id\b)/iu.test(message);
}

function conversationBindingIdentity(
  data: Pick<CodexAppServerConversationBindingData, "bindingId">,
): Extract<CodexAppServerBindingIdentity, { kind: "conversation" }> {
  return { kind: "conversation", bindingId: data.bindingId };
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
