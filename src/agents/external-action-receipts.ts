import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  isValidPluginExternalActionEvidenceRegistration,
  type PluginExternalActionEvidenceRegistration,
} from "../plugins/host-hooks.js";

export type ExternalActionEvidence = {
  actionFamily: string;
  toolName?: string;
  providerId?: string;
  status?: string;
  sender?: string;
  recipient?: string;
  bodyHash?: string;
  dryRun?: boolean;
};

export type ExternalActionEvidenceDeclaration = PluginExternalActionEvidenceRegistration;

const SUCCESS_STATUSES = new Set([
  "accepted",
  "queued",
  "accepted/queued",
  "sent",
  "delivered",
  "created",
]);
const MESSAGE_TOOL_SMS_CHANNEL = "sms";

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const record = asOptionalRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[part];
  }
  return current;
}

function readFirstString(value: unknown, paths: readonly string[] | undefined): string | undefined {
  for (const path of paths ?? []) {
    const text = normalizeOptionalString(readPath(value, path));
    if (text) {
      return text;
    }
  }
  return undefined;
}

function readFirstStringified(
  value: unknown,
  paths: readonly string[] | undefined,
): string | undefined {
  for (const path of paths ?? []) {
    const text = normalizeStringifiedOptionalString(readPath(value, path));
    if (text) {
      return text;
    }
  }
  return undefined;
}

function readFirstBoolean(value: unknown, paths: readonly string[] | undefined): boolean {
  for (const path of paths ?? []) {
    const raw = readPath(value, path);
    if (raw === true) {
      return true;
    }
    if (typeof raw === "string" && raw.trim().toLowerCase() === "true") {
      return true;
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function normalizeSuccessStatus(value: unknown): string | undefined {
  const status = normalizeOptionalString(value)?.toLowerCase();
  return status && SUCCESS_STATUSES.has(status) ? status : undefined;
}

function normalizeMessageToolSmsReceiptRecord(params: {
  record: Record<string, unknown>;
  fallbackChannel?: string;
  fallbackRecipient?: string;
  toolName?: string;
}): ExternalActionEvidence | null {
  const meta = asRecord(params.record.meta);
  const channel = (
    normalizeOptionalString(params.record.channel) ??
    params.fallbackChannel ??
    ""
  ).toLowerCase();
  if (channel !== MESSAGE_TOOL_SMS_CHANNEL) {
    return null;
  }
  const providerId =
    normalizeStringifiedOptionalString(params.record.messageId) ??
    normalizeStringifiedOptionalString(params.record.platformMessageId);
  const status = normalizeSuccessStatus(meta?.status ?? params.record.status);
  if (!providerId && !status) {
    return null;
  }
  const sender = readFirstString(params.record, ["from"]) ?? normalizeOptionalString(meta?.from);
  const recipient =
    readFirstString(params.record, ["chatId", "toJid", "conversationId", "to"]) ??
    params.fallbackRecipient;
  return {
    actionFamily: MESSAGE_TOOL_SMS_CHANNEL,
    ...(params.toolName ? { toolName: params.toolName } : {}),
    ...(providerId ? { providerId } : {}),
    ...(status ? { status } : {}),
    ...(sender ? { sender } : {}),
    ...(recipient ? { recipient } : {}),
  };
}

function dedupeEvidence(records: ExternalActionEvidence[]): ExternalActionEvidence[] {
  const byKey = new Map<string, ExternalActionEvidence>();
  for (const record of records) {
    const key = [
      record.actionFamily,
      record.toolName ?? "",
      record.providerId ?? "",
      record.recipient ?? "",
    ].join("\0");
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, record);
      continue;
    }
    const currentScore = Object.values(current).filter(Boolean).length;
    const nextScore = Object.values(record).filter(Boolean).length;
    if (nextScore > currentScore) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export const isValidExternalActionEvidenceDeclaration =
  isValidPluginExternalActionEvidenceRegistration;

export function normalizeExternalActionEvidence(params: {
  declaration: ExternalActionEvidenceDeclaration;
  toolName?: string;
  result: unknown;
}): ExternalActionEvidence | null {
  if (!isValidExternalActionEvidenceDeclaration(params.declaration)) {
    return null;
  }
  const actionFamily = normalizeOptionalString(params.declaration.actionFamily);
  if (!actionFamily) {
    return null;
  }
  const status = readFirstString(params.result, params.declaration.successStatusPaths);
  const providerId = readFirstStringified(params.result, params.declaration.providerIdPaths);
  const dryRun = readFirstBoolean(params.result, params.declaration.dryRunPaths);
  const normalizedStatus = status?.toLowerCase();
  if (normalizedStatus && !SUCCESS_STATUSES.has(normalizedStatus)) {
    return null;
  }
  if (dryRun || (!providerId && (!normalizedStatus || !SUCCESS_STATUSES.has(normalizedStatus)))) {
    return null;
  }
  const body = readFirstString(params.result, params.declaration.bodyPaths);
  const sender = readFirstString(params.result, params.declaration.senderPaths);
  const recipient = readFirstString(params.result, params.declaration.recipientPaths);
  return {
    actionFamily: actionFamily.toLowerCase(),
    ...(params.toolName ? { toolName: params.toolName } : {}),
    ...(providerId ? { providerId } : {}),
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
    ...(sender ? { sender } : {}),
    ...(recipient ? { recipient } : {}),
    ...(body ? { bodyHash: hashBody(body) } : {}),
  };
}

export function normalizeMessageToolExternalActionEvidence(params: {
  toolName?: string;
  result: unknown;
}): ExternalActionEvidence[] {
  const root = asRecord(params.result);
  if (!root) {
    return [];
  }
  const receipt = asRecord(root.receipt);
  const fallbackChannel = normalizeOptionalString(root.channel);
  const fallbackRecipient = readFirstString(root, ["chatId", "toJid", "conversationId", "to"]);
  const candidates = [
    root,
    ...asRecordArray(receipt?.raw),
    ...asRecordArray(receipt?.parts).flatMap((part) => {
      const raw = asRecord(part.raw);
      return raw ? [part, raw] : [part];
    }),
  ];
  return dedupeEvidence(
    candidates.flatMap((record) => {
      const evidence = normalizeMessageToolSmsReceiptRecord({
        record,
        fallbackChannel,
        fallbackRecipient,
        toolName: params.toolName,
      });
      return evidence ? [evidence] : [];
    }),
  );
}
