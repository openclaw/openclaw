import type { OpenClawConfig } from "../../../config/config.js";
import type {
  PluginHookAgentEndEvent,
  PluginHookLlmOutputEvent,
} from "../../../plugins/hook-types.js";
import {
  resolveSessionLockMaxHoldFromTimeout,
  resolveSessionWriteLockOptions,
} from "../../session-write-lock.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import type { NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function resolveEmbeddedAttemptSessionWriteLockOptions(params: {
  config?: OpenClawConfig;
  compactionTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): { timeoutMs: number; staleMs: number; maxHoldMs: number } {
  // Bound embedded-attempt lock holds to the compaction window, not the full run timeout.
  // With defaults this permits roughly 900s compaction time plus the shared 120s
  // timeout grace before the watchdog releases a stuck live-process lock.
  return resolveSessionWriteLockOptions(params.config, {
    env: params.env,
    maxHoldMsFallback: resolveSessionLockMaxHoldFromTimeout({
      timeoutMs: params.compactionTimeoutMs,
    }),
  });
}

export function resolveAttemptStreamAuthProfileId(
  params: Pick<EmbeddedRunAttemptParams, "authProfileId" | "runtimePlan">,
): string | undefined {
  return params.runtimePlan?.auth.forwardedAuthProfileId;
}

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

export function shouldRunLlmOutputHooksForAttempt(params: { promptErrorSource: string | null }) {
  return params.promptErrorSource !== "hook:before_agent_run";
}

export function selectHookRunnerForHook<
  THookRunner extends { hasHooks(hookName: string): boolean } | null | undefined,
>(params: {
  primary: THookRunner;
  current: THookRunner;
  hookName: string;
}): THookRunner | undefined {
  if (params.primary?.hasHooks(params.hookName)) {
    return params.primary;
  }
  if (params.current?.hasHooks(params.hookName)) {
    return params.current;
  }
  return undefined;
}

export function buildEmbeddedAttemptLlmOutputHookEvent(
  params: Pick<
    EmbeddedRunAttemptParams,
    "runId" | "sessionId" | "provider" | "modelId" | "prompt" | "contextWindowInfo" | "runtimePlan"
  > & {
    assistantTexts: string[];
    lastAssistant?: unknown;
    usage?: NormalizedUsage;
  },
): PluginHookLlmOutputEvent {
  return {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    prompt: params.prompt,
    ...(params.contextWindowInfo?.tokens
      ? { contextTokenBudget: params.contextWindowInfo.tokens }
      : {}),
    ...(params.contextWindowInfo?.source
      ? { contextWindowSource: params.contextWindowInfo.source }
      : {}),
    ...(params.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens }
      : {}),
    resolvedRef:
      params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
    ...(params.runtimePlan?.observability.harnessId
      ? { harnessId: params.runtimePlan.observability.harnessId }
      : {}),
    assistantTexts: params.assistantTexts,
    ...(params.lastAssistant ? { lastAssistant: params.lastAssistant } : {}),
    ...(params.usage ? { usage: params.usage } : {}),
  };
}

export function buildEmbeddedAttemptAgentEndHookEvent(params: {
  messages: unknown[];
  prompt: string;
  assistantTexts: readonly string[];
  lastAssistant?: unknown;
  success: boolean;
  error?: string;
  durationMs: number;
}): PluginHookAgentEndEvent {
  return {
    messages: params.messages,
    prompt: params.prompt,
    assistantTexts: [...params.assistantTexts],
    ...(params.lastAssistant ? { lastAssistant: params.lastAssistant } : {}),
    success: params.success,
    ...(params.error ? { error: params.error } : {}),
    durationMs: params.durationMs,
  };
}

export function resolveAttemptToolPolicyMessageProvider(params: {
  messageProvider?: string;
  messageChannel?: string;
}): string | undefined {
  return params.messageProvider ?? params.messageChannel;
}
