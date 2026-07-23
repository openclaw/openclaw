import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  verifyChain,
  type AuditEntry,
  type ReviewRequest,
  type SignedReceipt,
} from "../protocol/index.js";
import {
  archiveOversizedLegacySource,
  isFileTooLargeError,
  MAX_LEGACY_AUDIT_FILE_BYTES,
  MAX_LEGACY_DELIVERED_FILE_BYTES,
  MAX_LEGACY_REPLAY_FILE_BYTES,
  MAX_LEGACY_REVIEWS_FILE_BYTES,
  readLegacyReefFileSafely,
} from "./doctor-legacy-io.js";
import { reefReplayStoreKey, type ReefReplayRecord, type ReefReviewRecord } from "./state.js";

export type ReefAuditMigrationRecord = { pending: true; expectedEntries?: number };

export async function handleOversizedLegacyFile(
  error: unknown,
  filePath: string,
  label: string,
  changes: string[],
  warnings: string[],
): Promise<boolean> {
  if (!isFileTooLargeError(error)) {
    return false;
  }
  warnings.push(
    `${label} exceeds safe migration size cap; archived to ${filePath}.migrated for manual recovery`,
  );
  await archiveOversizedLegacySource({ filePath, label, changes, warnings });
  return true;
}

export async function readLegacyReefAudit(filePath: string): Promise<AuditEntry[]> {
  const raw = await readLegacyReefFileSafely(filePath, MAX_LEGACY_AUDIT_FILE_BYTES);
  const entries = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
  if (!verifyChain(entries)) {
    throw new Error("invalid Reef audit chain");
  }
  return entries;
}

type LegacyReefReplayLogRecord =
  | { op: "claim"; peer: string; id: string; envelopeHash: string }
  | { op: "complete"; peer: string; id: string; receipt: SignedReceipt; body?: { enc: string } }
  | { op: "consume" | "release"; peer: string; id: string };

function requireLegacyReplayString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid Reef replay ${field}`);
  }
  return value;
}

function parseLegacyReefReplayLine(value: unknown): LegacyReefReplayLogRecord {
  if (!isRecord(value)) {
    throw new Error("invalid Reef replay record");
  }
  const peer = requireLegacyReplayString(value, "peer");
  const id = requireLegacyReplayString(value, "id");
  if (value.op === "claim") {
    return {
      op: "claim",
      peer,
      id,
      envelopeHash: requireLegacyReplayString(value, "envelopeHash"),
    };
  }
  if (value.op === "consume" || value.op === "release") {
    return { op: value.op, peer, id };
  }
  if (value.op !== "complete" || !isRecord(value.receipt)) {
    throw new Error("invalid Reef replay operation");
  }
  const receipt = value.receipt as unknown as SignedReceipt;
  if (receipt.id !== id || !["accepted", "rejected"].includes(receipt.status)) {
    throw new Error("invalid Reef replay receipt");
  }
  const body = value.body;
  if (
    (receipt.status === "accepted" && (!isRecord(body) || typeof body.enc !== "string")) ||
    (receipt.status === "rejected" && body !== undefined)
  ) {
    throw new Error("invalid Reef replay completion");
  }
  return {
    op: "complete",
    peer,
    id,
    receipt,
    ...(isRecord(body) && typeof body.enc === "string" ? { body: { enc: body.enc } } : {}),
  };
}

export async function readLegacyReefReplay(filePath: string): Promise<ReefReplayRecord[]> {
  const raw = await readLegacyReefFileSafely(filePath, MAX_LEGACY_REPLAY_FILE_BYTES);
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const records = new Map<string, ReefReplayRecord>();
  for (const [index, line] of lines.entries()) {
    let log: LegacyReefReplayLogRecord;
    try {
      log = parseLegacyReefReplayLine(JSON.parse(line) as unknown);
    } catch (error) {
      // The old append-only store tolerated only a torn final write.
      if (index === lines.length - 1 && !raw.endsWith("\n")) {
        break;
      }
      throw error;
    }
    const key = reefReplayStoreKey(log.peer, log.id);
    const existing = records.get(key);
    let next: ReefReplayRecord;
    if (log.op === "claim") {
      if (existing && existing.envelopeHash !== log.envelopeHash) {
        throw new Error("conflicting Reef replay binding");
      }
      next = {
        peer: log.peer,
        id: log.id,
        envelopeHash: log.envelopeHash,
        state: "available",
      };
    } else {
      if (!existing) {
        throw new Error(`Reef replay ${log.op} lacks claim`);
      }
      if (log.op === "complete") {
        next = {
          ...existing,
          state: "completed",
          receipt: log.receipt,
          ...(log.body ? { body: log.body } : {}),
        };
      } else if (log.op === "consume") {
        next = {
          peer: existing.peer,
          id: existing.id,
          envelopeHash: existing.envelopeHash,
          state: "consumed",
        };
      } else {
        next = { ...existing, state: "available" };
      }
    }
    records.delete(key);
    records.set(key, next);
  }
  return [...records.values()];
}

export async function readLegacyReefReviews(
  filePath: string,
): Promise<Map<string, ReefReviewRecord>> {
  const raw = await readLegacyReefFileSafely(filePath, MAX_LEGACY_REVIEWS_FILE_BYTES);
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error("invalid Reef reviews file");
  }
  const records = new Map<string, ReefReviewRecord>();
  for (const [digest, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isRecord(entry.review)) {
      throw new Error(`invalid Reef review ${digest}`);
    }
    const review = entry.review as unknown as ReviewRequest;
    if (
      review.approvalDigest !== digest ||
      (entry.approved !== undefined && typeof entry.approved !== "boolean")
    ) {
      throw new Error(`invalid Reef review ${digest}`);
    }
    records.set(digest, {
      review,
      ...(typeof entry.approved === "boolean" ? { approved: entry.approved } : {}),
    });
  }
  return records;
}

export async function readLegacyReefDelivered(filePath: string): Promise<string[]> {
  const raw = await readLegacyReefFileSafely(filePath, MAX_LEGACY_DELIVERED_FILE_BYTES);
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("invalid Reef delivered file");
  }
  return [...new Set(value)];
}
