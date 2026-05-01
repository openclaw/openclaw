/**
 * redact.ts — Shared redactor functions for CredentialHandle and
 * MachinePaymentResult.
 *
 * Both functions use field-by-field allowlists at every level of nesting.
 * Adding a new field to CredentialHandle.display or MachinePaymentResult.receipt
 * will NOT silently leak through — it must be explicitly added here.
 */

import type { CredentialHandle, MachinePaymentResult } from "./types.js";

/**
 * Redacts a CredentialHandle for tool/CLI return paths. Field-by-field
 * allowlist at every level — adding a new field to CredentialHandle.display
 * (e.g., a cardToken) will NOT leak through; it must be explicitly added here.
 *
 * MUST NEVER include: pan, cvv, raw expiry digits beyond display.expMonth/expYear,
 * holderName, providerSessionToken, or any other secret material.
 */
export function redactHandle(handle: CredentialHandle): /* RedactedHandle */ unknown {
  return {
    id: handle.id,
    provider: handle.provider,
    rail: handle.rail,
    status: handle.status,
    providerRequestId: handle.providerRequestId,
    validUntil: handle.validUntil,
    display:
      handle.display !== undefined
        ? {
            brand: handle.display.brand,
            last4: handle.display.last4,
            expMonth: handle.display.expMonth,
            expYear: handle.display.expYear,
          }
        : undefined,
    fillSentinels:
      handle.fillSentinels !== undefined
        ? {
            pan: handle.fillSentinels.pan,
            cvv: handle.fillSentinels.cvv,
            exp_month: handle.fillSentinels.exp_month,
            exp_year: handle.fillSentinels.exp_year,
            holder_name: handle.fillSentinels.holder_name,
          }
        : undefined,
  };
}

/**
 * Redacts a MachinePaymentResult for tool/CLI return paths. Same discipline
 * as redactHandle — field-by-field, no spread of nested objects.
 *
 * MUST NEVER include the MPP shared payment token or any provider session token.
 */
export function redactMachinePaymentResult(
  result: MachinePaymentResult,
): /* RedactedResult */ unknown {
  return {
    handleId: result.handleId,
    targetUrl: result.targetUrl,
    outcome: result.outcome,
    receipt:
      result.receipt !== undefined
        ? {
            receiptId: result.receipt.receiptId,
            issuedAt: result.receipt.issuedAt,
            statusCode: result.receipt.statusCode,
          }
        : undefined,
  };
}
