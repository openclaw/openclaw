import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type MessageDeliveryReceiptClaim = {
  channel: "sms";
  recipient?: string;
  sender?: string;
  providerId?: string;
  status?: string;
};

const SMS_DELIVERY_VERBS = ["sent", "queued", "delivered", "accepted/queued", "accepted"] as const;
const SMS_DELIVERY_VERB_RE_SOURCE = SMS_DELIVERY_VERBS.map((verb) =>
  verb.replace(/[/.]/g, "\\$&"),
).join("|");
export const SMS_DELIVERY_ASSERTION_RE_SOURCE = `\\b(?:Sent to\\b|(?:sms|text message)\\s+(?:was\\s+)?(?:${SMS_DELIVERY_VERB_RE_SOURCE})\\b|(?:${SMS_DELIVERY_VERB_RE_SOURCE})\\s+(?:(?:the|an?|this)\\s+)?(?:sms|text message)\\b)`;
const SMS_PREFILTER_RE = new RegExp(
  `\\b(?:sms|text message)\\b[\\s\\S]{0,240}\\b(?:${SMS_DELIVERY_VERB_RE_SOURCE}|message id|status)\\b|\\b(?:${SMS_DELIVERY_VERB_RE_SOURCE})\\b[\\s\\S]{0,80}\\b(?:sms|text message)\\b(?:[\\s\\S]{0,240}\\b(?:message id|status)\\b)?|\\bSent to\\b[\\s\\S]{0,240}\\b(?:To:|Status:|Message ID:)`,
  "iu",
);
const SMS_DELIVERY_ASSERTION_RE = new RegExp(SMS_DELIVERY_ASSERTION_RE_SOURCE, "giu");
const SMS_DELIVERY_VERB_CAPTURE_RE = new RegExp(
  `\\b(?:sms|text message)\\s+(?:was\\s+)?(${SMS_DELIVERY_VERB_RE_SOURCE})\\b|(${SMS_DELIVERY_VERB_RE_SOURCE})\\s+(?:(?:the|an?|this)\\s+)?(?:sms|text message)\\b`,
  "iu",
);
const UNCERTAIN_OR_NEGATED_RE =
  /\b(?:not\s+(?:yet\s+)?sent|never\s+sent|did\s+not\s+send|didn't\s+send|haven't\s+sent|hasn't\s+sent|hadn't\s+sent)\b/iu;
const QUOTED_DIAGNOSTIC_RE = /^\s*(?:>|["']).{0,120}\b(?:Sent to|Status:|Message ID:)/iu;

function captureFirst(text: string, re: RegExp): string | undefined {
  return normalizeOptionalString(re.exec(text)?.[1]);
}

function captureFirstAnyGroup(text: string, re: RegExp): string | undefined {
  const match = re.exec(text);
  if (!match) {
    return undefined;
  }
  for (let index = 1; index < match.length; index += 1) {
    const value = normalizeOptionalString(match[index]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizePhoneClaim(value: string | undefined): string | undefined {
  return normalizeOptionalString(value)?.replace(/[.,;:!?]+$/u, "");
}

function isQuotedCandidateStart(text: string, start: number): boolean {
  const lineStart = Math.max(text.lastIndexOf("\n", start - 1) + 1, 0);
  return /^\s*(?:>|["'])/u.test(text.slice(lineStart, start));
}

function findCandidateContextStart(text: string, start: number): number {
  const prefix = text.slice(0, start);
  const sentenceBreak = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf("\n"),
  );
  return sentenceBreak >= 0 ? sentenceBreak + 1 : 0;
}

function detectSingleMessageDeliveryReceiptClaim(text: string): MessageDeliveryReceiptClaim | null {
  const trimmed = text.trim();
  if (!trimmed || !SMS_PREFILTER_RE.test(trimmed)) {
    return null;
  }
  if (UNCERTAIN_OR_NEGATED_RE.test(trimmed) || QUOTED_DIAGNOSTIC_RE.test(trimmed)) {
    return null;
  }
  const explicitStatus = captureFirst(trimmed, /\bStatus:\s*([A-Za-z][A-Za-z/-]{1,40})/iu);
  const verbStatus = captureFirstAnyGroup(trimmed, SMS_DELIVERY_VERB_CAPTURE_RE)?.toLowerCase();
  const status = explicitStatus ?? verbStatus;
  const providerId = captureFirst(
    trimmed,
    /\b(?:Message ID|message id|provider id|provider message id):?\s*([A-Za-z0-9_-]{4,80})/iu,
  );
  const recipient =
    normalizePhoneClaim(captureFirst(trimmed, /\b(?:Sent to|To)\s*:?\s*(\+?\d[\d\s().-]{6,})/iu)) ??
    normalizePhoneClaim(
      captureFirst(trimmed, /\b(?:sms|text message)\s+to\s*:?\s*(\+?\d[\d\s().-]{6,})/iu),
    );
  const sender = normalizePhoneClaim(captureFirst(trimmed, /\bFrom:\s*(\+?\d[\d\s().-]{6,})/iu));
  const hasSmsDeliveryMarker = SMS_DELIVERY_VERB_CAPTURE_RE.test(trimmed);
  if (!recipient && !hasSmsDeliveryMarker) {
    return null;
  }
  const hasReceiptMarker = Boolean(providerId || status || recipient) || hasSmsDeliveryMarker;
  if (!hasReceiptMarker) {
    return null;
  }
  return {
    channel: "sms",
    ...(recipient ? { recipient } : {}),
    ...(sender ? { sender } : {}),
    ...(providerId ? { providerId } : {}),
    ...(status ? { status: status.toLowerCase() } : {}),
  };
}

export function detectMessageDeliveryReceiptClaims(text: string): MessageDeliveryReceiptClaim[] {
  const trimmed = text.trim();
  if (!trimmed || !SMS_PREFILTER_RE.test(trimmed)) {
    return [];
  }
  const starts = [...trimmed.matchAll(SMS_DELIVERY_ASSERTION_RE)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined);
  if (starts.length === 0) {
    return [];
  }
  const claims: MessageDeliveryReceiptClaim[] = [];
  for (const [position, start] of starts.entries()) {
    if (isQuotedCandidateStart(trimmed, start)) {
      continue;
    }
    const end = starts[position + 1] ?? trimmed.length;
    const contextStart = findCandidateContextStart(trimmed, start);
    const claim = detectSingleMessageDeliveryReceiptClaim(trimmed.slice(contextStart, end));
    if (claim) {
      claims.push(claim);
    }
  }
  return claims;
}

export function detectMessageDeliveryReceiptClaim(
  text: string,
): MessageDeliveryReceiptClaim | null {
  return detectMessageDeliveryReceiptClaims(text)[0] ?? null;
}
