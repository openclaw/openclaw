/**
 * Adaptive Model Routing
 *
 * Outcome-aware escalation: run a cheap/local model first, validate the result
 * with a heuristic (or optional LLM) validator, and re-run once with a cloud
 * model if validation fails.
 *
 * This is NOT provider failover. Failover handles provider errors/rate-limits.
 * Adaptive routing handles outcome quality, escalating to a stronger model when
 * the local model produces an insufficient response.
 *
 * Default: disabled. Enable via agents.defaults.model.adaptiveRouting.
 */

import fs from "node:fs/promises";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  AdaptiveRoutingConfig,
  AdaptiveRoutingValidationConfig,
} from "../config/types.agents-shared.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { recordAdaptiveRun } from "./adaptive-routing-savings.js";
import { FailoverError } from "./failover-error.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

const log = createSubsystemLogger("agent/adaptive-routing");

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_SCORE = 0.75;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 2000;
const DEFAULT_MAX_ASSISTANT_CHARS = 4000;
const MAX_ESCALATIONS_CAP = 1; // v1 hard cap

// ─── Result types ─────────────────────────────────────────────────────────────

export type ValidationResult = {
  passed: boolean;
  score: number;
  reason: string;
};

export type AdaptiveRoutingOutcome =
  | { used: false; bypassReason: string }
  | {
      used: true;
      localModel: string;
      cloudModel: string;
      validationMode: "heuristic" | "llm";
      validationScore: number;
      validationPassed: boolean;
      validationReason: string;
      escalated: boolean;
    };

// ─── Config resolution ───────────────────────────────────────────────────────

/**
 * Extract the adaptiveRouting config from the top-level OpenClaw config.
 * Returns null when adaptive routing is not enabled or not present.
 */
export function resolveAdaptiveRoutingConfig(
  cfg: OpenClawConfig | undefined,
): AdaptiveRoutingConfig | null {
  const model = cfg?.agents?.defaults?.model;
  if (!model || typeof model === "string") {
    return null;
  }
  const ar = model.adaptiveRouting;
  if (!ar?.enabled) {
    return null;
  }
  if (!ar.localFirstModel?.trim() || !ar.cloudEscalationModel?.trim()) {
    log.warn(
      "[adaptive-routing] enabled but localFirstModel or cloudEscalationModel missing – disabled",
    );
    return null;
  }
  if (!ar.localFirstModel.includes("/") || !ar.cloudEscalationModel.includes("/")) {
    log.warn(
      "[adaptive-routing] localFirstModel and cloudEscalationModel must use 'provider/model' format (e.g. ollama/llama3.2) – disabled",
    );
    return null;
  }
  // Enforce v1 maxEscalations cap
  const maxEscalations = Math.min(Math.max(0, ar.maxEscalations ?? 1), MAX_ESCALATIONS_CAP);
  return { ...ar, maxEscalations };
}

/**
 * Returns the bypass reason string if adaptive routing should not run,
 * or null if it should proceed.
 */
export function resolveBypassReason(
  cfg: AdaptiveRoutingConfig,
  opts: {
    hasExplicitModelOverride: boolean;
    /** Caller-provided provider (may be the default — check against adaptive config). */
    callerProvider?: string;
    /** Caller-provided model (may be the default — check against adaptive config). */
    callerModel?: string;
  },
): string | null {
  const bypassOnOverride = cfg.bypassOnExplicitOverride ?? true;
  if (bypassOnOverride && opts.hasExplicitModelOverride) {
    return "explicit_override";
  }
  // Bypass when the caller explicitly targets a specific model that differs
  // from the adaptive config's local/cloud pair (e.g. probe runs, direct API
  // calls with an explicit provider/model).
  if (opts.callerProvider && opts.callerModel) {
    const callerRef = `${opts.callerProvider}/${opts.callerModel}`;
    const localRef = cfg.localFirstModel?.trim();
    const cloudRef = cfg.cloudEscalationModel?.trim();
    if (localRef && cloudRef && callerRef !== localRef && callerRef !== cloudRef) {
      return "explicit_model_target";
    }
  }
  return null;
}

// ─── Secret redaction ────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED:sk-key]" },
  { pattern: /Bearer\s+[A-Za-z0-9._\-/+]{8,}/gi, replacement: "Bearer [REDACTED]" },
  {
    pattern:
      /(?:api[_-]?key|apikey|access[_-]?token|secret)[=:]\s*["']?[A-Za-z0-9._\-/+]{8,}["']?/gi,
    replacement: "[REDACTED:api-key]",
  },
  {
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: "[REDACTED:jwt]",
  },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─── Heuristic validation ────────────────────────────────────────────────────

/**
 * Validate an attempt result using heuristic rules.
 * Produces a numeric score in [0..1] and a boolean pass/fail.
 */
export function validateHeuristic(
  attempt: EmbeddedRunAttemptResult,
  cfg: AdaptiveRoutingConfig,
): ValidationResult {
  const minScore = cfg.validation?.minScore ?? DEFAULT_MIN_SCORE;
  let score = 1.0;
  const failReasons: string[] = [];

  // 1. Provider/runtime error
  if (attempt.promptError) {
    score -= 1.0;
    failReasons.push("provider_error");
  }

  // 2. Aborted (user abort, not timeout)
  if (attempt.aborted && !attempt.timedOut) {
    score -= 0.8;
    failReasons.push("aborted");
  }

  // 3. Timeout → treat as length truncation
  if (attempt.timedOut) {
    score -= 0.3;
    failReasons.push("timed_out");
  }

  // 4. Tool execution error
  if (attempt.lastToolError?.error) {
    score -= 0.6;
    failReasons.push(`tool_error:${attempt.lastToolError.toolName}`);
  }

  // 5. No final assistant text — exempt runs where the response was delivered via
  // a messaging tool (send_message / reply / etc.), which produce no assistant text.
  const lastAssistantText = attempt.assistantTexts.join("").trim();
  if (!lastAssistantText && !attempt.didSendViaMessagingTool) {
    score -= 0.4;
    failReasons.push("empty_assistant_output");
  }

  // 6. Pending tool calls: run ended with the assistant making tool calls but no tool results follow.
  // The pi-ai SDK uses "toolCall" as the content block type for tool calls.
  if (attempt.messagesSnapshot) {
    const last = attempt.messagesSnapshot[attempt.messagesSnapshot.length - 1];
    if (last?.role === "assistant") {
      const content = last.content;
      if (Array.isArray(content)) {
        const hasToolCallBlock = content.some(
          (b): boolean =>
            b != null &&
            typeof b === "object" &&
            ((b as { type?: unknown }).type === "toolCall" ||
              (b as { type?: unknown }).type === "tool_use"),
        );
        if (hasToolCallBlock) {
          // Last message has tool calls with no following tool results = pending
          score -= 0.4;
          failReasons.push("pending_tool_calls");
        }
      }
    }
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= minScore && failReasons.length === 0;

  return {
    passed,
    score,
    reason: passed ? "ok" : failReasons.join(", "),
  };
}

// ─── LLM validation ──────────────────────────────────────────────────────────

type LlmRunFn = (provider: string, model: string, prompt: string) => Promise<string>;

/** Parse a "provider/model" string into { provider, model }. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
  }
  // Callers validate format before reaching here; this is a safety fallback.
  return { provider: ref, model: ref };
}

function buildValidatorPrompt(
  userRequest: string,
  assistantOutput: string,
  toolSummary: string,
  validationCfg: AdaptiveRoutingValidationConfig | undefined,
): string {
  const maxAssistantChars = validationCfg?.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS;
  const shouldRedact = validationCfg?.redactSecrets ?? true;

  const truncatedOutput = assistantOutput.slice(0, maxAssistantChars);
  const finalOutput = shouldRedact ? redactSecrets(truncatedOutput) : truncatedOutput;
  const finalRequest = shouldRedact ? redactSecrets(userRequest) : userRequest;

  return [
    "You are a response quality validator. Evaluate whether the assistant adequately completed the user request.",
    "",
    `User request: ${finalRequest}`,
    "",
    toolSummary ? `Tool calls made:\n${toolSummary}` : "No tool calls.",
    "",
    `Assistant output:\n${finalOutput || "(empty)"}`,
    "",
    'Respond with ONLY valid JSON: {"score": 0.0-1.0, "passed": true/false, "reason": "one sentence"}',
    "Score above 0.75 = passed. Be strict: empty output, tool errors, or incomplete tasks = fail.",
  ].join("\n");
}

function buildToolSummary(
  attempt: EmbeddedRunAttemptResult,
  validationCfg: AdaptiveRoutingValidationConfig | undefined,
): string {
  const maxToolChars = validationCfg?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const shouldRedact = validationCfg?.redactSecrets ?? true;

  return attempt.toolMetas
    .map((t) => {
      const meta = t.meta ? `: ${t.meta.slice(0, maxToolChars)}` : "";
      const redacted = shouldRedact ? redactSecrets(meta) : meta;
      const error =
        attempt.lastToolError?.toolName === t.toolName
          ? ` [ERROR: ${attempt.lastToolError.error ?? "unknown"}]`
          : "";
      return `  - ${t.toolName}${redacted}${error}`;
    })
    .join("\n");
}

/**
 * Validate using an LLM validator model.
 * Returns null if the validator call fails (treated as FAIL by caller).
 */
export async function validateWithLlm(
  attempt: EmbeddedRunAttemptResult,
  userRequest: string,
  cfg: AdaptiveRoutingConfig,
  llmRun: LlmRunFn,
): Promise<ValidationResult> {
  const validationCfg = cfg.validation;
  const validatorModelRef = validationCfg?.validatorModel ?? "";
  if (!validatorModelRef.trim()) {
    log.warn(
      "[adaptive-routing] llm validation requested but validatorModel not configured; falling back to heuristic",
    );
    return validateHeuristic(attempt, cfg);
  }

  const { provider: vProvider, model: vModel } = parseModelRef(validatorModelRef);
  const assistantOutput = attempt.assistantTexts.join("\n");
  const toolSummary = buildToolSummary(attempt, validationCfg);
  const prompt = buildValidatorPrompt(userRequest, assistantOutput, toolSummary, validationCfg);

  try {
    const raw = await llmRun(vProvider, vModel, prompt);
    // Extract JSON from response (may have extra text)
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      log.warn("[adaptive-routing] LLM validator returned no JSON; treating as FAIL");
      return { passed: false, score: 0, reason: "validator_no_json" };
    }
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>).score !== "number" ||
      typeof (parsed as Record<string, unknown>).passed !== "boolean"
    ) {
      log.warn(
        "[adaptive-routing] LLM validator returned invalid JSON structure; treating as FAIL",
      );
      return { passed: false, score: 0, reason: "validator_invalid_json" };
    }
    const result = parsed as { score: number; passed: boolean; reason?: string };
    const minScore = validationCfg?.minScore ?? DEFAULT_MIN_SCORE;
    // Enforce consistency: if score below minScore, override passed to false
    const passed = result.passed && result.score >= minScore;
    return {
      passed,
      score: Math.max(0, Math.min(1, result.score)),
      reason: result.reason ?? (passed ? "ok" : "llm_fail"),
    };
  } catch (err) {
    log.warn(`[adaptive-routing] LLM validator error: ${String(err)}; treating as FAIL`);
    return { passed: false, score: 0, reason: "validator_error" };
  }
}

// ─── Main wrapper ─────────────────────────────────────────────────────────────

export type AdaptiveRunFn = (params: RunEmbeddedPiAgentParams) => Promise<EmbeddedPiRunResult>;

/**
 * Run the agent with adaptive model routing.
 *
 * - If adaptive routing is disabled or bypassed, delegates directly to `runFn`.
 * - Otherwise:
 *   1. Runs with `localFirstModel` (writing to a temp session file copy).
 *   2. Validates the outcome (heuristic or LLM).
 *   3. If validation passes: promotes the temp session to the real session file.
 *   4. If validation fails and maxEscalations > 0: discards temp session and
 *      re-runs with `cloudEscalationModel` against the original session file.
 *
 * The cloud re-run sees the same conversation history as the local run (before
 * the local attempt), satisfying the "rerun from scratch" requirement.
 */
export async function runEmbeddedPiAgentWithAdaptiveRouting(
  params: RunEmbeddedPiAgentParams,
  runFn: AdaptiveRunFn,
): Promise<EmbeddedPiRunResult> {
  const arCfg = resolveAdaptiveRoutingConfig(params.config);

  if (!arCfg) {
    log.debug("[adaptive-routing] disabled");
    return runFn(params);
  }

  const bypassReason = resolveBypassReason(arCfg, {
    hasExplicitModelOverride: params._hasExplicitModelOverride ?? false,
    callerProvider: params.provider?.trim(),
    callerModel: params.model?.trim(),
  });

  if (bypassReason) {
    log.debug(`[adaptive-routing] bypassed: ${bypassReason}`);
    logAdaptiveOutcome({ used: false, bypassReason });
    void recordAdaptiveRun(resolveStateDir(), { kind: "bypassed" });
    return runFn(params);
  }

  const { provider: localProvider, model: localModel } = parseModelRef(arCfg.localFirstModel!);
  const { provider: cloudProvider, model: cloudModel } = parseModelRef(arCfg.cloudEscalationModel!);

  // When localTrialReadOnly is set, agents with mutating tools should skip the
  // local trial entirely — tool side-effects (messages sent, files written) from
  // the trial cannot be rolled back if escalation fires.
  if (arCfg.localTrialReadOnly) {
    log.debug("[adaptive-routing] bypassed: localTrialReadOnly");
    logAdaptiveOutcome({ used: false, bypassReason: "local_trial_read_only" });
    void recordAdaptiveRun(resolveStateDir(), { kind: "bypassed" });
    return runFn(params);
  }

  // If adaptive routing already escalated earlier in this runWithModelFallback chain
  // (tracked via _adaptiveEscalationDone set by the caller's closure), skip local
  // re-run and let the fallback machinery use the current candidate directly.
  if (params._adaptiveEscalationDone) {
    log.debug(`[adaptive-routing] bypassed: escalation already ran in this fallback chain`);
    return runFn(params);
  }

  const maxEscalations = arCfg.maxEscalations ?? 1;
  const validationMode = arCfg.validation?.mode ?? "heuristic";

  if (validationMode === "llm") {
    log.warn(
      "[adaptive-routing] LLM validation mode is experimental and not fully implemented; " +
        "will fall back to heuristic validation. See docs for details.",
    );
  }

  log.info(
    `[adaptive-routing] starting: local=${localProvider}/${localModel} cloud=${cloudProvider}/${cloudModel} validationMode=${validationMode}`,
  );

  // ── Local run in a temp session file ──────────────────────────────────────
  const originalSessionFile = params.sessionFile;
  const tempSessionFile = `${originalSessionFile}.adaptive-${Date.now()}-${process.pid}`;

  // Copy existing session (conversation history) to temp file before local run.
  await fs.copyFile(originalSessionFile, tempSessionFile).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      return;
    } // New conversation — no file yet.
    throw err; // Real I/O failure — don't silently proceed with stale state.
  });

  let localAttemptResult: EmbeddedRunAttemptResult | undefined;
  let localTrialFailed = false;

  try {
    let localResult: EmbeddedPiRunResult;
    try {
      localResult = await runFn({
        ...params,
        provider: localProvider,
        model: localModel,
        sessionFile: tempSessionFile,
        // Suppress all user-visible streaming callbacks during the local trial run.
        // They fire again on the definitive run (cloud escalation or local-pass path).
        // Without this, partial output from the local attempt leaks to the user before
        // validation decides which model's response to actually deliver, causing
        // duplicate sends when escalation occurs.
        onPartialReply: undefined,
        onAssistantMessageStart: undefined,
        onBlockReply: undefined,
        onBlockReplyFlush: undefined,
        onReasoningStream: undefined,
        onReasoningEnd: undefined,
        onToolResult: undefined,
        // Suppress agent-event streaming so trial-run events (tool calls, partial
        // output, etc.) never surface to the end user or control channel.
        onAgentEvent: undefined,
        // Capture the rich attempt result for validation
        _onAttemptResult: (r) => {
          localAttemptResult = r;
          // Forward to any outer handler too
          params._onAttemptResult?.(r);
        },
      });
    } catch (localErr) {
      // FailoverError (auth failure, rate limit, provider down) — treat as
      // automatic local-trial failure and escalate to cloud instead of
      // propagating the error and aborting the whole agent turn.
      if (localErr instanceof FailoverError) {
        log.warn(
          `[adaptive-routing] local trial threw FailoverError: ${localErr.message} → escalating to cloud`,
        );
        localTrialFailed = true;
        // falls through to the escalation block below
        localResult = undefined!;
      } else {
        throw localErr;
      }
    }

    // ── Validate ──────────────────────────────────────────────────────────
    if (!localTrialFailed) {
      let validation: ValidationResult;

      if (!localAttemptResult) {
        // runFn didn't fire the callback (e.g., CLI provider path); fall back to run-result heuristic
        validation = validateFromRunResult(localResult, arCfg);
      } else if (validationMode === "llm") {
        validation = await validateWithLlm(
          localAttemptResult,
          params.prompt,
          arCfg,
          // LLM run fn: for v1, fall back to heuristic; a future version can wire
          // in a lightweight completion call here.
          async () => {
            log.warn(
              "[adaptive-routing] LLM validator not wired to a standalone runner; using heuristic",
            );
            return JSON.stringify(validateHeuristic(localAttemptResult!, arCfg));
          },
        );
      } else {
        validation = validateHeuristic(localAttemptResult, arCfg);
      }

      log.info(
        `[adaptive-routing] local validation: passed=${validation.passed} score=${validation.score.toFixed(2)} reason=${validation.reason}`,
      );

      if (validation.passed || maxEscalations === 0) {
        // Local result is good – promote temp session file to actual
        await safeRename(tempSessionFile, originalSessionFile);
        logAdaptiveOutcome({
          used: true,
          localModel: `${localProvider}/${localModel}`,
          cloudModel: `${cloudProvider}/${cloudModel}`,
          validationMode,
          validationScore: validation.score,
          validationPassed: validation.passed,
          validationReason: validation.reason,
          escalated: false,
        });
        void recordAdaptiveRun(resolveStateDir(), {
          kind: "local_success",
          localUsage: localAttemptResult?.attemptUsage ?? localResult.meta.agentMeta?.usage,
        });
        localResult.adaptiveRoutingMeta = {
          actualProvider: localProvider,
          actualModel: localModel,
          escalated: false,
        };
        return localResult;
      }
    }

    // ── Escalate to cloud model ────────────────────────────────────────────
    if (localTrialFailed) {
      log.info(
        `[adaptive-routing] escalating (local trial error) → ${cloudProvider}/${cloudModel}`,
      );
    } else {
      log.info(
        `[adaptive-routing] escalating: local validation failed → ${cloudProvider}/${cloudModel}`,
      );
    }

    // Discard temp session so cloud run sees original history (not local attempt)
    await fs.unlink(tempSessionFile).catch(() => {});

    // Notify the caller's fallback closure that escalation is about to run.
    // This lets it skip re-running the local model if the cloud run fails and
    // runWithModelFallback retries with another candidate.
    params._onAdaptiveEscalation?.();

    let cloudResult: EmbeddedPiRunResult;
    try {
      cloudResult = await runFn({
        ...params,
        provider: cloudProvider,
        model: cloudModel,
        sessionFile: originalSessionFile,
      });
    } catch (cloudErr) {
      // If the cloud escalation model also fails, let the error propagate up
      // to runWithModelFallback so the normal fallback chain can try the next
      // candidate provider/model instead of aborting the turn entirely.
      log.warn(
        `[adaptive-routing] cloud escalation failed: ${cloudErr instanceof Error ? cloudErr.message : String(cloudErr)}`,
      );
      throw cloudErr;
    }

    logAdaptiveOutcome({
      used: true,
      localModel: `${localProvider}/${localModel}`,
      cloudModel: `${cloudProvider}/${cloudModel}`,
      validationMode,
      validationScore: localTrialFailed ? 0 : 0,
      validationPassed: false,
      validationReason: localTrialFailed ? "local_trial_error" : "validation_failed",
      escalated: true,
    });
    void recordAdaptiveRun(resolveStateDir(), {
      kind: "escalated",
      localUsage: localAttemptResult?.attemptUsage ?? localResult?.meta?.agentMeta?.usage,
      cloudUsage: cloudResult.meta.agentMeta?.usage,
    });

    cloudResult.adaptiveRoutingMeta = {
      actualProvider: cloudProvider,
      actualModel: cloudModel,
      escalated: true,
    };
    return cloudResult;
  } finally {
    // Safety: always clean up temp file on any exit path
    await fs.unlink(tempSessionFile).catch(() => {});
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fallback heuristic validation based solely on `EmbeddedPiRunResult`
 * (when `EmbeddedRunAttemptResult` is not available).
 */
function validateFromRunResult(
  result: EmbeddedPiRunResult,
  cfg: AdaptiveRoutingConfig,
): ValidationResult {
  const minScore = cfg.validation?.minScore ?? DEFAULT_MIN_SCORE;
  let score = 1.0;
  const failReasons: string[] = [];

  if (result.meta.error) {
    score -= 1.0;
    failReasons.push(`runtime_error:${result.meta.error.kind}`);
  }

  if (result.meta.aborted) {
    score -= 0.8;
    failReasons.push("aborted");
  }

  if (result.meta.pendingToolCalls?.length) {
    score -= 0.4;
    failReasons.push("pending_tool_calls");
  }

  const hasTextPayload = result.payloads?.some(
    (p) => typeof p.text === "string" && p.text.trim().length > 0 && !p.isError,
  );
  if (!hasTextPayload) {
    score -= 0.4;
    failReasons.push("empty_or_error_output");
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= minScore && failReasons.length === 0;
  return {
    passed,
    score,
    reason: passed ? "ok" : failReasons.join(", "),
  };
}

async function safeRename(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (renameErr) {
    // ENOENT from rename: the temp file was cleaned up or never created (e.g.
    // tests with mock runFn that don't write actual files). Not a failure.
    if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    // rename may fail cross-device; fall back to copy + unlink
    await fs.copyFile(from, to);
    await fs.unlink(from).catch(() => {});
  }
}

function logAdaptiveOutcome(outcome: AdaptiveRoutingOutcome): void {
  if (!outcome.used) {
    log.info(
      `[adaptive-routing] outcome: adaptive_routing_used=false bypass_reason=${outcome.bypassReason}`,
    );
    return;
  }
  log.info(
    `[adaptive-routing] outcome: adaptive_routing_used=true` +
      ` local_model=${outcome.localModel}` +
      ` cloud_model=${outcome.cloudModel}` +
      ` validation_mode=${outcome.validationMode}` +
      ` validation_score=${outcome.validationScore.toFixed(2)}` +
      ` validation_passed=${outcome.validationPassed}` +
      ` escalated=${outcome.escalated}` +
      (outcome.escalated ? ` local_reason=${outcome.validationReason}` : ""),
  );
}

// Re-export types for consumers
export type {
  AdaptiveRoutingConfig,
  AdaptiveRoutingValidationConfig,
} from "../config/types.agents-shared.js";
