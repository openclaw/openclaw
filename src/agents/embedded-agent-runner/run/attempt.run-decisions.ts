import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
/**
 * Resolves per-attempt runtime decisions from config and channel context.
 */
import type { OpenClawConfig } from "../../../config/config.js";
import {
  resolveSessionLockMaxHoldFromTimeout,
  resolveSessionWriteLockOptions,
} from "../../session-write-lock.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import { resolveWebSearchToolPolicy } from "../../web-search-tool-policy.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type ProviderNativeToolPolicyContext = Omit<
  Parameters<typeof resolveWebSearchToolPolicy>[0],
  "agentId" | "config" | "modelId" | "modelProvider"
>;

function shouldUseOpenAINativeWebSearchProvider(config: OpenClawConfig | undefined): boolean {
  const provider = config?.tools?.web?.search?.provider;
  if (typeof provider !== "string") {
    return true;
  }
  const normalized = provider.trim().toLowerCase();
  return normalized === "" || normalized === "auto" || normalized === "openai";
}

function isOpenAIResponsesNativeWebSearchEligibleModel(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  if (model.api !== "openai-responses" || !provider || normalizeProviderId(provider) !== "openai") {
    return false;
  }
  const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl.trim() : undefined;
  return !baseUrl || /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(baseUrl);
}

export function countProviderNativeToolsForPrecheck(params: {
  agentId?: string;
  config?: OpenClawConfig;
  model: { api?: unknown; id?: unknown; provider?: unknown; baseUrl?: unknown };
  nativeWebSearchPolicyContext?: ProviderNativeToolPolicyContext;
}): number {
  if (
    params.config?.tools?.web?.search?.enabled === false ||
    !shouldUseOpenAINativeWebSearchProvider(params.config) ||
    !isOpenAIResponsesNativeWebSearchEligibleModel(params.model)
  ) {
    return 0;
  }

  if (
    params.nativeWebSearchPolicyContext &&
    !resolveWebSearchToolPolicy({
      config: params.config,
      modelProvider: typeof params.model.provider === "string" ? params.model.provider : undefined,
      modelId: typeof params.model.id === "string" ? params.model.id : undefined,
      agentId: params.agentId,
      ...params.nativeWebSearchPolicyContext,
    }).allowed
  ) {
    return 0;
  }

  return 1;
}

/**
 * Builds the session write-lock timing for a live embedded attempt. The lock is
 * capped by compaction time because cleanup may keep writing after model abort,
 * but should not inherit the much larger full run timeout.
 */
export function resolveEmbeddedAttemptSessionWriteLockOptions(params: {
  config?: OpenClawConfig;
  compactionTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): { timeoutMs: number; staleMs: number; maxHoldMs: number } {
  // Bound embedded-attempt lock holds to the compaction window, not the full run timeout.
  // With defaults this permits roughly 180s compaction time plus the shared 120s
  // timeout grace before the watchdog releases a stuck live-process lock.
  return resolveSessionWriteLockOptions(params.config, {
    env: params.env,
    maxHoldMsFallback: resolveSessionLockMaxHoldFromTimeout({
      timeoutMs: params.compactionTimeoutMs,
    }),
  });
}

/**
 * Returns the auth profile id that should be attached to model-stream
 * provenance. Only runtime-forwarded ids are exposed; raw request auth ids can
 * represent local caller state rather than provider-visible credentials.
 */
export function resolveAttemptStreamAuthProfileId(
  params: Pick<EmbeddedRunAttemptParams, "authProfileId" | "runtimePlan">,
): string | undefined {
  return params.runtimePlan?.auth.forwardedAuthProfileId;
}

/**
 * Resolves the consecutive unknown-tool threshold for the provider stream
 * guard. The guard remains active even when generic loop detection is disabled
 * because an unregistered tool call is an objective dead end for this run.
 */
export function resolveUnknownToolGuardThreshold(loopDetection?: {
  enabled?: boolean;
  unknownToolThreshold?: number;
}): number {
  // The unknown-tool guard is a safety net against the model hallucinating a
  // tool name or calling a tool that has since been removed from the allowlist
  // (for example after a `skills.allowBundled` config change). After `threshold`
  // consecutive unknown-tool attempts the stream wrapper rewrites the assistant
  // message content to tell the model to stop, which breaks otherwise-infinite
  // Tool-not-found loops against the provider. Unlike the genericRepeat /
  // pingPong / pollNoProgress detectors this guard has no false-positive
  // surface because the tool is objectively not registered in this run, so it
  // stays on regardless of `tools.loopDetection.enabled`.
  const raw = loopDetection?.unknownToolThreshold;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return UNKNOWN_TOOL_THRESHOLD;
}

/**
 * Skips `llm_output` hooks only when `before_agent_run` blocked the prompt
 * before any model submission; later prompt errors can still have model output
 * or tool state that downstream hooks need to observe.
 */
export function shouldRunLlmOutputHooksForAttempt(params: { promptErrorSource: string | null }) {
  return params.promptErrorSource !== "hook:before_agent_run";
}

/**
 * Chooses the provider label used by tool-policy messages. Message providers
 * are more specific than transport channels, while channel remains the fallback
 * for older callers that do not split those concepts.
 */
export function resolveAttemptToolPolicyMessageProvider(params: {
  messageProvider?: string;
  messageChannel?: string;
}): string | undefined {
  return params.messageProvider ?? params.messageChannel;
}
