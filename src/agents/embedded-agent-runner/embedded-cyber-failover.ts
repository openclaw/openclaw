import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { markFallbackCandidateSkipped } from "../fallback-skip-cache.js";
import type { FallbackAttempt } from "../model-fallback.types.js";
import type { ModelManifestNormalizationContext, ModelRef } from "../model-ref-shared.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../model-selection-resolve.js";
import { hasCommittedOutboundDeliveryEvidence } from "./delivery-evidence.js";
import { hasVisibleAgentPayload } from "./message-visibility.js";
import type { EmbeddedAgentRunResult } from "./types.js";

export const EMBEDDED_CYBER_FAILOVER_TRIGGER_CODE = "OPENAI_CYBER_POLICY_REFUSAL";

export type EmbeddedCyberFailoverConfig = {
  mode: "auto" | "off";
  model: string;
  cooloffMs: number;
};

const DEFAULT_EMBEDDED_CYBER_FAILOVER: EmbeddedCyberFailoverConfig = {
  mode: "auto",
  model: "openai/gpt-daybreak-blue-latest",
  cooloffMs: 600_000,
};

export function resolveEmbeddedCyberFailoverConfig(
  cfg: OpenClawConfig | undefined,
): EmbeddedCyberFailoverConfig {
  const configured = cfg?.agents?.defaults?.embeddedAgent?.cyberFailover;
  return {
    mode: configured?.mode ?? DEFAULT_EMBEDDED_CYBER_FAILOVER.mode,
    model: configured?.model ?? DEFAULT_EMBEDDED_CYBER_FAILOVER.model,
    cooloffMs: configured?.cooloffMs ?? DEFAULT_EMBEDDED_CYBER_FAILOVER.cooloffMs,
  };
}

export function resolveEmbeddedCyberFailoverTarget(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    raw: string;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const modelContext = {
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: "openai",
    manifestPlugins: params.manifestPlugins,
  };
  const aliasIndex = buildModelAliasIndex(modelContext);
  return (
    resolveModelRefFromString({
      ...modelContext,
      raw: params.raw,
      aliasIndex,
    })?.ref ?? null
  );
}

export function isReplaySafeEmbeddedOpenAiCyberRefusal(params: {
  provider: string;
  result: EmbeddedAgentRunResult;
}): boolean {
  const refusal = params.result.meta.agentMeta?.providerRefusal;
  return (
    params.provider === "openai" &&
    params.result.meta.agentMeta?.agentHarnessId === "openclaw" &&
    params.result.meta.replayInvalid !== true &&
    refusal?.provider === "openai" &&
    refusal.category === "cyber"
  );
}

// An explicit empty fallback override locks selection, including policy escalation.
export function isEmbeddedModelSelectionStrict(selection: {
  fallbacksOverride?: readonly string[];
}): boolean {
  return selection.fallbacksOverride !== undefined && selection.fallbacksOverride.length === 0;
}

export function isEmbeddedCyberFailoverTargetUsable(result: EmbeddedAgentRunResult): boolean {
  const hasErrorPayload = (result.payloads ?? []).some((payload) => payload.isError === true);
  return (
    result.meta.aborted !== true &&
    result.meta.error === undefined &&
    result.meta.agentMeta?.providerRefusal === undefined &&
    (!hasErrorPayload ||
      hasVisibleAgentPayload(result, {
        includeErrorPayloads: false,
        includeReasoningPayloads: false,
        includeSilentReplyPayloads: false,
      }))
  );
}

// A replay-safe initial refusal says nothing about the retry's committed work.
// Keep that retry's evidence instead of replacing it with the original refusal.
export function didEmbeddedCyberFailoverTargetCommitWork(result: EmbeddedAgentRunResult): boolean {
  return result.meta.replayInvalid === true || hasCommittedOutboundDeliveryEvidence(result);
}

export function recordEmbeddedCyberFailoverTargetUnavailable(params: {
  sessionId: string;
  target: ModelRef;
  authScope?: string;
  attempts: readonly FallbackAttempt[];
  cooloffMs: number;
}): void {
  const authFailure = params.attempts.findLast(
    (attempt) => attempt.reason === "auth" || attempt.reason === "auth_permanent",
  );
  if (!authFailure) {
    return;
  }
  markFallbackCandidateSkipped({
    sessionId: params.sessionId,
    provider: params.target.provider,
    model: params.target.model,
    authScope: params.authScope,
    reason: authFailure.reason ?? "auth",
    ttlMs: params.cooloffMs,
  });
}
