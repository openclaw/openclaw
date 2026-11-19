import { parse as parseSemver } from "semver";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";

export type CodexTierFallback = "priority" | "default";

/** Older supported app-servers do not understand a turn-only tier override. */
export function supportsCodexTurnTierOverride(version: string | undefined): boolean {
  const parsed = version ? parseSemver(version) : null;
  return parsed !== null && parsed.compare("0.151.0") >= 0;
}
type CodexTierOutcome = Pick<
  EmbeddedRunAttemptResult,
  | "terminal"
  | "terminalTurnId"
  | "codexAppServerFailure"
  | "replayMetadata"
  | "runtimeContinuationStarted"
  | "assistantTexts"
  | "toolMetas"
  | "clientToolCalls"
  | "lastToolError"
  | "didSendDeterministicApprovalPrompt"
  | "itemLifecycle"
>;

/** A lower speed is preferable to silently changing the selected model. */
export function nextCodexServiceTier(
  requested: string | null | undefined,
  result: CodexTierOutcome,
  turnStartRejected = false,
): CodexTierFallback | undefined {
  if (
    result.terminal.kind !== "failed" ||
    result.terminal.source !== "prompt" ||
    (!result.terminalTurnId && !turnStartRejected) ||
    result.codexAppServerFailure ||
    result.replayMetadata?.replaySafe !== true ||
    result.replayMetadata.hadPotentialSideEffects ||
    result.runtimeContinuationStarted ||
    result.assistantTexts.some((text) => text.trim().length > 0) ||
    result.toolMetas.length > 0 ||
    result.clientToolCalls ||
    result.lastToolError ||
    result.didSendDeterministicApprovalPrompt ||
    result.itemLifecycle.activeCount > 0
  ) {
    return undefined;
  }
  const error = result.terminal.error;
  const status = error instanceof Error && "status" in error ? error.status : undefined;
  // Never convert authentication, approval, policy, cancellation, or uncertain
  // transport failures into retries. Only an explicit limit or overload qualifies.
  if (status !== 429 && status !== 503) {
    return undefined;
  }
  return requested === "ultrafast" ? "priority" : requested === "priority" ? "default" : undefined;
}
