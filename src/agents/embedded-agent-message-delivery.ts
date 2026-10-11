import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import {
  listMessageReceiptSourceTargets,
  resolveMessageReceiptPrimaryId,
} from "../channels/message/receipt.js";
import type { MessageReceipt } from "../channels/message/types.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import type { MessagePollResult, MessageSendResult } from "../infra/outbound/message.js";
import { normalizeMessageDeliveryStatus } from "./embedded-agent-messaging-status.js";
import type { AgentToolResult } from "./runtime/index.js";

export type EmbeddedMessageDeliveryFact = {
  status: "settled" | "suppressed" | "dryRun" | "failed";
  sourceReplyDelivered?: true;
  primaryPlatformMessageId?: string;
  deliveredTargets?: string[];
  partialDelivery: boolean;
  createdThreadIds: string[];
};

const NON_DELIVERY_IDS = new Set(["skipped", "suppressed"]);
const NON_DELIVERY_STATUSES = new Set(["failed", ...NON_DELIVERY_IDS]);
const STATUSES = new Set(["settled", "suppressed", "dryRun", "failed"]);
const PLUGIN_ENVELOPE_KEYS = [
  "details",
  "payload",
  "result",
  "results",
  "sendResult",
  "toolResult",
];

const EMPTY_DELIVERY_FACT: Pick<
  EmbeddedMessageDeliveryFact,
  "partialDelivery" | "createdThreadIds"
> = {
  partialDelivery: false,
  createdThreadIds: [],
};

function isDeliveryStatus(value: unknown): value is EmbeddedMessageDeliveryFact["status"] {
  return typeof value === "string" && STATUSES.has(value);
}

function deliveryId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id && !NON_DELIVERY_IDS.has(id.toLowerCase()) ? id : undefined;
}

function projectReceiptDelivery(delivery?: {
  receipt?: MessageReceipt;
  messageId?: string;
  pollId?: string;
}): EmbeddedMessageDeliveryFact {
  const receipt = delivery?.receipt;
  const primaryPlatformMessageId = [
    receipt ? resolveMessageReceiptPrimaryId(receipt) : undefined,
    delivery?.messageId,
    delivery?.pollId,
    ...(receipt?.parts.map((part) => part.platformMessageId) ?? []),
  ]
    .map(deliveryId)
    .find(Boolean);
  const createdThreadIds = [
    receipt?.threadId,
    ...(receipt?.parts.map((part) => part.threadId) ?? []),
  ].flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim()] : []));
  return {
    status: primaryPlatformMessageId ? "settled" : "failed",
    ...(primaryPlatformMessageId ? { primaryPlatformMessageId } : {}),
    partialDelivery: false,
    createdThreadIds: [...new Set(createdThreadIds)],
  };
}

type PluginEnvelopePredicate = (
  record: Record<string, unknown>,
  status: string | undefined,
) => boolean;

function visitPluginEnvelope(
  value: unknown,
  predicate: PluginEnvelopePredicate,
  depth = 0,
): boolean {
  if (depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => visitPluginEnvelope(item, predicate, depth + 1));
  }
  if (!isRecord(value)) {
    return false;
  }
  const status =
    normalizeMessageDeliveryStatus(value.deliveryStatus) ??
    normalizeMessageDeliveryStatus(value.status);
  if (predicate(value, status)) {
    return true;
  }
  if (typeof value.text === "string") {
    const parsed = safeParseJsonRecord(value.text);
    if (parsed && visitPluginEnvelope(parsed, predicate, depth + 1)) {
      return true;
    }
  }
  if (
    Array.isArray(value.content) &&
    value.content.some((item) => visitPluginEnvelope(item, predicate, depth + 1))
  ) {
    return true;
  }
  return PLUGIN_ENVELOPE_KEYS.some((key) => visitPluginEnvelope(value[key], predicate, depth + 1));
}

const PLUGIN_SIGNALS = {
  dryRun: (record: Record<string, unknown>, status: string | undefined) =>
    record.dryRun === true ||
    status === "dry_run" ||
    normalizeMessageDeliveryStatus(record.status) === "dry_run",
  failure: (record: Record<string, unknown>) =>
    record.ok === false ||
    record.success === false ||
    record.isError === true ||
    record.delivered === false ||
    record.complete === false ||
    Boolean(record.error) ||
    [record.status, record.deliveryStatus].some((value) => {
      const status = normalizeMessageDeliveryStatus(value);
      return (
        status === "error" ||
        status === "incomplete" ||
        status === "partial_failed" ||
        status === "dry_run" ||
        (status !== undefined && NON_DELIVERY_STATUSES.has(status))
      );
    }),
  partial: (record: Record<string, unknown>, status: string | undefined) =>
    record.sentBeforeError === true ||
    record.visibleReplySent === true ||
    status === "partial_failed",
  conversation: (record: Record<string, unknown>) =>
    [
      record.topicId,
      record.threadId,
      record.messageThreadId,
      asOptionalRecord(record.thread)?.id,
    ].some((id) => hasNonEmptyString(id) || (typeof id === "number" && Number.isFinite(id))),
  nonDelivery: (record: Record<string, unknown>, status: string | undefined) => {
    const id = normalizeMessageDeliveryStatus(record.messageId);
    return (
      (id !== undefined && NON_DELIVERY_IDS.has(id)) ||
      (status !== undefined && NON_DELIVERY_STATUSES.has(status))
    );
  },
  noOp: (record: Record<string, unknown>, status: string | undefined) => {
    const removed = record.removed;
    return (
      removed === null ||
      removed === false ||
      removed === 0 ||
      (Array.isArray(removed) && removed.length === 0) ||
      record.applied === false ||
      record.changed === false ||
      record.created === false ||
      record.deleted === false ||
      record.sent === false ||
      record.updated === false ||
      status === "noop" ||
      status === "no_op" ||
      status === "not_found"
    );
  },
  delivery: (record: Record<string, unknown>, status: string | undefined): boolean =>
    PLUGIN_SIGNALS.deliveryId(record) ||
    status === "sent" ||
    normalizeMessageDeliveryStatus(record.text) === "sent",
  deliveryId: (record: Record<string, unknown>) =>
    [record.messageId, record.pollId, asOptionalRecord(record.message)?.id]
      .map(normalizeMessageDeliveryStatus)
      .some((id) => Boolean(id && !NON_DELIVERY_IDS.has(id))),
  ok: (record: Record<string, unknown>) =>
    record.ok === true || normalizeMessageDeliveryStatus(record.text) === "ok",
} satisfies Record<string, PluginEnvelopePredicate>;

export function pluginEnvelopeHas(value: unknown, signal: keyof typeof PLUGIN_SIGNALS): boolean {
  return visitPluginEnvelope(value, PLUGIN_SIGNALS[signal]);
}

function readPluginDeliveryIdentity(value: unknown) {
  let primaryPlatformMessageId: string | undefined;
  const deliveredTargets = new Set<string>();
  const createdThreadIds = new Set<string>();
  visitPluginEnvelope(value, (record) => {
    primaryPlatformMessageId ??= [
      record.messageId,
      record.pollId,
      asOptionalRecord(record.message)?.id,
    ]
      .map(deliveryId)
      .find(Boolean);
    for (const target of listMessageReceiptSourceTargets(record)) {
      deliveredTargets.add(target);
    }
    const receipt = asOptionalRecord(record.receipt);
    const parts = Array.isArray(receipt?.parts) ? receipt.parts : [];
    for (const id of [
      record.topicId,
      record.threadId,
      record.messageThreadId,
      asOptionalRecord(record.thread)?.id,
      receipt?.threadId,
      ...parts.map((part) => asOptionalRecord(part)?.threadId),
    ]) {
      if (hasNonEmptyString(id)) {
        createdThreadIds.add(id.trim());
      } else if (typeof id === "number" && Number.isFinite(id)) {
        createdThreadIds.add(String(id));
      }
    }
    return false;
  });
  return {
    ...(primaryPlatformMessageId ? { primaryPlatformMessageId } : {}),
    ...(deliveredTargets.size ? { deliveredTargets: [...deliveredTargets] } : {}),
    createdThreadIds: [...createdThreadIds],
  };
}

export function projectPluginMessageDeliveryFact(
  value: unknown,
): EmbeddedMessageDeliveryFact | undefined {
  if (pluginEnvelopeHas(value, "dryRun")) {
    return { status: "dryRun", ...EMPTY_DELIVERY_FACT };
  }
  if (pluginEnvelopeHas(value, "partial")) {
    return { status: "settled", partialDelivery: true, createdThreadIds: [] };
  }
  if (pluginEnvelopeHas(value, "nonDelivery")) {
    return { status: "suppressed", ...EMPTY_DELIVERY_FACT };
  }
  if (pluginEnvelopeHas(value, "noOp") || pluginEnvelopeHas(value, "failure")) {
    return { status: "failed", ...EMPTY_DELIVERY_FACT };
  }
  if (!pluginEnvelopeHas(value, "delivery") && !pluginEnvelopeHas(value, "ok")) {
    return undefined;
  }
  return {
    ...EMPTY_DELIVERY_FACT,
    ...readPluginDeliveryIdentity(value),
    status: "settled",
  };
}

export function pluginBroadcastHasDelivery(value: unknown): boolean {
  return visitPluginEnvelope(
    value,
    (record) =>
      Array.isArray(record.results) &&
      record.results.some((item) => {
        const entry = asOptionalRecord(item);
        if (!entry || entry.ok !== true || pluginEnvelopeHas(entry, "nonDelivery")) {
          return false;
        }
        return [entry.payload, entry.toolResult].some(
          (payload) => projectPluginMessageDeliveryFact(payload)?.status === "settled",
        );
      }),
  );
}

function projectSend(result: MessageSendResult): EmbeddedMessageDeliveryFact {
  const delivery = result.result;
  const fact = projectReceiptDelivery(delivery);
  const partialDelivery =
    result.deliveryStatus === "partial_failed" || result.sentBeforeError === true;
  const nonDeliveryId =
    typeof delivery?.messageId === "string" &&
    NON_DELIVERY_IDS.has(delivery.messageId.trim().toLowerCase());
  const status = result.dryRun
    ? "dryRun"
    : partialDelivery
      ? "settled"
      : result.deliveryStatus === "suppressed" || nonDeliveryId
        ? "suppressed"
        : result.deliveryStatus === "sent" || fact.primaryPlatformMessageId
          ? "settled"
          : "failed";
  return { ...fact, status, partialDelivery };
}

function projectPoll(result: MessagePollResult): EmbeddedMessageDeliveryFact {
  const fact = projectReceiptDelivery(result.result);
  return result.dryRun ? { ...fact, status: "dryRun" } : fact;
}

export function projectEmbeddedMessageDeliveryFact(
  result: MessageActionResult,
  currentSourceReply = false,
): EmbeddedMessageDeliveryFact | undefined {
  const payloadDelivery = result.dryRun
    ? undefined
    : projectPluginMessageDeliveryFact(result.payload);
  const partialDelivery = payloadDelivery?.partialDelivery ? payloadDelivery : undefined;
  if (currentSourceReply && result.handledBy === "plugin") {
    return result.dryRun
      ? { status: "dryRun", ...EMPTY_DELIVERY_FACT }
      : projectPluginMessageDeliveryFact(result.payload);
  }
  if (result.kind === "send") {
    return result.handledBy === "core" && result.sendResult
      ? projectSend(result.sendResult)
      : result.handledBy === "internal-source"
        ? {
            status: result.dryRun ? "dryRun" : "settled",
            partialDelivery: false,
            createdThreadIds: [],
          }
        : partialDelivery;
  }
  if (result.kind === "poll") {
    return result.handledBy === "core" && result.pollResult
      ? projectPoll(result.pollResult)
      : partialDelivery;
  }
  if (result.kind !== "broadcast") {
    return partialDelivery;
  }
  const entries = result.payload.results.map((entry) => ({
    entry,
    // The broadcast producer normalizes plugin tool output into payload; toolResult is only a
    // legacy visible-envelope shape accepted by pluginBroadcastHasDelivery.
    fact: entry.result
      ? projectSend(entry.result)
      : entry.sentBeforeError
        ? { status: "settled" as const, partialDelivery: true, createdThreadIds: [] }
        : entry.ok
          ? projectPluginMessageDeliveryFact(entry.payload)
          : undefined,
  }));
  const facts = entries.flatMap(({ fact }) => (fact ? [fact] : []));
  const settled = facts.find((fact) => fact.status === "settled");
  if (settled) {
    return entries.some(({ entry }) => !entry.ok) && !settled.partialDelivery
      ? { ...settled, partialDelivery: true }
      : settled;
  }
  if (entries.some(({ entry, fact }) => entry.ok && !entry.result && !fact)) {
    return undefined;
  }
  return (
    facts.find((fact) => fact.status === "suppressed") ??
    facts.find((fact) => fact.status === "dryRun") ?? {
      status: "failed",
      partialDelivery: false,
      createdThreadIds: [],
    }
  );
}

export function hasAcceptedBroadcastDelivery(result: MessageActionResult): boolean {
  return (
    !result.dryRun &&
    result.kind === "broadcast" &&
    result.payload.results.some((entry) => entry.ok || entry.sentBeforeError)
  );
}

export function attachEmbeddedMessageDeliveryFact(
  result: AgentToolResult<unknown>,
  fact: EmbeddedMessageDeliveryFact | undefined,
): AgentToolResult<unknown> {
  const details = asOptionalRecord(result.details);
  if (!fact) {
    if (!details || !("messageDelivery" in details)) {
      return result;
    }
    const { messageDelivery: _reserved, ...rest } = details;
    return { ...result, details: rest };
  }
  return { ...result, details: { ...details, messageDelivery: fact } };
}

export function isDeliveredCoreCurrentChannelWidgetResult(params: {
  coreBuiltinToolNames?: ReadonlySet<string>;
  sourceReplyDeliveryMode?: string;
  toolName: string;
  result: unknown;
  isToolError: boolean;
}): boolean {
  if (
    params.sourceReplyDeliveryMode !== "message_tool_only" ||
    params.toolName !== "show_widget" ||
    params.isToolError ||
    params.coreBuiltinToolNames?.has("show_widget") !== true
  ) {
    return false;
  }
  const details = asOptionalRecord(asOptionalRecord(params.result)?.details);
  const presentation = asOptionalRecord(details?.presentation);
  const receipt = asOptionalRecord(presentation?.receipt);
  if (details?.kind !== "widget" || presentation?.target !== "current_channel") {
    return false;
  }
  const receiptIds = [
    receipt?.primaryPlatformMessageId,
    ...(Array.isArray(receipt?.platformMessageIds) ? receipt.platformMessageIds : []),
    ...(Array.isArray(receipt?.parts)
      ? receipt.parts.map((part) => asOptionalRecord(part)?.platformMessageId)
      : []),
  ];
  return receiptIds.some((id) => hasNonEmptyString(id));
}

export function readEmbeddedMessageDeliveryFact(
  value: unknown,
): EmbeddedMessageDeliveryFact | undefined {
  const fact = asOptionalRecord(value);
  const createdThreadIds = Array.isArray(fact?.createdThreadIds)
    ? fact.createdThreadIds.filter((id): id is string => typeof id === "string")
    : [];
  if (
    !fact ||
    !isDeliveryStatus(fact.status) ||
    typeof fact.partialDelivery !== "boolean" ||
    !Array.isArray(fact.createdThreadIds) ||
    createdThreadIds.length !== fact.createdThreadIds.length ||
    (fact.primaryPlatformMessageId !== undefined &&
      typeof fact.primaryPlatformMessageId !== "string")
  ) {
    return undefined;
  }
  return {
    status: fact.status,
    ...(fact.status === "settled" && !fact.partialDelivery && fact.sourceReplyDelivered === true
      ? { sourceReplyDelivered: true as const }
      : {}),
    ...(fact.primaryPlatformMessageId
      ? { primaryPlatformMessageId: fact.primaryPlatformMessageId }
      : {}),
    partialDelivery: fact.partialDelivery,
    createdThreadIds,
  };
}
