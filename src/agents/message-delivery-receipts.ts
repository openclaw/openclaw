import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";

export type MessageDeliveryEvidence = {
  channel: "sms";
  toolName?: string;
  providerId?: string;
  status?: string;
  sender?: string;
  recipient?: string;
};

const SUCCESS_STATUSES = new Map([
  ["accepted", "accepted"],
  ["queued", "queued"],
  ["accepted/queued", "accepted/queued"],
  ["sent", "sent"],
  ["delivered", "delivered"],
  ["ok", "sent"],
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

function readFirstString(value: unknown, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const text = normalizeOptionalString(readPath(value, path));
    if (text) {
      return text;
    }
  }
  return undefined;
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
  return status ? SUCCESS_STATUSES.get(status) : undefined;
}

function normalizeMessageToolSmsReceiptRecord(params: {
  record: Record<string, unknown>;
  fallbackChannel?: string;
  fallbackRecipient?: string;
  toolName?: string;
}): MessageDeliveryEvidence | null {
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
  const rawStatus =
    params.record.deliveryStatus ??
    meta?.deliveryStatus ??
    meta?.status ??
    params.record.status ??
    (params.record.ok === true && providerId ? "ok" : undefined);
  const status = normalizeSuccessStatus(rawStatus);
  if (normalizeOptionalString(rawStatus) && !status) {
    return null;
  }
  if (!providerId && !status) {
    return null;
  }
  const sender = readFirstString(params.record, ["from"]) ?? normalizeOptionalString(meta?.from);
  const recipient =
    readFirstString(params.record, ["chatId", "toJid", "conversationId", "to"]) ??
    params.fallbackRecipient;
  return {
    channel: MESSAGE_TOOL_SMS_CHANNEL,
    ...(params.toolName ? { toolName: params.toolName } : {}),
    ...(providerId ? { providerId } : {}),
    ...(status ? { status } : {}),
    ...(sender ? { sender } : {}),
    ...(recipient ? { recipient } : {}),
  };
}

function dedupeEvidence(records: MessageDeliveryEvidence[]): MessageDeliveryEvidence[] {
  const byKey = new Map<string, MessageDeliveryEvidence>();
  for (const record of records) {
    const key = [
      record.channel,
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

function collectReceiptCandidateRecords(
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const addRecord = (value: unknown, depth = 0): Record<string, unknown> | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        addRecord(item, depth);
      }
      return undefined;
    }
    const record = asRecord(value);
    if (record) {
      records.push(record);
      if (depth < 3) {
        for (const key of ["details", "result", "results", "sendResult", "payload", "toolResult"]) {
          addRecord(record[key], depth + 1);
        }
      }
    }
    return record;
  };

  addRecord(payload);

  return records.flatMap((record) => {
    const receipt = asRecord(record.receipt);
    const candidates = [record];
    candidates.push(...asRecordArray(receipt?.raw));
    for (const part of asRecordArray(receipt?.parts)) {
      candidates.push(part);
      const raw = asRecord(part.raw);
      if (raw) {
        candidates.push(raw);
      }
    }
    return candidates;
  });
}

export function normalizeMessageToolDeliveryEvidence(params: {
  toolName?: string;
  result: unknown;
}): MessageDeliveryEvidence[] {
  const root = asRecord(params.result);
  if (!root) {
    return [];
  }
  return dedupeEvidence(
    [root, asRecord(root.details)]
      .filter((record): record is Record<string, unknown> => Boolean(record))
      .flatMap((payload) => {
        const fallbackChannel = normalizeOptionalString(payload.channel);
        const fallbackRecipient = readFirstString(payload, [
          "chatId",
          "toJid",
          "conversationId",
          "to",
        ]);
        return collectReceiptCandidateRecords(payload).flatMap((record) => {
          const evidence = normalizeMessageToolSmsReceiptRecord({
            record,
            fallbackChannel,
            fallbackRecipient,
            toolName: params.toolName,
          });
          return evidence ? [evidence] : [];
        });
      }),
  );
}
