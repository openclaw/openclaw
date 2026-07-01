/**
 * Resolves per-attempt runtime decisions from config and channel context.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  isNativeWebSearchAllowedByToolPolicy,
  resolveCodexNativeSearchActivation,
  type NativeWebSearchToolPolicyParams,
} from "../../codex-native-web-search-core.js";
import {
  resolveSessionLockMaxHoldFromTimeout,
  resolveSessionWriteLockOptions,
} from "../../session-write-lock.js";
import type { PromptMode } from "../../system-prompt.types.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type ProviderNativeToolPolicyContext = Omit<
  NativeWebSearchToolPolicyParams,
  "agentId" | "config" | "modelId" | "modelProvider"
>;

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isOpenAIApiBaseUrlForNativeSearch(baseUrl: unknown): boolean {
  const trimmed = readStringValue(baseUrl)?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

function isOpenAIResponsesNativeSearchEligibleModel(params: {
  model: { api?: unknown; provider?: unknown; baseUrl?: unknown };
}): boolean {
  const provider = readStringValue(params.model.provider);
  if (
    params.model.api !== "openai-responses" ||
    !provider ||
    normalizeProviderId(provider) !== "openai"
  ) {
    return false;
  }
  const baseUrl = readStringValue(params.model.baseUrl);
  return !baseUrl || isOpenAIApiBaseUrlForNativeSearch(baseUrl);
}

function shouldUseOpenAIResponsesNativeSearchProvider(config: OpenClawConfig | undefined): boolean {
  const provider = config?.tools?.web?.search?.provider;
  if (typeof provider !== "string") {
    return true;
  }
  const normalized = normalizeProviderId(provider);
  return normalized === "" || normalized === "auto" || normalized === "openai";
}

function isOpenAIResponsesNativeSearchActive(params: {
  agentId?: string;
  config?: OpenClawConfig;
  model: { api?: unknown; id?: unknown; provider?: unknown; baseUrl?: unknown };
  nativeWebSearchPolicyContext?: ProviderNativeToolPolicyContext;
}): boolean {
  const modelProvider = readStringValue(params.model.provider);
  return (
    params.config?.tools?.web?.search?.enabled !== false &&
    shouldUseOpenAIResponsesNativeSearchProvider(params.config) &&
    isOpenAIResponsesNativeSearchEligibleModel({ model: params.model }) &&
    isNativeWebSearchAllowedByToolPolicy({
      config: params.config,
      modelProvider,
      modelId: readStringValue(params.model.id),
      agentId: params.agentId,
      ...(params.nativeWebSearchPolicyContext ?? {}),
    })
  );
}

export function countProviderNativeToolsForPrecheck(params: {
  agentId?: string;
  agentDir?: string;
  config?: OpenClawConfig;
  model: { api?: unknown; id?: unknown; provider?: unknown; baseUrl?: unknown };
  nativeWebSearchPolicyContext?: ProviderNativeToolPolicyContext;
}): number {
  const activation = resolveCodexNativeSearchActivation({
    config: params.config,
    modelProvider: readStringValue(params.model.provider),
    modelApi: readStringValue(params.model.api),
    modelId: readStringValue(params.model.id),
    agentId: params.agentId,
    agentDir: params.agentDir,
    ...(params.nativeWebSearchPolicyContext ?? {}),
  });
  return (
    (activation.state === "native_active" ? 1 : 0) +
    (isOpenAIResponsesNativeSearchActive(params) ? 1 : 0)
  );
}

export function resolveAttemptPromptModeAndSkillsPrompt(params: {
  promptMode: PromptMode;
  skillsPrompt?: string;
  toolsAllow?: readonly string[];
}): { promptMode: PromptMode; skillsPrompt?: string } {
  const hasRuntimeToolAllowlist = params.toolsAllow !== undefined;
  const hasNamedRuntimeToolAllowlist = (params.toolsAllow?.length ?? 0) > 0;
  return {
    promptMode: hasRuntimeToolAllowlist ? "minimal" : params.promptMode,
    ...(!hasNamedRuntimeToolAllowlist && params.skillsPrompt !== undefined
      ? { skillsPrompt: params.skillsPrompt }
      : {}),
  };
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
