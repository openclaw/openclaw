import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
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
import { resolveModelContextWindowProfile } from "../../model-context-window.js";
import { log } from "../logger.js";

type HookRunnerLike = Pick<
  NonNullable<ReturnType<typeof getGlobalHookRunner>>,
  "hasHooks" | "runBeforeModelResolve"
>;
type HookContext = Parameters<HookRunnerLike["runBeforeModelResolve"]>[1];

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
export async function resolveHookModelSelection(params: {
  prompt: string;
  attachments?: PluginHookBeforeModelResolveAttachment[];
  provider: string;
  modelId: string;
  modelSelectionLocked?: boolean;
  hookRunner?: HookRunnerLike | null;
  hookContext: HookContext;
}) {
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
    const assertCurrent = readClaimingHookAdmission(params.hookContext)?.assertCurrent;
    assertCurrent?.();
    try {
      const event: PluginHookBeforeModelResolveEvent = params.attachments
        ? { prompt: params.prompt, attachments: params.attachments }
        : { prompt: params.prompt };
      const run = () => hookRunner.runBeforeModelResolve(event, params.hookContext);
      modelResolveOverride = assertCurrent
        ? await withGuardedFetchRequestAuthority(assertCurrent, run)
        : await run();
    } catch (hookErr) {
      log.warn(`before_model_resolve hook failed: ${String(hookErr)}`);
    }
    assertCurrent?.();
  }

  if (modelResolveOverride?.providerOverride) {
    selection.provider = modelResolveOverride.providerOverride;
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

/** Resolves only OpenClaw-owned context policy; native model owners keep that policy private. */
export function resolveEmbeddedRuntimeModelPolicy(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  contextConfigProvider?: string;
  modelId: string;
  runtimeModel: ProviderRuntimeModel;
  nativeModelOwned: boolean;
  contextWindow?: string;
  contextTokenBudget?: number;
}): {
  contextWindowInfo?: ContextWindowInfo;
  contextTokenBudget?: number;
  contextTokensSource?: "resolved-v1";
  effectiveModel: ProviderRuntimeModel;
} {
  if (params.nativeModelOwned) {
    return { effectiveModel: params.runtimeModel };
  }
  // The session-selected context-window option caps native runs too; the CLI
  // backend maps the option id to argv/env separately, but budget and payload
  // sizing must honor the selection on every runtime path.
  const contextWindowProfile = resolveModelContextWindowProfile({
    catalogEntry: params.runtimeModel,
    selected: params.contextWindow,
  });
  const resolvedCtxInfo = resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.contextConfigProvider ?? params.provider,
    modelId: params.modelId,
    modelContextTokens: asFiniteNumber(params.runtimeModel.contextTokens),
    modelContextWindow: contextWindowProfile.contextTokens,
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

  const contextTokenBudget = Math.min(ctxInfo.tokens, params.contextTokenBudget ?? ctxInfo.tokens);
  const contextWindowInfo =
    contextTokenBudget < ctxInfo.tokens
      ? {
          ...ctxInfo,
          tokens: contextTokenBudget,
          referenceTokens: ctxInfo.referenceTokens ?? ctxInfo.tokens,
        }
      : ctxInfo;
  const effectiveModel =
    contextTokenBudget < (params.runtimeModel.contextWindow ?? Infinity)
      ? { ...params.runtimeModel, contextWindow: contextTokenBudget }
      : params.runtimeModel;
  return {
    contextWindowInfo,
    contextTokenBudget,
    // Cold readers match only provider/model/harness, so removable caps and
    // session-selectable windows cannot become persisted model facts.
    contextTokensSource:
      contextWindowInfo.source === "model" &&
      contextWindowInfo.referenceTokens === undefined &&
      !params.runtimeModel.contextWindows?.length
        ? "resolved-v1"
        : undefined,
    effectiveModel,
  };
}
