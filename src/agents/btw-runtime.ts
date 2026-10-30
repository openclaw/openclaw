import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { SessionEntry as StoredSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ImageContent, Message, Model, TextContent } from "../llm/types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "./auth-profiles/external-cli-auth-selection.js";
import { createEmptyAuthProfileStore } from "./auth-profiles/runtime-snapshot-owner.js";
import { resolveSessionAuthSelection } from "./auth-profiles/session-override.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { reconcileAuthProfileQuotaBlocks } from "./auth-profiles/usage.js";
import { buildBtwCliPrompt, buildBtwSystemPrompt } from "./btw-prompts.js";
import { normalizeBtwContentBlocks } from "./btw-transcript.js";
import { executePreparedCliRun } from "./cli-runner/execute.runtime.js";
import { prepareCliRunContext } from "./cli-runner/prepare.runtime.js";
import { createNativeModelOwnedRuntimeModel } from "./defaults.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import {
  preparePluginHarnessToolPolicies,
  resolvePluginHarnessPolicyToolsAllow,
} from "./harness/execution-environment.js";
import { readSessionRuntimeOwnershipAsync } from "./harness/session-runtime-ownership.js";
import type {
  AgentHarness,
  AgentHarnessSessionRuntimeOwnership,
  AgentHarnessSideQuestionParamsV2,
} from "./harness/types.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import {
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
} from "./model-auth.js";
import { isOpenAIProvider } from "./openai-routing.js";
import {
  acquirePublishedPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
  type PreparedModelRuntimeStores,
} from "./prepared-model-runtime.js";
import { buildAgentRuntimeAuthPlan } from "./runtime-plan/auth.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";
import type { SandboxContext } from "./sandbox/types.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { sanitizeImageBlocks } from "./tool-images.js";
import { normalizeUsage, type NormalizedUsage } from "./usage.js";
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
  const loadStore = async (externalCliProviderIds?: readonly string[]) =>
    externalCliProviderIds
      ? await ensureAuthProfileStoreAsync(params.agentDir, {
          ...storeOptions,
          externalCliProviderIds,
        })
      : await ensureAuthProfileStoreWithoutExternalProfilesAsync(params.agentDir, storeOptions);
  let store: AuthProfileStore;
  let ignoreAutoPreferredProfile = false;
  if (isOpenAIProvider(model.provider)) {
    store = await loadStore(["openai"]);
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
    store = await loadStore(externalCliAuthScope.providerIds);
    if (!externalCliAuthScope.providerIds) {
      externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
        ...selection,
        store,
      });
      if (externalCliAuthScope.providerIds) {
        store = await loadStore(externalCliAuthScope.providerIds);
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
  return (
    isRecord(block) &&
    normalizeLowercaseStringOrEmpty(block.type) === "text" &&
    typeof block.text === "string"
  );
}

function isBtwImageBlock(block: unknown): block is ImageContent {
  return (
    isRecord(block) &&
    normalizeLowercaseStringOrEmpty(block.type) === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
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
  const rawContent: unknown = message.content;
  let content: TextContent[];
  if (typeof rawContent === "string") {
    const text = rawContent.trim();
    content = text ? [{ type: "text", text }] : [];
  } else {
    content = (normalizeBtwContentBlocks(rawContent) ?? []).flatMap((block): TextContent[] =>
      isBtwTextBlock(block) ? [{ type: "text", text: block.text }] : [],
    );
  }
  return content.length > 0 ? { ...message, content } : undefined;
}

export async function toSimpleContextMessages(params: {
  messages: unknown[];
  imageLimits: ImageSanitizationLimits;
}): Promise<Message[]> {
  const contextMessages: Message[] = [];
  for (const message of params.messages) {
    // Read the role without narrowing `message`; the casts below are from the transcript entry.
    const role = isRecord(message) ? message.role : undefined;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    // BTW is a no-tools path, so keep only user-visible blocks from prior
    // messages and strip hidden reasoning/tool replay data.
    let sanitizedMessage: Message | undefined;
    if (role === "user") {
      // SAFETY: transcript entries with role "user" are persisted user Messages; only content is read and replaced.
      const userMessage = message as Extract<Message, { role: "user" }>;
      sanitizedMessage = await sanitizeBtwUserMessage({
        message: userMessage,
        imageLimits: params.imageLimits,
      });
    } else {
      // SAFETY: transcript entries with role "assistant" are persisted assistant Messages; only content is read and replaced.
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
  assertCurrent?: () => void;
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
  nativeOwnership?: AgentHarnessSessionRuntimeOwnership;
}> {
  const preparedModelRuntime = params.preparedModelRuntime;
  const { config: cfg, agentDir, workspaceDir } = preparedModelRuntime;
  // Model, credentials, and tool policy must share the native owner's prepared tuple.
  const nativeOwnership = await readSessionRuntimeOwnershipAsync({ ...params, config: cfg });
  const modelRef = nativeOwnership?.modelRef ?? params;
  const { authStorage, modelRegistry } = preparedModelRuntime.createStores();
  if (nativeOwnership?.auth === "native") {
    const plan = buildAgentRuntimeAuthPlan({
      provider: modelRef.provider,
      modelId: modelRef.model,
      config: cfg,
      workspaceDir,
      metadataSnapshot: preparedModelRuntime.metadataSnapshot,
      harnessId: params.harnessId,
      allowHarnessAuthProfileForwarding: false,
    });
    return {
      model: createNativeModelOwnedRuntimeModel({
        provider: modelRef.provider,
        modelId: modelRef.model,
      }),
      authProfileStore: createEmptyAuthProfileStore(),
      runtimeAuthPreparation: { plan, attempts: [{ kind: "implicit", plan }] },
      authStorage,
      modelRegistry,
      nativeOwnership,
    };
  }
  const resolution = await resolveModelAsync(modelRef.provider, modelRef.model, agentDir, cfg, {
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
    throw new Error(resolution.error ?? `Unknown model: ${modelRef.provider}/${modelRef.model}`);
  }
  const runtimeProvider = model.provider;
  const runtimeModelId = model.id;

  const authSelection = await resolveSessionAuthSelection({
    cfg,
    provider: runtimeProvider,
    modelId: runtimeModelId,
    agentId: params.agentId,
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
    nativeOwnership,
  };
}

export type RunBtwSideQuestionParams = Omit<
  AgentHarnessSideQuestionParamsV2,
  | "hostCapabilities"
  | "sandbox"
  | "preparedModelRuntime"
  | "runtimeModel"
  | "preparedRuntimeAuth"
  | "expectedSessionRuntimeOwnership"
  | "preparedWebSearchPolicy"
  | "sessionId"
  | "sessionFile"
  | "agentId"
  | "workspaceDir"
  | "toolsAllow"
  | "authProfileId"
  | "authProfileIdSource"
> & {
  agentId: string;
  assertCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Background consumers collect usage without recording a user-facing reply. */
  onUsage?: (usage: NormalizedUsage | undefined) => void;
  /**
   * Set by gateway-hosted callers so the prepared runtime resolves the owner the
   * gateway published. Left unset by local callers such as the embedded TUI,
   * which must not borrow the active registry's subagent and node capabilities.
   */
  allowGatewaySubagentBinding?: boolean;
  /** Internal execution identity; never reuse a parent/correlation run id. */
  authorityRunId?: string;
};

export async function prepareBtwHarnessToolPolicies(
  params: RunBtwSideQuestionParams & {
    sessionId: string;
    runtimeModel: Model;
    nativeOwnership?: AgentHarnessSessionRuntimeOwnership;
    sandbox: SandboxContext | null;
  },
) {
  const policies = await preparePluginHarnessToolPolicies(
    {
      ...params,
      config: params.cfg,
      provider: params.runtimeModel.provider,
      modelId: params.runtimeModel.id,
    },
    undefined,
    undefined,
    params.nativeOwnership
      ? (params.nativeOwnership.modelRef ?? null)
      : { provider: params.runtimeModel.provider, model: params.runtimeModel.id },
  );
  return {
    toolsAllow: resolvePluginHarnessPolicyToolsAllow(policies),
    webSearchPolicy: policies.webSearchPolicy,
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
  onUsage?: (usage: NormalizedUsage | undefined) => void;
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
      prompt: buildBtwCliPrompt(params),
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
    params.onUsage?.(normalizeUsage(output.usage));
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
