import {
  buildReplyBoundaryEnforcementDecision,
  classifyReplyBoundaryClaimFamilies,
  type ReplyBoundaryPolicyInput,
} from "../../../moonlight/src/pinocchio/reply-boundary/index.ts";

const REPORT_BACK_PATTERNS = [
  /\b(i['’]?ll|i will)\s*(report back|let you know|follow up|circle back)\b/i,
  /\b(i['’]?ll|i will)\s*(keep an eye on|watch for|monitor)\b/i,
  /\b(report back when|let you know when|follow up when|watch it for you)\b/i,
];

const TRUTHFUL_BOUNDARY_PATTERNS = [
  /I am not continuing after this reply unless I explicitly resume or start a real background run\./i,
  /Stopping here now; no active work is continuing after this reply\./i,
  /Paused here; no active work is continuing after this reply\./i,
  /A background run is active after this reply:/i,
  /Waiting here for:/i,
  /Waiting here for a required answer before continuing\./i,
];

const REPORT_BACK_FALLBACK =
  "I will not automatically report back after this reply unless I explicitly set up a real reminder or watcher and tell you that I did.";

function splitUnits(messageText: string): string[] {
  return messageText
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (/^(?:\[\[[^\]]+\]\]|(?:[-*•]|\d+\.)\s+)/.test(line)) {
        return [line];
      }
      return line
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'([{])/)
        .map((part) => part.trim())
        .filter(Boolean);
    });
}

function applyReportBackSupplement(messageText: string): string {
  if (!messageText || !REPORT_BACK_PATTERNS.some((pattern) => pattern.test(messageText))) {
    return messageText;
  }

  const units = splitUnits(messageText);
  const kept = units.filter((unit) => !REPORT_BACK_PATTERNS.some((pattern) => pattern.test(unit)));
  const keptText = kept.join("\n\n").trim();

  if (!keptText) {
    return REPORT_BACK_FALLBACK;
  }
  return `${keptText}\n\n${REPORT_BACK_FALLBACK}`;
}

function shouldApplyCanonicalPolicy(messageText: string): boolean {
  if (!messageText) {
    return false;
  }
  if (TRUTHFUL_BOUNDARY_PATTERNS.some((pattern) => pattern.test(messageText))) {
    return false;
  }

  const families = classifyReplyBoundaryClaimFamilies(messageText);
  return families.includes("active_continuation") || families.includes("background_execution");
}

function buildBasePolicyInput(messageText: string): ReplyBoundaryPolicyInput {
  return {
    messageText,
    postReplyState: "IDLE",
    didWorkThisTurn: false,
    backgroundRunIds: [],
    waitingOn: null,
    activityEvidence: [],
  };
}

export interface ReplyBoundaryGuardResult {
  originalText: string;
  outputText: string;
  outputChanged: boolean;
  usedCanonicalPolicy: boolean;
  usedReportBackSupplement: boolean;
  canonicalAction: "allow" | "rewrite";
  canonicalReason: string;
}

export function applyReplyBoundaryGuard(messageText: string): ReplyBoundaryGuardResult {
  let afterCanonical = messageText;
  let canonicalAction: "allow" | "rewrite" = "allow";
  let canonicalReason = "Canonical policy not invoked for this message.";
  let usedCanonicalPolicy = false;

  if (shouldApplyCanonicalPolicy(messageText)) {
    const decision = buildReplyBoundaryEnforcementDecision(buildBasePolicyInput(messageText));
    afterCanonical = decision.outputText;
    canonicalAction = decision.action;
    canonicalReason = decision.reason;
    usedCanonicalPolicy = decision.outputChanged;
  }

  const afterSupplement = applyReportBackSupplement(afterCanonical);

  return {
    originalText: messageText,
    outputText: afterSupplement,
    outputChanged: afterSupplement !== messageText,
    usedCanonicalPolicy,
    usedReportBackSupplement: afterSupplement !== afterCanonical,
    canonicalAction,
    canonicalReason,
  };
}

export function rewriteReplyBoundaryText(messageText: string): string {
  return applyReplyBoundaryGuard(messageText).outputText;
}
