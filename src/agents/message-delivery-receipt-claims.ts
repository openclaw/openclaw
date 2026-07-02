import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type MessageDeliveryReceiptClaim = {
  channel: "sms";
  recipient?: string;
  sender?: string;
  providerId?: string;
  status?: string;
};

const SMS_PREFILTER_RE =
  /\b(?:sms|text message)\b[\s\S]{0,240}\b(?:sent|queued|delivered|accepted\/queued|message id|status)\b|\b(?:sent|queued|delivered)\b[\s\S]{0,80}\b(?:sms|text message)\b(?:[\s\S]{0,240}\b(?:message id|status)\b)?|\bSent to\b[\s\S]{0,240}\b(?:To:|Status:|Message ID:)/iu;
const SMS_DELIVERY_ASSERTION_RE =
  /\b(?:Sent to\b|(?:sms|text message)\s+(?:was\s+)?(?:sent|queued|delivered|accepted\/queued)\b|(?:sent|queued|delivered)\s+(?:(?:the|an?|this)\s+)?(?:sms|text message)\b)/giu;
const UNCERTAIN_OR_NEGATED_RE =
  /\b(?:not\s+(?:yet\s+)?sent|never\s+sent|did\s+not\s+send|didn't\s+send|haven't\s+sent|hasn't\s+sent|hadn't\s+sent)\b/iu;
const QUOTED_DIAGNOSTIC_RE = /^\s*(?:>|["']).{0,120}\b(?:Sent to|Status:|Message ID:)/iu;

function captureFirst(text: string, re: RegExp): string | undefined {
  return normalizeOptionalString(re.exec(text)?.[1]);
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
  const status = captureFirst(trimmed, /\bStatus:\s*([A-Za-z][A-Za-z/-]{1,40})/iu);
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
  const hasSmsDeliveryMarker =
    /\b(?:(?:sms|text message)\s+(?:was\s+)?(?:sent|queued|delivered|accepted\/queued)|(?:sent|queued|delivered)\s+(?:(?:the|an?|this)\s+)?(?:sms|text message))\b/iu.test(
      trimmed,
    );
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
