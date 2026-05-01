import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Merchant, PaymentProviderId, Receipt } from "./types.js";

// ---------------------------------------------------------------------------
// AuditRecord type
// ---------------------------------------------------------------------------

export type AuditRecord = {
  openclawPaymentId: string;
  credentialHandleId?: string;
  providerId: PaymentProviderId;
  providerRequestId?: string;
  amountCents?: number;
  currency?: string;
  merchant?: Merchant;
  status: "pending" | "approved" | "denied" | "executed" | "settled" | "failed" | "expired";
  timestamps: { createdAt: string; updatedAt?: string };
  display?: {
    brand?: string;
    last4?: string;
    expMonth?: string;
    expYear?: string;
    validUntil?: string;
  };
  receipt?: Receipt;
};

// ---------------------------------------------------------------------------
// Luhn validation helper (for redaction detection only — not for issuing cards)
// ---------------------------------------------------------------------------

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Returns true if the string (stripped of spaces) looks like a PAN:
 * 13-19 digits and passes Luhn check.
 */
function isPanShape(value: string): boolean {
  const digits = value.replace(/\s+/g, "");
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  return luhnCheck(digits);
}

/** Key names that indicate a CVV-like value. Case-insensitive. */
const CVV_KEY_PATTERN = /^(cvv2?|cvc2?|card_?security_?code|security_?code)$/i;

// ---------------------------------------------------------------------------
// redactSensitiveValue
// ---------------------------------------------------------------------------

/**
 * Recursively walks an object and replaces:
 * - PAN-shaped strings (13-19 digits, Luhn-valid, with/without spaces) with "[REDACTED]"
 * - Strings in CVV-key contexts (keys matching cvv/cvc/etc.) with "[REDACTED]"
 * - Authorization header values starting with "Payment " with "[REDACTED]"
 *
 * Never throws. Returns input unchanged on unknown/primitive input where
 * redaction is not applicable.
 */
export function redactSensitiveValue(input: unknown): unknown {
  return redact(input, null);
}

function redact(value: unknown, parentKey: string | null): unknown {
  try {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === "string") {
      // CVV-key context: redact any string when parentKey is a CVV key
      if (parentKey !== null && CVV_KEY_PATTERN.test(parentKey)) {
        return "[REDACTED]";
      }
      // Authorization header: redact Payment tokens
      if (
        parentKey !== null &&
        parentKey.toLowerCase() === "authorization" &&
        value.startsWith("Payment ")
      ) {
        return "[REDACTED]";
      }
      // PAN-shaped string
      if (isPanShape(value)) {
        return "[REDACTED]";
      }
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => redact(item, null));
    }
    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        result[key] = redact(child, key);
      }
      return result;
    }
    return value;
  } catch {
    // Defensive: never throw
    return value;
  }
}

// ---------------------------------------------------------------------------
// expandStorePath
// ---------------------------------------------------------------------------

/**
 * Expands a leading `~` to `os.homedir()` and resolves the path to absolute.
 * Pure function — does not touch the filesystem.
 */
export function expandStorePath(rawPath: string): string {
  if (rawPath.startsWith("~/") || rawPath === "~") {
    return path.resolve(os.homedir() + rawPath.slice(1));
  }
  return path.resolve(rawPath);
}

// ---------------------------------------------------------------------------
// appendAuditRecord / readAuditRecords
// ---------------------------------------------------------------------------

/**
 * Appends a JSON line to the JSONL audit store at `storePath`.
 * Redacts sensitive values before writing (last-line-of-defense per R10).
 * Creates the directory if it doesn't exist.
 */
export async function appendAuditRecord(storePath: string, record: AuditRecord): Promise<void> {
  const redacted = redactSensitiveValue(record) as AuditRecord;
  const line = `${JSON.stringify(redacted)}\n`;
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.appendFile(storePath, line, "utf8");
}

/**
 * Reads the JSONL file at `storePath` line-by-line and returns parsed records.
 * Skips malformed lines with a console.warn (V1 — no injected logger yet).
 * Returns an empty array if the file does not exist.
 */
export async function readAuditRecords(storePath: string): Promise<AuditRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const records: AuditRecord[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as AuditRecord;
      records.push(parsed);
    } catch {
      console.warn(`[payment/store] Skipping malformed audit record line: ${trimmed.slice(0, 80)}`);
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// In-memory handle map
// ---------------------------------------------------------------------------

export type HandleMetadata = {
  spendRequestId: string;
  last4?: string;
  targetMerchantName?: string;
  issuedAt: string;
  validUntil?: string;
};

/**
 * In-memory only. Cleared on process restart. Stores no sensitive card values
 * — see store.ts redaction discipline.
 */
export const handleMap = {
  _map: new Map<string, HandleMetadata>(),

  set(handleId: string, meta: HandleMetadata): void {
    this._map.set(handleId, meta);
  },

  get(handleId: string): HandleMetadata | undefined {
    return this._map.get(handleId);
  },

  delete(handleId: string): void {
    this._map.delete(handleId);
  },

  size(): number {
    return this._map.size;
  },
};
