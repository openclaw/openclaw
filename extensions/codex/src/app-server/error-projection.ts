// Helpers that turn the structured error fields surfaced by the Codex
// app-server (see protocol-generated TurnError + RateLimitSnapshot) into a
// user-meaningful prompt-error string.
//
// Rationale: when ChatGPT plan auth runs into a usage-limit window the
// app-server emits an `error` notification carrying `codexErrorInfo:
// "usageLimitExceeded"` plus a recent `account/rateLimits/updated` snapshot
// with the plan name and reset window. Without this projection only the
// terse `error.message` was forwarded, so by the time the embedded runner's
// idle watchdog fired the failover surface_error path collapsed the cause to
// `reason=timeout` and the channel reply layer either showed the generic
// "Request timed out" copy or stayed silent. This helper preserves the
// retry-after window and plan label so the existing rate-limit classifier
// (`isRateLimitErrorMessage` matches "usage limit"/"plan"/"minutes") can
// surface a useful reply downstream.
//
// Format intentionally embeds keywords like "usage limit", "plan", and
// "minutes" so that `formatRateLimitOrOverloadedErrorCopy` /
// `extractProviderRateLimitMessage` recognise the message and prefix it with
// the warning glyph the channel reply pipeline already renders.

import type { PlanType } from "./protocol-generated/typescript/PlanType.js";
import type { CodexErrorInfo } from "./protocol-generated/typescript/v2/CodexErrorInfo.js";
import type { RateLimitSnapshot } from "./protocol-generated/typescript/v2/RateLimitSnapshot.js";
import type { RateLimitWindow } from "./protocol-generated/typescript/v2/RateLimitWindow.js";

export type CodexProjectedErrorParams = {
  message: string | undefined;
  codexErrorInfo: CodexErrorInfo | null | undefined;
  additionalDetails: string | null | undefined;
  rateLimits: RateLimitSnapshot | undefined;
  /** Wall-clock now, in seconds. Defaults to `Date.now()/1000`. */
  nowSeconds?: number;
};

const PLAN_LABELS: Record<PlanType, string> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "ChatGPT Plus (lite)",
  team: "ChatGPT Team",
  self_serve_business_usage_based: "ChatGPT Business",
  business: "ChatGPT Business",
  enterprise_cbp_usage_based: "ChatGPT Enterprise",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
  unknown: "ChatGPT",
};

function isUsageLimitExceeded(info: CodexErrorInfo | null | undefined): boolean {
  return info === "usageLimitExceeded";
}

function isServerOverloaded(info: CodexErrorInfo | null | undefined): boolean {
  return info === "serverOverloaded";
}

function planLabel(plan: PlanType | null | undefined): string | undefined {
  if (!plan) {
    return undefined;
  }
  return PLAN_LABELS[plan] ?? PLAN_LABELS.unknown;
}

function pickRetryWindow(snapshot: RateLimitSnapshot | undefined): RateLimitWindow | undefined {
  if (!snapshot) {
    return undefined;
  }
  // Prefer whichever bucket is closer to its limit so we surface the binding
  // window first; fall back to whichever side reports a duration/reset.
  const candidates: RateLimitWindow[] = [];
  if (snapshot.primary) {
    candidates.push(snapshot.primary);
  }
  if (snapshot.secondary) {
    candidates.push(snapshot.secondary);
  }
  const usable = candidates.filter(
    (window) => window.windowDurationMins !== null || window.resetsAt !== null,
  );
  if (usable.length === 0) {
    return candidates[0];
  }
  return usable.reduce((best, current) =>
    current.usedPercent > best.usedPercent ? current : best,
  );
}

function formatRetryClause(
  window: RateLimitWindow | undefined,
  nowSeconds: number,
): string | undefined {
  if (!window) {
    return undefined;
  }
  if (window.resetsAt !== null && Number.isFinite(window.resetsAt)) {
    const deltaSeconds = window.resetsAt - nowSeconds;
    if (deltaSeconds > 0) {
      const minutes = Math.max(1, Math.round(deltaSeconds / 60));
      return formatMinutesClause(minutes);
    }
  }
  if (window.windowDurationMins !== null && Number.isFinite(window.windowDurationMins)) {
    const minutes = Math.max(1, Math.round(window.windowDurationMins));
    return formatMinutesClause(minutes);
  }
  return undefined;
}

function formatMinutesClause(minutes: number): string {
  if (minutes >= 120) {
    const hours = Math.round(minutes / 60);
    return `Try again in ~${hours} hours.`;
  }
  return `Try again in ~${minutes} minutes.`;
}

function looksRedundantWithHeadline(message: string, headline: string): boolean {
  // Avoid stacking "ChatGPT usage limit reached" twice when the upstream
  // message and the synthesized headline carry the same intent.
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const normalizedMessage = normalize(message);
  const normalizedHeadline = normalize(headline);
  if (!normalizedMessage) {
    return true;
  }
  return (
    normalizedHeadline.includes(normalizedMessage) || normalizedMessage.includes(normalizedHeadline)
  );
}

/**
 * Build a user-meaningful prompt error message from a Codex app-server error
 * notification or completed-turn error. Returns `undefined` when the inputs
 * carry no actionable detail beyond the raw message.
 */
export function projectCodexAppServerError(params: CodexProjectedErrorParams): string | undefined {
  const trimmedMessage = params.message?.trim() ?? "";
  const additional = params.additionalDetails?.trim() ?? "";
  const nowSeconds = params.nowSeconds ?? Date.now() / 1000;

  if (isUsageLimitExceeded(params.codexErrorInfo)) {
    const plan = planLabel(params.rateLimits?.planType);
    const window = pickRetryWindow(params.rateLimits);
    const retry = formatRetryClause(window, nowSeconds);
    const headline = plan
      ? `${plan} plan usage limit reached.`
      : "ChatGPT usage limit reached for this plan.";
    const parts = [headline];
    if (retry) {
      parts.push(retry);
    } else if (trimmedMessage && !looksRedundantWithHeadline(trimmedMessage, headline)) {
      parts.push(trimmedMessage);
    }
    if (additional && !parts.some((part) => part.includes(additional))) {
      parts.push(additional);
    }
    return parts.join(" ");
  }

  if (isServerOverloaded(params.codexErrorInfo)) {
    const detail = trimmedMessage || additional;
    return detail
      ? `Codex service is overloaded. ${detail}`
      : "Codex service is overloaded. Please try again in a moment.";
  }

  if (!params.codexErrorInfo && !additional) {
    return undefined;
  }

  // Unknown / less-structured codexErrorInfo variants: stitch additional
  // detail into the message so downstream classifiers see the full context.
  const combined = [trimmedMessage, additional].filter(Boolean).join(" — ");
  return combined || undefined;
}
