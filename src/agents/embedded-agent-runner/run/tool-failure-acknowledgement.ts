import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTextForComparison } from "../../embedded-agent-helpers.js";

const MUTATING_FAILURE_WORD_PATTERN = "(?:failed|failure|errored)";
const MUTATING_FAILURE_ACTION_DETAIL_PATTERN =
  "(?:\\s+(?:tool|operation|action|attempt|step|call|request))?";
const DID_NOT_FAIL_PATTERN = /\b(?:did not|didn't)\s+fail\b/u;
const NEGATED_FAILURE_PATTERN = /\b(?:no|not|without)\s+(?:failures?|errors?)\b/u;

function escapeRegexPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMutatingFailureActionPattern(toolName: string): string {
  const normalizedToolName = normalizeOptionalLowercaseString(toolName) ?? "";
  if (normalizedToolName === "write") {
    return "(?:write|writing|wrote|save|saved|create|created)";
  }
  if (normalizedToolName === "edit" || normalizedToolName === "apply_patch") {
    return "(?:edit|edited|update|updated|modify|modified|change|changed|apply|applied|patch|patched)";
  }
  if (normalizedToolName === "message" || normalizedToolName === "sessions_send") {
    return "(?:send|sent|reply|replied|message|messaged|post|posted|dm)";
  }
  const words = normalizedToolName
    .split(/[_\s.-]+/u)
    .filter(Boolean)
    .map(escapeRegexPattern);
  return words.length > 0 ? `(?:${words.join("[_\\s.-]+")})` : "(?!)";
}

/** Detect a user-visible acknowledgement that a mutating action did not complete. */
export function hasExplicitMutatingToolFailureAcknowledgement(
  text: string,
  toolName: string,
): boolean {
  const normalizedText = normalizeTextForComparison(text);
  if (!normalizedText || DID_NOT_FAIL_PATTERN.test(normalizedText)) {
    return false;
  }
  const actionPattern = getMutatingFailureActionPattern(toolName);
  const inabilityPattern = new RegExp(
    `\\b(?:couldn't|could not|can't|cannot|unable to|am unable to|wasn't able to|was not able to|were unable to)\\s+\\b${actionPattern}\\b`,
    "u",
  );
  if (inabilityPattern.test(normalizedText)) {
    return true;
  }
  if (NEGATED_FAILURE_PATTERN.test(normalizedText)) {
    return false;
  }
  const acknowledgementPattern = new RegExp(
    `(?:\\b${actionPattern}\\b${MUTATING_FAILURE_ACTION_DETAIL_PATTERN}\\s+\\b${MUTATING_FAILURE_WORD_PATTERN}\\b|\\b${MUTATING_FAILURE_WORD_PATTERN}\\b\\s+(?:to|while|when|during|on)\\s+\\b${actionPattern}\\b|\\b(?:hit|encountered|ran into)\\b.{0,60}\\berror\\b.{0,100}\\b(?:while|trying to|when)\\s+\\b${actionPattern}\\b)`,
    "u",
  );
  return acknowledgementPattern.test(normalizedText);
}
