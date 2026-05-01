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
 * Returns true if the string (stripped of spaces/dashes) looks like a PAN:
 * 13-19 digits and passes Luhn check.
 */
function isPanShape(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  return luhnCheck(digits);
}

/**
 * Scan-and-replace embedded PAN matches within a string, with separator tolerance.
 * Replaces each Luhn-valid 13-19 digit cluster (digits optionally separated by spaces
 * or hyphens) with "[REDACTED]". Preserves surrounding text.
 *
 * Applied before the whole-string PAN check so that strings like
 * "Card 4242424242424242 declined" are correctly sanitized.
 */
function redactPansInString(input: string): string {
  return input.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnCheck(digits)) return match;
    return "[REDACTED]";
  });
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
  return redact(input, null, new WeakSet<object>());
}

function redact(value: unknown, parentKey: string | null, seen: WeakSet<object>): unknown {
  try {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === "string") {
      // CVV-key context: redact any string when parentKey is a CVV key
      if (parentKey !== null && CVV_KEY_PATTERN.test(parentKey)) {
        return "[REDACTED]";
      }
      // Authorization / Proxy-Authorization header: redact Payment tokens.
      // Matches redact-primitives.ts: case-insensitive key check for both
      // "authorization" and "proxy-authorization", case-insensitive Payment prefix,
      // allows leading whitespace, requires at least one non-whitespace token after.
      if (
        parentKey !== null &&
        (parentKey.toLowerCase() === "authorization" ||
          parentKey.toLowerCase() === "proxy-authorization") &&
        /^\s*Payment\s+\S/i.test(value)
      ) {
        return "[REDACTED]";
      }
      // Embedded-PAN scan-and-replace (separator-tolerant): catches PANs embedded
      // in error messages, free-text fields, and strings with dashes/spaces.
      // Run BEFORE the whole-string isPanShape check.
      const scanned = redactPansInString(value);
      if (scanned !== value) {
        return scanned;
      }
      // Whole-string PAN check (now redundant for pure-PAN strings, but kept for
      // backward compatibility and to handle any edge case the regex misses).
      if (isPanShape(value)) {
        return "[REDACTED]";
      }
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      return value.map((item) => redact(item, parentKey, seen));
    }
    if (typeof value === "object") {
      if (seen.has(value as object)) {
        return "[Circular]";
      }
      seen.add(value as object);
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        result[key] = redact(child, key, seen);
      }
      return result;
    }
    return value;
  } catch {
    // Fail-closed: any unexpected error in redaction must not pass sensitive data through.
    return "[REDACTED]";
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
// Per-path write queue (I3: concurrency safety for JSONL appends)
// ---------------------------------------------------------------------------

const writeQueues = new Map<string, Promise<void>>();

async function withWriteQueue(filePath: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn whether or not prev rejected
  writeQueues.set(filePath, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
  }
}

// ---------------------------------------------------------------------------
// appendAuditRecord / readAuditRecords
// ---------------------------------------------------------------------------

/**
 * Appends a JSON line to the JSONL audit store at `storePath`.
 * Redacts sensitive values before writing (last-line-of-defense per R10).
 * Creates the directory if it doesn't exist.
 * Uses a per-path write queue to prevent byte interleaving under concurrency.
 */
export async function appendAuditRecord(storePath: string, record: AuditRecord): Promise<void> {
  const absPath = path.resolve(storePath);
  await withWriteQueue(absPath, async () => {
    const redacted = redactSensitiveValue(record) as AuditRecord;
    const line = `${JSON.stringify(redacted)}\n`;
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.appendFile(absPath, line, "utf8");
  });
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
// In-memory handle map with JSONL persistence (Codex P2-5)
// ---------------------------------------------------------------------------

export type HandleMetadata = {
  spendRequestId: string;
  providerId: PaymentProviderId;
  last4?: string;
  targetMerchantName?: string;
  issuedAt: string;
  validUntil?: string;
};

/** Persisted JSONL record shape: handleId + HandleMetadata */
type HandleRecord = { handleId: string } & HandleMetadata;

const ALLOWED_HANDLE_METADATA_KEYS = new Set([
  "spendRequestId",
  "providerId",
  "last4",
  "targetMerchantName",
  "issuedAt",
  "validUntil",
] as const);

/**
 * The absolute path to handles.jsonl, set by initHandleStore().
 * Undefined means no persistence configured (in-memory only).
 */
let _handleStorePath: string | undefined;

/**
 * Configure where handles.jsonl lives and pre-load existing entries into memory.
 * Call this once at PaymentManager creation (before any get/set).
 * No-op if already initialized to the same path.
 *
 * Returns the number of handle entries loaded from disk.
 *
 * TODO: Stream-parse the JSONL file once it grows past a few MB.
 */
export async function initHandleStore(storePath: string): Promise<number> {
  const absPath = path.resolve(storePath, "handles.jsonl");
  _handleStorePath = absPath;

  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0; // file doesn't exist yet — normal on first run
    }
    throw err;
  }

  let loaded = 0;
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as HandleRecord;
      if (!record.handleId || !record.spendRequestId || !record.providerId) continue;
      // Validate keys before loading into memory — skip the entire record if any
      // disallowed key is present (defense against tampered JSONL files).
      const { handleId, ...meta } = record;
      let hasDisallowedKey = false;
      for (const key of Object.keys(meta)) {
        if (!ALLOWED_HANDLE_METADATA_KEYS.has(key as never)) {
          hasDisallowedKey = true;
          break;
        }
      }
      if (hasDisallowedKey) continue;
      handleMap._map.set(handleId, meta as HandleMetadata);
      loaded++;
    } catch {
      console.warn(`[payment/store] Skipping malformed handle record: ${trimmed.slice(0, 80)}`);
    }
  }
  return loaded;
}

/**
 * Append a single HandleRecord to the handles.jsonl file.
 * Uses the per-path write queue to avoid concurrent-write corruption.
 * No-op if _handleStorePath is not configured (in-memory only mode).
 */
async function appendHandleRecord(handleId: string, meta: HandleMetadata): Promise<void> {
  if (!_handleStorePath) return;
  const absPath = _handleStorePath;
  await withWriteQueue(absPath, async () => {
    const record: HandleRecord = { handleId, ...meta };
    // Safety check: the allowed-keys guard on handleMap.set already ran,
    // but re-verify here to ensure no sensitive data leaks into the JSONL.
    for (const key of Object.keys(record)) {
      if (key !== "handleId" && !ALLOWED_HANDLE_METADATA_KEYS.has(key as never)) {
        throw new Error(`handleMap persistence: disallowed key "${key}" — not writing to disk`);
      }
    }
    const line = `${JSON.stringify(record)}\n`;
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.appendFile(absPath, line, "utf8");
  });
}

/**
 * In-memory handle map with JSONL persistence.
 * Call initHandleStore(storePath) before using across CLI processes.
 * Stores no sensitive card values — see store.ts redaction discipline.
 */
export const handleMap = {
  _map: new Map<string, HandleMetadata>(),

  set(handleId: string, meta: HandleMetadata): void {
    for (const key of Object.keys(meta)) {
      if (!ALLOWED_HANDLE_METADATA_KEYS.has(key as never)) {
        throw new Error(
          `handleMap: disallowed key "${key}". Allowed: ${[...ALLOWED_HANDLE_METADATA_KEYS].join(", ")}`,
        );
      }
    }
    this._map.set(handleId, meta);
    // Fire-and-forget persistence — do not block the caller.
    // Errors are logged but not surfaced (in-memory set already succeeded).
    appendHandleRecord(handleId, meta).catch((err) => {
      console.warn(`[payment/store] Failed to persist handle ${handleId}: ${String(err)}`);
    });
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
