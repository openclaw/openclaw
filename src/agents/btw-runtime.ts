/** Runtime preparation for /btw side questions. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  buildReplyUsageState,
  recordReplyUsageState,
} from "../auto-reply/reply/reply-usage-state.js";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import type { ChatType } from "../channels/chat-type.js";
import type { SessionEntry as StoredSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import type { ImageContent, Message, Model, TextContent } from "../llm/types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "./auth-profiles/external-cli-auth-selection.js";
import { resolveSessionAuthSelection } from "./auth-profiles/session-override.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { reconcileAuthProfileQuotaBlocks } from "./auth-profiles/usage.js";
import { buildBtwCliPrompt, buildBtwSystemPrompt } from "./btw-prompts.js";
import { normalizeBtwContentBlocks, resolveBtwSessionTranscriptPath } from "./btw-transcript.js";
import { executePreparedCliRun } from "./cli-runner/execute.runtime.js";
import { prepareCliRunContext } from "./cli-runner/prepare.runtime.js";
import type { BlockReplyChunking } from "./embedded-agent-block-chunker.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import type { AgentHarness } from "./harness/types.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "./model-auth.js";
import { isOpenAIProvider } from "./openai-routing.js";
import {
  acquirePublishedPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
  type PreparedModelRuntimeStores,
} from "./prepared-model-runtime.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { sanitizeImageBlocks } from "./tool-images.js";
import { hasBillableUsage, toDiagnosticUsage, type NormalizedUsage } from "./usage.js";

// Planning and immediate resolution share one scoped snapshot so provider
// bindings and cooldown decisions cannot diverge inside a side question.

export async function prepareBtwRuntimeAuth(params: {
  cfg: OpenClawConfig;
  model: Model;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  harnessId?: string;
  harnessAuthBootstrap?: AgentHarness["authBootstrap"];
}) {
  const { model } = params;
  const storeOptions = { profileId: params.authProfileId, allowKeychainPrompt: false };
  const loadStore = (externalCliProviderIds?: readonly string[]) =>
    externalCliProviderIds
      ? ensureAuthProfileStore(params.agentDir, { ...storeOptions, externalCliProviderIds })
      : ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, storeOptions);
  let store: AuthProfileStore;
  let ignoreAutoPreferredProfile = false;
  if (isOpenAIProvider(model.provider)) {
    store = loadStore(["openai"]);
  } else {
    const selection = {
      provider: model.provider,
      cfg: params.cfg,
      agentId: params.agentId,
      modelId: model.id,
      workspaceDir: params.workspaceDir,
      userPinnedAuthProfileId:
        params.authProfileIdSource === "user" ? params.authProfileId : undefined,
    };
    let externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection(selection);
    store = loadStore(externalCliAuthScope.providerIds);
    if (!externalCliAuthScope.providerIds) {
      externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
        ...selection,
        store,
      });
      if (externalCliAuthScope.providerIds) {
        store = loadStore(externalCliAuthScope.providerIds);
      }
    }
    ignoreAutoPreferredProfile = externalCliAuthScope.ignoreAutoPreferredProfile;
  }
  const authParams = {
    provider: model.provider,
    modelId: model.id,
    modelApi: model.api,
    modelBaseUrl: model.baseUrl,
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    env: process.env,
    workspaceDir: params.workspaceDir,
    authProfileStore: store,
    sessionAuthProfileId:
      ignoreAutoPreferredProfile && params.authProfileIdSource !== "user"
        ? undefined
        : params.authProfileId,
    sessionAuthProfileSource: params.authProfileIdSource,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessId,
    harnessAuthBootstrap: params.harnessAuthBootstrap,
  } satisfies Parameters<typeof prepareAgentRuntimeAuth>[0];
  await reconcileAuthProfileQuotaBlocks(authParams);
  return { store, preparation: prepareAgentRuntimeAuth(authParams) };
}

function isBtwTextBlock(block: unknown): block is TextContent {
  if (!block || typeof block !== "object") {
    return false;
  }
  // SAFETY: the guard above establishes a non-null object; only optional fields are inspected.
  const record = block as { type?: unknown; text?: unknown };
  return normalizeLowercaseStringOrEmpty(record.type) === "text" && typeof record.text === "string";
}

function isBtwImageBlock(block: unknown): block is ImageContent {
  if (!block || typeof block !== "object") {
    return false;
  }
  // SAFETY: the guard above establishes a non-null object; only optional fields are inspected.
  const record = block as { type?: unknown; data?: unknown; mimeType?: unknown };
  return (
    normalizeLowercaseStringOrEmpty(record.type) === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  );
}

async function sanitizeBtwUserMessage(params: {
  message: Extract<Message, { role: "user" }>;
  imageLimits: ImageSanitizationLimits;
}): Promise<Extract<Message, { role: "user" }> | undefined> {
  if (typeof params.message.content === "string") {
    return params.message;
  }
  const blocks = normalizeBtwContentBlocks(params.message.content);
  if (!blocks) {
    return undefined;
  }

  const content: Array<TextContent | ImageContent> = [];
  for (const block of blocks) {
    if (isBtwTextBlock(block)) {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (!isBtwImageBlock(block)) {
      continue;
    }
    const { images } = await sanitizeImageBlocks([block], "btw:context", params.imageLimits);
    const image = images[0];
    if (image) {
      content.push(image);
    }
  }

  if (content.length === 0) {
    return undefined;
  }
  return {
    ...params.message,
    content,
  };
}

function sanitizeBtwAssistantMessage(
  message: Extract<Message, { role: "assistant" }>,
): Extract<Message, { role: "assistant" }> | undefined {
  // SAFETY: persisted transcripts can contain legacy string content outside the current message type.
  const rawContent = (message as { content?: unknown }).content;
  if (typeof rawContent === "string") {
    const trimmed = rawContent.trim();
    return trimmed.length > 0
      ? {
          ...message,
          content: [{ type: "text", text: trimmed }],
        }
      : undefined;
  }
  const blocks = normalizeBtwContentBlocks(rawContent);
  if (!blocks) {
    return undefined;
  }
  const content = blocks.flatMap((block): TextContent[] =>
    isBtwTextBlock(block) ? [{ type: "text", text: block.text }] : [],
  );
  if (content.length === 0) {
    return undefined;
  }
  return {
    ...message,
    content,
  };
}

export async function toSimpleContextMessages(params: {
  messages: unknown[];
  imageLimits: ImageSanitizationLimits;
}): Promise<Message[]> {
  const contextMessages: Message[] = [];
  for (const message of params.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    // SAFETY: the guard above establishes a non-null object; only the optional discriminator is read.
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    // BTW is a no-tools path, so keep only user-visible blocks from prior
    // messages and strip hidden reasoning/tool replay data.
    let sanitizedMessage: Message | undefined;
    if (role === "user") {
      // SAFETY: the runtime discriminator check above establishes the user-message variant.
      const userMessage = message as Extract<Message, { role: "user" }>;
      sanitizedMessage = await sanitizeBtwUserMessage({
        message: userMessage,
        imageLimits: params.imageLimits,
      });
    } else {
      // SAFETY: the only remaining admitted discriminator is the assistant-message variant.
      const assistantMessage = message as Extract<Message, { role: "assistant" }>;
      sanitizedMessage = sanitizeBtwAssistantMessage(assistantMessage);
    }
    if (sanitizedMessage) {
      contextMessages.push(sanitizedMessage);
    }
  }
  return contextMessages;
}

type BtwRuntimeAuthPreparation = ReturnType<typeof prepareAgentRuntimeAuth>;

type BtwRuntimeModelMaterialization = {
  abortSignal?: AbortSignal;
  provider: string;
  modelId: string;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  authStorage: PreparedModelRuntimeStores["authStorage"];
  modelRegistry: PreparedModelRuntimeStores["modelRegistry"];
};

async function materializeBtwRuntimeModel(
  params: BtwRuntimeModelMaterialization & {
    plan: AgentRuntimeAuthPlan;
    model: Model;
    forceResolve?: boolean;
  },
): Promise<Model> {
  const { agentDir, config: cfg, workspaceDir } = params.preparedModelRuntime;
  return (
    (await materializePreparedRuntimeModel({
      plan: params.plan,
      provider: params.provider,
      modelId: params.modelId,
      config: cfg,
      workspaceDir,
      metadataSnapshot: params.preparedModelRuntime.metadataSnapshot,
      model: params.model,
      ...(params.forceResolve !== undefined ? { forceResolve: params.forceResolve } : {}),
      resolveModel: ({ config, authProfileId, authProfileMode }) =>
        resolveModelAsync(params.provider, params.modelId, agentDir, config, {
          abortSignal: params.abortSignal,
          modelIdSource: "selected",
          authStorage: params.authStorage,
          modelRegistry: params.modelRegistry,
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: true,
          preparedModelRuntime: params.preparedModelRuntime,
          workspaceDir,
          authProfileId,
          authProfileMode,
        }),
    })) ?? params.model
  );
}

export async function resolveBtwPreparedRuntimeAuth(
  params: BtwRuntimeModelMaterialization & {
    preparation: BtwRuntimeAuthPreparation;
    model: Model;
    authProfileStore: AuthProfileStore;
  },
) {
  const { agentDir, config: cfg, workspaceDir } = params.preparedModelRuntime;
  return resolvePreparedRuntimeAuthAttempts({
    attempts: params.preparation.attempts,
    store: params.authProfileStore,
    modelId: params.modelId,
    model: params.model,
    materializeModel: ({ plan, model, forceResolve }) =>
      materializeBtwRuntimeModel({ ...params, plan, model, forceResolve }),
    resolveAuth: async ({ attempt, model }) =>
      await resolvePreparedRuntimeModelAuth({
        plan: attempt.plan,
        model,
        cfg,
        store: params.authProfileStore,
        agentDir,
        workspaceDir,
        ...(attempt.allowAuthProfileFallback !== undefined
          ? { allowAuthProfileFallback: attempt.allowAuthProfileFallback }
          : {}),
        secretSentinels: true,
      }),
    errorMessage: "BTW prepared auth attempts could not be resolved.",
  });
}

export async function resolveRuntimeModel(params: {
  abortSignal?: AbortSignal;
  provider: string;
  model: string;
  agentId: string;
  sessionEntry?: StoredSessionEntry;
  sessionStore?: Record<string, StoredSessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
  harnessId?: string;
  harnessAuthBootstrap?: AgentHarness["authBootstrap"];
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
}): Promise<{
  model: Model;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileStore: AuthProfileStore;
  runtimeAuthPreparation: BtwRuntimeAuthPreparation;
  authStorage: PreparedModelRuntimeStores["authStorage"];
  modelRegistry: PreparedModelRuntimeStores["modelRegistry"];
}> {
  const preparedModelRuntime = params.preparedModelRuntime;
  const { config: cfg, agentDir, workspaceDir } = preparedModelRuntime;
  const { authStorage, modelRegistry } = preparedModelRuntime.createStores();
  const resolution = await resolveModelAsync(params.provider, params.model, agentDir, cfg, {
    abortSignal: params.abortSignal,
    authStorage,
    modelRegistry,
    preparedModelRuntime,
    workspaceDir,
    skipAgentDiscovery: true,
    allowBundledStaticCatalogFallback: true,
    preferBundledStaticCatalogTransport: Boolean(
      params.harnessId && params.harnessId !== "openclaw",
    ),
  });
  let model = resolution.model;
  if (!model) {
    throw new Error(resolution.error ?? `Unknown model: ${params.provider}/${params.model}`);
  }
  const runtimeProvider = model.provider;
  const runtimeModelId = model.id;

  const authSelection = await resolveSessionAuthSelection({
    cfg,
    provider: runtimeProvider,
    modelId: runtimeModelId,
    agentId: params.agentId,
    harnessRuntime: params.harnessId,
    agentDir,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    isNewSession: params.isNewSession,
  });
  const { store: authProfileStore, preparation: runtimeAuthPreparation } =
    await prepareBtwRuntimeAuth({
      cfg,
      model,
      agentId: params.agentId,
      agentDir,
      workspaceDir,
      authProfileId: authSelection?.profileId,
      authProfileIdSource: authSelection?.source,
      harnessId: params.harnessId,
      harnessAuthBootstrap: params.harnessAuthBootstrap,
    });
  model = await materializeBtwRuntimeModel({
    abortSignal: params.abortSignal,
    provider: runtimeProvider,
    modelId: runtimeModelId,
    preparedModelRuntime,
    authStorage,
    modelRegistry,
    plan: runtimeAuthPreparation.plan,
    model,
  });
  return {
    model,
    authProfileId: runtimeAuthPreparation.plan.forwardedAuthProfileId,
    authProfileIdSource: runtimeAuthPreparation.plan.forwardedAuthProfileSource,
    authProfileStore,
    runtimeAuthPreparation,
    authStorage,
    modelRegistry,
  };
}

export type RunBtwSideQuestionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  provider: string;
  model: string;
  question: string;
  images?: ImageContent[];
  sessionEntry: StoredSessionEntry;
  sessionStore?: Record<string, StoredSessionEntry>;
  sessionKey?: string;
  sandboxSessionKey?: string;
  /**
   * Set by gateway-hosted callers so the prepared runtime resolves the owner the
   * gateway published. Left unset by local callers such as the embedded TUI,
   * which must not borrow the active registry's subagent and node capabilities.
   */
  allowGatewaySubagentBinding?: boolean;
  storePath?: string;
  resolvedThinkLevel?: ThinkLevel;
  resolvedReasoningLevel: ReasoningLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  opts?: GetReplyOptions;
  isNewSession: boolean;
  messageChannel?: string;
  messageProvider?: string;
  chatType?: ChatType;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  chatId?: string;
  messageActionTurnCapability?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  memberRoleIds?: string[];
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  senderIsOwner?: boolean;
  currentChannelId?: string;
  /** Internal execution identity; never reuse a parent/correlation run id. */
  authorityRunId?: string;
};

export function resolveBtwTranscript(params: RunBtwSideQuestionParams) {
  const sessionId = params.sessionEntry.sessionId?.trim();
  if (!sessionId) {
    throw new Error("No active session context.");
  }
  const sessionFile = resolveBtwSessionTranscriptPath({
    sessionId,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!sessionFile) {
    throw new Error("No active session transcript.");
  }
  return { sessionId, sessionFile };
}

export function createBtwRuntimeSelectionResolver(params: {
  request: RunBtwSideQuestionParams;
  sessionAgentId: string;
  harness: AgentHarness;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
}) {
  let selection: Awaited<ReturnType<typeof resolveRuntimeModel>> | undefined;
  return async () => {
    selection ??= await resolveRuntimeModel({
      abortSignal: params.request.opts?.abortSignal,
      provider: params.request.provider,
      model: params.request.model,
      agentId: params.sessionAgentId,
      sessionEntry: params.request.sessionEntry,
      sessionStore: params.request.sessionStore,
      sessionKey: params.request.sessionKey,
      storePath: params.request.storePath,
      isNewSession: params.request.isNewSession,
      harnessId: params.harness.id,
      harnessAuthBootstrap: params.harness.authBootstrap,
      preparedModelRuntime: params.preparedModelRuntime,
    });
    return selection;
  };
}

export function createBtwUsageRecorder(params: {
  request: RunBtwSideQuestionParams;
  sessionAgentId: string;
  sessionId: string;
}) {
  return (runtimeModel: Model, usage?: NormalizedUsage) => {
    if (!hasBillableUsage(usage)) {
      return;
    }
    const usageState = buildReplyUsageState({
      config: params.request.cfg,
      agentDir: params.request.agentDir,
      agentId: params.sessionAgentId,
      sessionId: params.sessionId,
      provider: runtimeModel.provider,
      model: runtimeModel.id,
      chatType: params.request.chatType,
      usage,
    });
    recordReplyUsageState(params.request.opts?.runId, usageState);
    if (isDiagnosticsEnabled(params.request.cfg)) {
      emitTrustedDiagnosticEvent({
        type: "model.usage",
        sessionKey: params.request.sessionKey,
        sessionId: params.sessionId,
        channel: params.request.messageChannel,
        agentId: params.sessionAgentId,
        provider: runtimeModel.provider,
        model: runtimeModel.id,
        usage: toDiagnosticUsage(usage),
        costUsd: usageState.turnUsd,
      });
    }
  };
}

export async function runCliBtwSideQuestion(params: {
  cfg: OpenClawConfig;
  model: string;
  question: string;
  imageCount: number;
  sessionId: string;
  sessionFile: string;
  sessionEntry: StoredSessionEntry;
  sessionKey?: string;
  sessionAgentId: string;
  workspaceDir: string;
  cliProvider: string;
  authProfileId?: string;
  resolvedThinkLevel?: ThinkLevel;
  messages: Message[];
  inFlightPrompt?: string;
  opts?: GetReplyOptions;
  messageChannel?: string;
  messageProvider?: string;
  currentChannelId?: string;
  authorityRunId: string;
}): Promise<ReplyPayload> {
  const timeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfg,
    overrideSeconds: params.opts?.timeoutOverrideSeconds,
    overrideMs: params.opts?.timeoutOverrideMs,
  });
  const runId = params.authorityRunId;
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    params.cfg,
    runId,
    params.sessionAgentId,
    "btw.side-question",
  );
  let prepared: Awaited<ReturnType<typeof prepareCliRunContext>> | undefined;
  try {
    prepared = await prepareCliRunContext({
      preparedRunAdmission,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      agentId: params.sessionAgentId,
      trigger: "user",
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      prompt: buildBtwCliPrompt({
        messages: params.messages,
        question: params.question,
        imageCount: params.imageCount,
        inFlightPrompt: params.inFlightPrompt,
      }),
      extraSystemPrompt: buildBtwSystemPrompt(),
      executionMode: "side-question",
      provider: params.cliProvider,
      model: params.model,
      thinkLevel: params.resolvedThinkLevel,
      disableTools: true,
      timeoutMs,
      runTimeoutOverrideMs: timeoutMs,
      runId,
      authProfileId: params.authProfileId,
      abortSignal: params.opts?.abortSignal,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      currentChannelId: params.currentChannelId,
    });
    const output = await executePreparedCliRun(prepared);
    const text = output.text.trim();
    if (!text) {
      throw new Error(`/btw side question via ${params.cliProvider} produced no answer.`);
    }
    return { text };
  } finally {
    try {
      await prepared?.preparedBackend.cleanup?.();
    } finally {
      preparedRunAdmission.close();
    }
  }
}

/** The visible answer may finish before cooperating provider and cleanup work settles. */
export async function withBtwPreparedRuntime(
  input: Parameters<typeof acquirePublishedPreparedModelRuntime>[0],
  run: (snapshot: PreparedModelRuntimeSnapshot) => Promise<ReplyPayload | undefined>,
): Promise<ReplyPayload | undefined> {
  return await runWithAsyncWorkResources(async (onAcquired, captureWorkContext) => {
    const lease = await acquirePublishedPreparedModelRuntime(input);
    onAcquired({ release: () => lease[Symbol.asyncDispose]() });
    return withPluginRuntimeGenerationScope(lease.snapshot, () => {
      captureWorkContext();
      return run(lease.snapshot);
    });
  });
}

/** Answers a side question using sanitized session context and no tool execution. */
