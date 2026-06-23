import { guardMessageDeliveryReceiptText } from "./message-delivery-receipt-guard.js";
import type { MessageDeliveryEvidence } from "./message-delivery-receipts.js";

export type MessageDeliveryReceiptStreamData = {
  text: string;
  delta: string;
  replace?: true;
  mediaUrls?: string[];
  phase?: unknown;
};

export function guardMessageDeliveryReceiptStreamData<
  T extends MessageDeliveryReceiptStreamData,
>(params: { data: T; enabled?: boolean; evidence?: readonly MessageDeliveryEvidence[] }): T {
  if (params.enabled !== true) {
    return params.data;
  }
  const receiptGuard = guardMessageDeliveryReceiptText({
    text: params.data.text,
    evidence: params.evidence,
  });
  if (receiptGuard.allowed) {
    return params.data;
  }
  return {
    ...params.data,
    text: receiptGuard.replacementText,
    delta: receiptGuard.replacementText,
    replace: true,
  };
}
