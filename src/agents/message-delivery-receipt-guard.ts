import {
  detectMessageDeliveryReceiptClaims,
  type MessageDeliveryReceiptClaim,
} from "./message-delivery-receipt-claims.js";
import type { MessageDeliveryEvidence } from "./message-delivery-receipts.js";

export type MessageDeliveryReceiptGuardResult =
  | { allowed: true }
  | { allowed: false; replacementText: string; claim: MessageDeliveryReceiptClaim };

function normalizePhoneComparable(value: string | undefined): string | undefined {
  return value?.replace(/\D+/gu, "") || undefined;
}

function normalizeUsLocalPhoneComparable(value: string | undefined): string | undefined {
  const digits = normalizePhoneComparable(value);
  return digits?.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function phoneComparablesMatch(left: string | undefined, right: string | undefined): boolean {
  return (
    normalizePhoneComparable(left) === normalizePhoneComparable(right) ||
    normalizeUsLocalPhoneComparable(left) === normalizeUsLocalPhoneComparable(right)
  );
}

function statusComparablesMatch(left: string | undefined, right: string | undefined): boolean {
  const leftParts = new Set(
    left
      ?.toLowerCase()
      .split(/[/\s]+/u)
      .filter(Boolean),
  );
  const rightParts = new Set(
    right
      ?.toLowerCase()
      .split(/[/\s]+/u)
      .filter(Boolean),
  );
  if (leftParts.size === 0 || rightParts.size === 0) {
    return left === right;
  }
  return [...leftParts].some((part) => rightParts.has(part));
}

function evidenceMatchesClaim(
  evidence: MessageDeliveryEvidence,
  claim: MessageDeliveryReceiptClaim,
): boolean {
  if (evidence.channel !== claim.channel) {
    return false;
  }
  let matchedClaimDiscriminator = false;
  if (claim.providerId && evidence.providerId !== claim.providerId) {
    return false;
  } else if (claim.providerId) {
    matchedClaimDiscriminator = true;
  }
  if (claim.recipient && !phoneComparablesMatch(evidence.recipient, claim.recipient)) {
    return false;
  } else if (claim.recipient) {
    matchedClaimDiscriminator = true;
  }
  if (claim.sender && !phoneComparablesMatch(evidence.sender, claim.sender)) {
    return false;
  } else if (claim.sender) {
    matchedClaimDiscriminator = true;
  }
  if (claim.status && !statusComparablesMatch(evidence.status, claim.status)) {
    return false;
  } else if (claim.status) {
    matchedClaimDiscriminator = true;
  }
  return matchedClaimDiscriminator && Boolean(evidence.providerId || evidence.status);
}

export function guardMessageDeliveryReceiptText(params: {
  text: string;
  evidence?: readonly MessageDeliveryEvidence[];
}): MessageDeliveryReceiptGuardResult {
  const claims = detectMessageDeliveryReceiptClaims(params.text);
  if (claims.length === 0) {
    return { allowed: true };
  }
  const unsupportedClaim = claims.find(
    (claim) => !(params.evidence ?? []).some((record) => evidenceMatchesClaim(record, claim)),
  );
  if (!unsupportedClaim) {
    return { allowed: true };
  }
  return {
    allowed: false,
    claim: unsupportedClaim,
    replacementText:
      "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
  };
}
