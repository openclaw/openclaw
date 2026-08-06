/**
 * Pure admission gate for the bounded recovery-path memory flush.
 *
 * Split from the recovery flush executor so the decision surface is unit-testable
 * without dragging in the maintenance-run machinery.
 */
import { resolveContextTokensForModel } from "../../../agents/context.js";
import {
  resolveSandboxConfigForAgent,
  resolveSandboxRuntimeStatus,
} from "../../../agents/sandbox.js";
import { hasAlreadyFlushedForCurrentCompaction } from "../../../auto-reply/reply/memory-flush.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { MemoryFlushPlan } from "../../../plugins/registry-contribution-types.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import type { EmbeddedRunTrigger } from "./params.js";

export type RecoveryMemoryFlushOutcome =
  | { action: "flushed" }
  | { action: "skipped"; reason: string };

type RecoveryMemoryFlushDecision =
  | {
      action: "flush";
      provider: string;
      model: string;
      contextWindowTokens: number;
    }
  | { action: "skip"; reason: string };

type RecoveryMemoryFlushDecisionInput = {
  cfg: OpenClawConfig;
  /** Transcript session key — used for incognito detection. */
  sessionKey?: string;
  /**
   * Runtime sandbox policy key (sandboxSessionKey). When present, this is the
   * identity the sandbox writability gate must evaluate; direct-message policy
   * deliberately separates it from the transcript sessionKey. Falls back to
   * sessionKey to preserve the no-policy-key behavior.
   */
  sandboxPolicySessionKey?: string;
  agentId?: string;
  provider: string;
  modelId: string;
  trigger?: EmbeddedRunTrigger;
  plan: MemoryFlushPlan | null;
  entry?: SessionEntry | null;
  observedOverflowTokens?: number;
  contextTokenBudget?: number;
};

/**
 * Decides whether a recovery-path memory flush may run. Pure gate: mirrors the
 * proactive flush gates (plan present, writable sandbox, not incognito, not
 * heartbeat, not already flushed for this compaction cycle) and adds the
 * bounded-checkpoint admission check against the flush model's context window.
 */
export function resolveRecoveryMemoryFlushDecision(
  params: RecoveryMemoryFlushDecisionInput,
): RecoveryMemoryFlushDecision {
  const { cfg, sessionKey, plan } = params;
  if (!plan) {
    return { action: "skip", reason: "no_memory_flush_plan" };
  }
  if (params.trigger === "heartbeat") {
    return { action: "skip", reason: "heartbeat_turn" };
  }
  if (params.entry?.incognito === true || (sessionKey && isIncognitoSessionKey(sessionKey))) {
    return { action: "skip", reason: "incognito_session" };
  }

  // The proactive path only flushes when the sandboxed workspace is writable.
  // Evaluate the runtime sandbox policy key (sandboxSessionKey) when present;
  // direct-message policy deliberately separates it from the transcript key.
  const runtime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: params.sandboxPolicySessionKey ?? sessionKey,
    agentId: params.agentId,
  });
  if (runtime.sandboxed) {
    const sandboxCfg = resolveSandboxConfigForAgent(cfg, runtime.agentId);
    if (sandboxCfg.workspaceAccess !== "rw") {
      return { action: "skip", reason: "sandbox_workspace_not_writable" };
    }
  }

  if (params.entry && hasAlreadyFlushedForCurrentCompaction(params.entry)) {
    return { action: "skip", reason: "already_flushed_for_compaction" };
  }

  // The flush plan may pin an exact maintenance model ("provider/model"). The
  // exact override does not inherit the active fallback chain.
  let provider = params.provider;
  let model = params.modelId;
  const override = plan.model?.trim();
  if (override) {
    const slashIdx = override.indexOf("/");
    if (slashIdx > 0) {
      const overrideProvider = override.slice(0, slashIdx).trim();
      const overrideModel = override.slice(slashIdx + 1).trim();
      if (overrideProvider && overrideModel) {
        provider = overrideProvider;
        model = overrideModel;
      }
    } else {
      model = override;
    }
  }

  // Fail closed for an unknown flush-model window: the proactive resolver
  // substitutes a 200k default when metadata is absent, but an unregistered
  // (often smaller) override must not admit a doomed maintenance turn, so the
  // recovery gate resolves the raw window and skips on unknown provenance.
  const contextWindowTokens = resolveContextTokensForModel({
    cfg,
    provider,
    model,
    allowAsyncLoad: false,
  });
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return { action: "skip", reason: "unknown_flush_context_window" };
  }

  const estimate =
    typeof params.observedOverflowTokens === "number" &&
    Number.isFinite(params.observedOverflowTokens) &&
    params.observedOverflowTokens > 0
      ? Math.ceil(params.observedOverflowTokens)
      : typeof params.contextTokenBudget === "number" &&
          Number.isFinite(params.contextTokenBudget) &&
          params.contextTokenBudget > 0
        ? params.contextTokenBudget + 1
        : undefined;
  if (estimate === undefined) {
    return { action: "skip", reason: "unknown_maintenance_prompt_tokens" };
  }

  const headroom = contextWindowTokens - plan.reserveTokensFloor - plan.softThresholdTokens;
  if (headroom <= 0) {
    return { action: "skip", reason: "no_flush_headroom" };
  }
  if (estimate >= headroom) {
    return { action: "skip", reason: "maintenance_turn_not_admissible" };
  }

  return { action: "flush", provider, model, contextWindowTokens };
}
