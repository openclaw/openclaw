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
  opts: { hasExplicitModelOverride: boolean },
): string | null {
  const bypassOnOverride = cfg.bypassOnExplicitOverride ?? true;
  if (bypassOnOverride && opts.hasExplicitModelOverride) {
    return "explicit_override";
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

  // 5. No final assistant text
  const lastAssistantText = attempt.assistantTexts.join("").trim();
  if (!lastAssistantText) {
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
  // No slash → treat whole string as model under default provider
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
  });

  if (bypassReason) {
    log.debug(`[adaptive-routing] bypassed: ${bypassReason}`);
    logAdaptiveOutcome({ used: false, bypassReason });
    void recordAdaptiveRun(resolveStateDir(), { kind: "bypassed" });
    return runFn(params);
  }

  const { provider: localProvider, model: localModel } = parseModelRef(arCfg.localFirstModel!);
  const { provider: cloudProvider, model: cloudModel } = parseModelRef(arCfg.cloudEscalationModel!);

  // If runWithModelFallback has already advanced to a different candidate
  // (not the local-first model), we are mid-fallback. Bypass adaptive routing
  // and let the fallback machinery pick the provider/model normally.
  const isFallbackCandidate =
    (params.provider && params.provider !== localProvider) ||
    (params.model && params.model !== localModel);

  if (isFallbackCandidate) {
    log.debug(
      `[adaptive-routing] bypassed: mid-fallback candidate ${params.provider}/${params.model}`,
    );
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
  await fs.copyFile(originalSessionFile, tempSessionFile).catch(() => {
    // Session file may not exist yet (new conversation) – that is fine.
  });

  let localAttemptResult: EmbeddedRunAttemptResult | undefined;

  try {
    const localResult = await runFn({
      ...params,
      provider: localProvider,
      model: localModel,
      sessionFile: tempSessionFile,
      // Capture the rich attempt result for validation
      _onAttemptResult: (r) => {
        localAttemptResult = r;
        // Forward to any outer handler too
        params._onAttemptResult?.(r);
      },
    });

    // ── Validate ──────────────────────────────────────────────────────────
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
      return localResult;
    }

    // ── Escalate to cloud model ────────────────────────────────────────────
    log.info(
      `[adaptive-routing] escalating: local_score=${validation.score.toFixed(2)} reason=${validation.reason} → ${cloudProvider}/${cloudModel}`,
    );

    // Discard temp session so cloud run sees original history (not local attempt)
    await fs.unlink(tempSessionFile).catch(() => {});

    const cloudResult = await runFn({
      ...params,
      provider: cloudProvider,
      model: cloudModel,
      sessionFile: originalSessionFile,
    });

    logAdaptiveOutcome({
      used: true,
      localModel: `${localProvider}/${localModel}`,
      cloudModel: `${cloudProvider}/${cloudModel}`,
      validationMode,
      validationScore: validation.score,
      validationPassed: validation.passed,
      validationReason: validation.reason,
      escalated: true,
    });
    void recordAdaptiveRun(resolveStateDir(), {
      kind: "escalated",
      localUsage: localAttemptResult?.attemptUsage ?? localResult.meta.agentMeta?.usage,
      cloudUsage: cloudResult.meta.agentMeta?.usage,
    });

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
  } catch {
    // rename may fail cross-device; fall back to copy + unlink
    try {
      await fs.copyFile(from, to);
      await fs.unlink(from).catch(() => {});
    } catch (copyErr) {
      log.warn(`[adaptive-routing] failed to promote temp session file: ${String(copyErr)}`);
    }
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
