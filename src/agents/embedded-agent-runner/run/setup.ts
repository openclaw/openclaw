import { resolveOpenAIResponsesRequestContextTokens } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { withGuardedFetchRequestAuthority } from "../../../infra/net/fetch-request-authority.js";
import { readClaimingHookAdmission } from "../../../plugins/hook-claim-admission.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type {
  PluginHookBeforeModelResolveAttachment,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
} from "../../../plugins/types.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  resolveAgentHarnessSessionStoreEntryError,
  resolveSessionPinnedHarnessId,
} from "../../../sessions/agent-harness-session-key.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { normalizeOptionalAgentRuntimeId } from "../../agent-runtime-id.js";
import {
  evaluateContextWindowGuard,
  formatContextWindowBlockMessage,
  formatContextWindowWarningMessage,
  resolveContextWindowInfo,
  type ContextWindowInfo,
} from "../../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { FailoverError } from "../../failover-error.js";
import { AgentHarnessPreflightError } from "../../harness/errors.js";
import { resolveModelContextWindowProfile } from "../../model-context-window.js";
import { readModelServingContextWindow } from "../../model-serving-context.js";
import { log } from "../logger.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";

type HookRunnerLike = Pick<
  NonNullable<ReturnType<typeof getGlobalHookRunner>>,
  "hasHooks" | "runBeforeModelResolve"
>;
type HookContext = Parameters<HookRunnerLike["runBeforeModelResolve"]>[1];

type ModelRoutingAuthority = {
  hookContext: HookContext;
  assertCurrent?: () => void;
  runAuthority?: Pick<
    RunEmbeddedAgentInternalParams,
    "abortSignal" | "preparedRunAdmission" | "admittedRunContext" | "lifecycleGeneration"
  >;
};

function captureModelRoutingAssertion(params: ModelRoutingAuthority) {
  const source = params.runAuthority;
  source?.abortSignal?.throwIfAborted();
  const instance = source?.preparedRunAdmission?.operationalRunInstance;
  const previousOwner = instance
    ? getAgentRunContext(instance.runId)?.delegatedAuthority
    : undefined;
  const assertHookCurrent = readClaimingHookAdmission(params.hookContext)?.assertCurrent;
  const assertAdmitted = source?.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(source.admittedRunContext, source.abortSignal)
    : undefined;
  return () => {
    source?.abortSignal?.throwIfAborted();
    params.assertCurrent?.();
    assertHookCurrent?.();
    if (source?.lifecycleGeneration) {
      assertAgentRunLifecycleGenerationCurrent(source.lifecycleGeneration);
    }
    try {
      source?.preparedRunAdmission?.assertSourceCurrent();
      source?.preparedRunAdmission?.assertCurrent();
      if (source?.admittedRunContext) {
        if (!assertAdmitted) {
          throw new Error("admitted run authority is no longer active");
        }
        assertAdmitted();
      }
      if (instance) {
        const owner = getAgentRunContext(instance.runId)?.delegatedAuthority;
        // An unrelated previous owner may finish while this source is still preparing admission.
        if (
          owner &&
          owner !== previousOwner &&
          owner.operationalRunInstance.instanceId !== instance.instanceId
        ) {
          throw new Error("model routing run authority changed");
        }
      }
    } catch (cause) {
      // Changing providers cannot restore a canceled or superseded source.
      throw new AgentHarnessPreflightError("Model routing source is no longer active.", { cause });
    }
  };
}

/** Durable harness sessions run only with their exact persisted identity and runtime lock. */
export function resolveAgentHarnessRunAdmissionError(params: {
  agentHarnessId?: string;
  entry?: SessionEntry;
  modelSelectionLocked?: boolean;
  sessionId: string;
  sessionKey?: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const entry = params.entry;
  const reservedKey = isAgentHarnessSessionKey(sessionKey);
  if (!entry) {
    return reservedKey ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE : undefined;
  }
  // Rows created before harness supervision could already use this prefix. Only the
  // durable lock makes an existing row harness-owned; missing reserved keys stay closed.
  if (entry.modelSelectionLocked !== true) {
    return undefined;
  }
  if (!isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
    return resolveAgentHarnessSessionStoreEntryError(sessionKey, entry);
  }
  const requestedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const durableHarnessId = resolveSessionPinnedHarnessId(entry);
  const matchesRequestedRuntime =
    params.modelSelectionLocked === true && requestedHarnessId === durableHarnessId;
  const matchesDurableRuntime =
    entry.sessionId === params.sessionId && durableHarnessId !== undefined;
  return matchesRequestedRuntime && matchesDurableRuntime
    ? undefined
    : reservedKey
      ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
      : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE;
}

/**
 * Runs model-selection hooks before resolving the runtime model.
 */
export async function resolveHookModelSelection(
  params: ModelRoutingAuthority & {
    prompt: string;
    onDispatch?: () => void;
    attachments?: PluginHookBeforeModelResolveAttachment[];
    provider: string;
    modelId: string;
    modelSelectionLocked?: boolean;
    awaitSessionDiffBaseline?: () => Promise<void>;
    hookRunner?: HookRunnerLike | null;
  },
) {
  const selection: { provider: string; modelId: string } & Pick<
    PluginHookBeforeModelResolveResult,
    "fallbacksOverride"
  > = {
    provider: params.provider,
    modelId: params.modelId,
  };
  if (params.modelSelectionLocked === true) {
    return selection;
  }
  let modelResolveOverride: Awaited<ReturnType<HookRunnerLike["runBeforeModelResolve"]>>;
  const hookRunner = params.hookRunner;

  // Run before_model_resolve hooks early so plugins can override the
  // provider/model before resolveModel().
  if (hookRunner?.hasHooks("before_model_resolve")) {
    const assertCurrent = captureModelRoutingAssertion(params);
    assertCurrent();
    await params.awaitSessionDiffBaseline?.();
    assertCurrent();
    try {
      const event: PluginHookBeforeModelResolveEvent = params.attachments
        ? { prompt: params.prompt, attachments: params.attachments }
        : { prompt: params.prompt };
      const run = () => {
        // A registered hook can commit work before native target preparation starts.
        if (hookRunner.hasHooks("before_model_resolve")) {
          params.onDispatch?.();
        }
        return hookRunner.runBeforeModelResolve(event, params.hookContext);
      };
      modelResolveOverride = await withGuardedFetchRequestAuthority(assertCurrent, run);
    } catch (hookErr) {
      log.warn(`before_model_resolve hook failed: ${String(hookErr)}`);
    }
    assertCurrent();
  }

  if (modelResolveOverride?.providerOverride) {
    selection.provider = normalizeProviderId(modelResolveOverride.providerOverride);
    log.info(`[hooks] provider overridden to ${selection.provider}`);
  }
  if (modelResolveOverride?.modelOverride) {
    selection.modelId = modelResolveOverride.modelOverride;
    log.info(`[hooks] model overridden to ${selection.modelId}`);
  }
  if (modelResolveOverride?.fallbacksOverride !== undefined) {
    selection.fallbacksOverride = modelResolveOverride.fallbacksOverride;
  }

  return selection;
}

/**
 * Converts prompt image refs into the minimal attachment shape exposed to
 * before-model-resolve hooks. Empty image lists stay undefined so hook payloads
 * do not grow a meaningless attachments field.
 */
export function buildBeforeModelResolveAttachments(
  images: readonly { mimeType?: string }[] | undefined,
): PluginHookBeforeModelResolveAttachment[] | undefined {
  if (!images?.length) {
    return undefined;
  }
  return images.map((img) => ({
    kind: "image",
    mimeType: img.mimeType,
  }));
}

/** Resolve host policy without inferring a native owner's private context capacity. */
export function resolveEmbeddedRuntimeModelPolicy(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  contextConfigProvider?: string;
  modelId: string;
  runtimeModel: ProviderRuntimeModel;
  nativeModelOwned: boolean;
  /** Explicit model policy on an ordinary host-owned run, never a supervised session. */
  authoredContextTokenCap?: number;
  contextWindow?: string;
  contextTokenBudget?: number;
  requestExtraParams?: Record<string, unknown>;
  requestServiceTiers?: readonly string[];
}): {
  contextWindowInfo?: ContextWindowInfo;
  contextTokenBudget?: number;
  contextTokensSource?: "resolved-v1";
  effectiveModel: ProviderRuntimeModel;
} {
  if (params.nativeModelOwned && params.authoredContextTokenCap === undefined) {
    return { effectiveModel: params.runtimeModel };
  }
  // The session-selected context-window option caps native runs too; the CLI
  // backend maps the option id to argv/env separately, but budget and payload
  // sizing must honor the selection on every runtime path.
  const contextWindowProfile = resolveModelContextWindowProfile({
    catalogEntry: params.runtimeModel,
    selected: params.contextWindow,
  });
  const servingContextWindow = readModelServingContextWindow(params.runtimeModel);
  const resolvedCtxInfo = resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.contextConfigProvider ?? params.provider,
    modelId: params.modelId,
    modelContextTokens: asFiniteNumber(params.runtimeModel.contextTokens),
    modelServingContextWindow: servingContextWindow,
    modelContextWindow: contextWindowProfile.contextTokens,
    modelContextWindowSource: contextWindowProfile.contextWindow
      ? undefined
      : params.runtimeModel.contextWindowSource,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  // resolveContextWindowInfo ranks the passed selection below both the
  // discovered model cap and models.providers.*.models[].contextTokens, so a
  // 200k session would keep budgeting against the wider window. Only an
  // effective option caps here; the bare catalog scalar stays subordinate.
  const ctxInfo =
    contextWindowProfile.contextWindow &&
    contextWindowProfile.contextTokens !== undefined &&
    resolvedCtxInfo.tokens > contextWindowProfile.contextTokens
      ? { ...resolvedCtxInfo, tokens: contextWindowProfile.contextTokens, source: "model" as const }
      : resolvedCtxInfo;

  const ctxGuard = evaluateContextWindowGuard({ info: ctxInfo });
  const runtimeBaseUrl = params.runtimeModel.baseUrl;
  if (ctxGuard.shouldWarn) {
    log.warn(
      formatContextWindowWarningMessage({
        provider: params.provider,
        modelId: params.modelId,
        guard: ctxGuard,
        runtimeBaseUrl,
      }),
    );
  }
  if (ctxGuard.shouldBlock) {
    const message = formatContextWindowBlockMessage({
      guard: ctxGuard,
      runtimeBaseUrl,
    });
    log.error(
      `blocked model (context window too small): ${params.provider}/${params.modelId} ctx=${ctxGuard.tokens} (min=${ctxGuard.hardMinTokens}) source=${ctxGuard.source}; ${message}`,
    );
    throw new FailoverError(message, {
      reason: "unknown",
      provider: params.provider,
      model: params.modelId,
    });
  }

  const contextTokenBudget = Math.min(
    ctxInfo.tokens,
    params.contextTokenBudget ?? ctxInfo.tokens,
    params.nativeModelOwned
      ? Infinity
      : (resolveOpenAIResponsesRequestContextTokens(
          params.runtimeModel,
          params.requestExtraParams,
          params.requestServiceTiers,
        ) ?? Infinity),
  );
  const contextWindowInfo =
    contextTokenBudget < ctxInfo.tokens
      ? {
          ...ctxInfo,
          tokens: contextTokenBudget,
          referenceTokens: ctxInfo.referenceTokens ?? ctxInfo.tokens,
        }
      : ctxInfo;
  const effectiveModel =
    !params.nativeModelOwned && contextTokenBudget < (params.runtimeModel.contextWindow ?? Infinity)
      ? { ...params.runtimeModel, contextWindow: contextTokenBudget }
      : params.runtimeModel;
  return {
    contextWindowInfo,
    contextTokenBudget,
    // Cold readers match only provider/model/harness, so removable caps and
    // session-selectable windows cannot become persisted model facts.
    contextTokensSource:
      !params.nativeModelOwned &&
      servingContextWindow === undefined &&
      contextWindowInfo.source === "model" &&
      contextWindowInfo.referenceTokens === undefined &&
      !params.runtimeModel.contextWindows?.length
        ? "resolved-v1"
        : undefined,
    effectiveModel,
  };
}
