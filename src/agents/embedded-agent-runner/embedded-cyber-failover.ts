import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isFallbackCandidateSkipped,
  markFallbackCandidateSkipped,
} from "../fallback-skip-cache.js";
import type { FallbackAttempt } from "../model-fallback.types.js";
import type { ModelManifestNormalizationContext, ModelRef } from "../model-ref-shared.js";
import { modelKey } from "../model-ref-shared.js";
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
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: "openai",
    manifestPlugins: params.manifestPlugins,
  });
  return (
    resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw: params.raw,
      defaultProvider: "openai",
      aliasIndex,
      manifestPlugins: params.manifestPlugins,
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

/**
 * True when the caller pinned this turn to exactly one model. `run-embedded-attempt`
 * passes an explicit empty fallback override for a locked model selection, and
 * `docs/concepts/model-failover.md` documents that as strict: no other model may
 * serve the turn. Policy escalation honors that contract, so a locked session
 * keeps a cyber refusal terminal until the operator unlocks the selection.
 */
export function isEmbeddedModelSelectionStrict(selection: {
  fallbacksOverride?: readonly string[];
}): boolean {
  return selection.fallbacksOverride !== undefined && selection.fallbacksOverride.length === 0;
}

export function isSameEmbeddedCyberFailoverTarget(current: ModelRef, target: ModelRef): boolean {
  return modelKey(current.provider, current.model) === modelKey(target.provider, target.model);
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

/**
 * True when a failed escalation attempt already committed work that the caller
 * must still see. A replay-safe initial refusal says nothing about the retry:
 * the retry runs the same turn with tools enabled, so it can execute a tool or
 * deliver output and only then error out. Restoring the original refusal
 * wholesale in that case would drop the retry's replay verdict, delivery
 * evidence, and terminal receipt, and would tell recovery consumers that
 * nothing ran.
 */
export function didEmbeddedCyberFailoverTargetCommitWork(result: EmbeddedAgentRunResult): boolean {
  return result.meta.replayInvalid === true || hasCommittedOutboundDeliveryEvidence(result);
}

export function isEmbeddedCyberFailoverTargetSkipped(params: {
  sessionId: string;
  target: ModelRef;
  authScope?: string;
}): boolean {
  return isFallbackCandidateSkipped({
    sessionId: params.sessionId,
    provider: params.target.provider,
    model: params.target.model,
    authScope: params.authScope,
  });
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
