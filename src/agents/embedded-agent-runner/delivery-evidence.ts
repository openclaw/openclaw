import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { hasAcceptedSessionSpawn } from "../accepted-session-spawn.js";

type AgentPayloadLike = {
  text?: unknown;
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  presentation?: unknown;
  interactive?: unknown;
  channelData?: unknown;
  attachments?: unknown;
  isError?: unknown;
  isReasoning?: unknown;
};

export type AgentDeliveryEvidence = {
  payloads?: unknown;
  deliveryStatus?: {
    status?: unknown;
    errorMessage?: unknown;
  };
  didSendViaMessagingTool?: unknown;
  messagingToolSentTexts?: unknown;
  messagingToolSentMediaUrls?: unknown;
  messagingToolSentTargets?: unknown;
  messagingToolSourceReplyPayloads?: unknown;
  acceptedSessionSpawns?: unknown;
  successfulCronAdds?: unknown;
  meta?: unknown;
};

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

export function hasVisibleReplyShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as {
    text?: unknown;
    mediaUrl?: unknown;
    mediaUrls?: unknown;
    presentation?: unknown;
    interactive?: unknown;
    channelData?: unknown;
    attachments?: unknown;
  };
  return (
    hasNonEmptyString(record.text) ||
    hasNonEmptyString(record.mediaUrl) ||
    hasNonEmptyStringArray(record.mediaUrls) ||
    hasReplyPayloadContent(
      {
        presentation: record.presentation,
        interactive: record.interactive,
        channelData: record.channelData,
      },
      { extraContent: hasVisibleAttachmentReference(record.attachments) },
    )
  );
}

function hasVisibleSourceReplyPayloadEvidence(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some(hasVisibleReplyShape);
}

function hasPotentialMessagingTargetSideEffect(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasVisibleMessagingTargetEvidence(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some(hasVisibleReplyShape);
}

function hasVisibleAttachmentReference(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const urls = new Set<string>();
  for (const attachment of value) {
    if (attachment && typeof attachment === "object" && !Array.isArray(attachment)) {
      collectMediaUrlsFromRecord(attachment as Record<string, unknown>, urls);
    }
  }
  return urls.size > 0;
}

function collectStringValues(value: unknown, output: Set<string>) {
  if (typeof value === "string" && value.trim()) {
    output.add(value.trim());
    return;
  }
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      output.add(entry.trim());
    }
  }
}

function collectMediaUrlsFromRecord(record: Record<string, unknown>, output: Set<string>) {
  collectStringValues(record.mediaUrl, output);
  collectStringValues(record.mediaUrls, output);
  collectStringValues(record.path, output);
  collectStringValues(record.url, output);
  collectStringValues(record.filePath, output);
  const attachments = record.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (attachment && typeof attachment === "object" && !Array.isArray(attachment)) {
        collectMediaUrlsFromRecord(attachment as Record<string, unknown>, output);
      }
    }
  }
}

export function collectDeliveredMediaUrls(result: AgentDeliveryEvidence): string[] {
  const urls = new Set<string>();
  if (Array.isArray(result.payloads)) {
    for (const payload of result.payloads) {
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        collectMediaUrlsFromRecord(payload as Record<string, unknown>, urls);
      }
    }
  }
  for (const url of collectMessagingToolDeliveredMediaUrls(result)) {
    urls.add(url);
  }
  return Array.from(urls);
}

export function collectMessagingToolDeliveredMediaUrls(
  result: Pick<AgentDeliveryEvidence, "messagingToolSentMediaUrls" | "messagingToolSentTargets">,
): string[] {
  const urls = new Set<string>();
  collectStringValues(result.messagingToolSentMediaUrls, urls);
  if (Array.isArray(result.messagingToolSentTargets)) {
    for (const target of result.messagingToolSentTargets) {
      if (target && typeof target === "object" && !Array.isArray(target)) {
        collectMediaUrlsFromRecord(target as Record<string, unknown>, urls);
      }
    }
  }
  return Array.from(urls);
}

function hasPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readLowercaseString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function readNonEmptyStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasMessageIdEvidence(details: Record<string, unknown>): boolean {
  if (
    readNonEmptyStringField(details, "messageId") ??
    readNonEmptyStringField(details, "message_id")
  ) {
    return true;
  }
  const receipt = readRecord(details.receipt);
  if (
    receipt &&
    (readNonEmptyStringField(receipt, "primaryPlatformMessageId") ||
      (Array.isArray(receipt.platformMessageIds) &&
        receipt.platformMessageIds.some((value) => hasNonEmptyString(value))))
  ) {
    return true;
  }
  const message = readRecord(details.message);
  return Boolean(message && readNonEmptyStringField(message, "id"));
}

const COMMITTED_DELIVERY_STATUSES = new Set([
  "sent",
  "delivered",
  "success",
  "succeeded",
  "completed",
  "ok",
]);

function isExplicitNonSuccessDeliveryStatus(status: string): boolean {
  return !COMMITTED_DELIVERY_STATUSES.has(status);
}

function hasExplicitNonDeliveryFlag(outcome: Record<string, unknown>): boolean {
  if (outcome.dryRun === true || outcome.ok === false || outcome.success === false) {
    return true;
  }
  return [outcome.deliveryStatus, outcome.delivery_status, outcome.status].some((value) => {
    const status = readLowercaseString(value);
    return status ? isExplicitNonSuccessDeliveryStatus(status) : false;
  });
}

function hasSentPayloadOutcomeEvidence(value: unknown, depth: number): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => {
    const outcome = readRecord(entry);
    if (!outcome) {
      return false;
    }
    if (hasExplicitNonDeliveryFlag(outcome)) {
      return false;
    }
    const status =
      readLowercaseString(outcome.deliveryStatus) ??
      readLowercaseString(outcome.delivery_status) ??
      readLowercaseString(outcome.status);
    if (status !== "sent") {
      return false;
    }
    const results = outcome.results;
    return (
      hasPositiveNumber(outcome.resultCount) ||
      hasResultArrayEvidence(results, depth) ||
      hasMessageIdEvidence(outcome)
    );
  });
}

function hasResultArrayEvidence(value: unknown, depth: number): boolean {
  return (
    Array.isArray(value) &&
    depth < 3 &&
    value.some((entry) => hasCommittedMessagingToolResultDetailsAtDepth(entry, depth + 1))
  );
}

function hasInternalSourceReplyEvidence(details: Record<string, unknown>): boolean {
  if (details.sourceReplySink !== "internal-ui") {
    return false;
  }
  if (hasExplicitNonDeliveryEvidenceAtDepth(details.sourceReply, 0)) {
    return false;
  }
  return hasVisibleReplyShape(details.sourceReply) || hasVisibleReplyShape(details);
}

function hasExplicitNonDeliveryEvidenceAtDepth(value: unknown, depth: number): boolean {
  const record = readRecord(value);
  if (!record) {
    return false;
  }
  if (hasExplicitNonDeliveryFlag(record)) {
    return true;
  }
  if (depth >= 3) {
    return false;
  }
  return (
    hasExplicitNonDeliveryEvidenceAtDepth(record.result, depth + 1) ||
    [record.results, record.payloadOutcomes].some(
      (entries) =>
        Array.isArray(entries) &&
        entries.some((entry) => hasExplicitNonDeliveryEvidenceAtDepth(entry, depth + 1)),
    )
  );
}

export function hasExplicitMessagingToolNonDeliveryEvidence(value: unknown): boolean {
  return hasExplicitNonDeliveryEvidenceAtDepth(value, 0);
}

function hasNestedExplicitNonDeliveryEvidence(record: Record<string, unknown>, depth: number) {
  if (depth >= 3) {
    return false;
  }
  return (
    hasExplicitNonDeliveryEvidenceAtDepth(record.result, depth + 1) ||
    [record.results, record.payloadOutcomes].some(
      (entries) =>
        Array.isArray(entries) &&
        entries.some((entry) => hasExplicitNonDeliveryEvidenceAtDepth(entry, depth + 1)),
    )
  );
}

function hasCommittedMessagingToolResultDetailsAtDepth(details: unknown, depth: number): boolean {
  const record = readRecord(details);
  if (!record) {
    return false;
  }
  if (record.dryRun === true) {
    return false;
  }
  const deliveryStatus =
    readLowercaseString(record.deliveryStatus) ?? readLowercaseString(record.delivery_status);
  const status = readLowercaseString(record.status);
  const hasCommittedPartialEvidence =
    (deliveryStatus === "partial_failed" || status === "partial_failed") &&
    (hasMessageIdEvidence(record) ||
      hasPositiveNumber(record.resultCount) ||
      hasResultArrayEvidence(record.results, depth) ||
      hasSentPayloadOutcomeEvidence(record.payloadOutcomes, depth) ||
      hasInternalSourceReplyEvidence(record) ||
      (depth < 3 && hasCommittedMessagingToolResultDetailsAtDepth(record.result, depth + 1)));
  if ((record.ok === false || record.success === false) && !hasCommittedPartialEvidence) {
    return false;
  }
  if (
    deliveryStatus &&
    deliveryStatus !== "partial_failed" &&
    isExplicitNonSuccessDeliveryStatus(deliveryStatus)
  ) {
    return false;
  }
  if (status && status !== "partial_failed" && isExplicitNonSuccessDeliveryStatus(status)) {
    return false;
  }
  const hasNestedNonDeliveryEvidence = hasNestedExplicitNonDeliveryEvidence(record, depth);
  if ((deliveryStatus === "sent" || status === "sent") && hasNestedNonDeliveryEvidence) {
    return false;
  }
  if (deliveryStatus === "sent" || status === "sent") {
    return true;
  }
  return (
    (!hasNestedNonDeliveryEvidence &&
      (hasMessageIdEvidence(record) || hasPositiveNumber(record.resultCount))) ||
    hasResultArrayEvidence(record.results, depth) ||
    hasSentPayloadOutcomeEvidence(record.payloadOutcomes, depth) ||
    hasInternalSourceReplyEvidence(record) ||
    (depth < 3 && hasCommittedMessagingToolResultDetailsAtDepth(record.result, depth + 1))
  );
}

export function hasCommittedMessagingToolResultDetails(details: unknown): boolean {
  return hasCommittedMessagingToolResultDetailsAtDepth(details, 0);
}

export type MessagingToolResultContentDeliveryState = "committed" | "non_delivery" | "unknown";

export function getMessagingToolResultContentDeliveryState(
  result: unknown,
): MessagingToolResultContentDeliveryState {
  const record = readRecord(result);
  if (!record || !Array.isArray(record.content)) {
    return "unknown";
  }
  let sawCommittedReceipt = false;
  let sawNonDeliveryReceipt = false;
  for (const block of record.content) {
    const content = readRecord(block);
    if (content?.type !== "text" || typeof content.text !== "string") {
      continue;
    }
    try {
      const receipt = readRecord(JSON.parse(content.text));
      if (!receipt) {
        continue;
      }
      if (hasCommittedMessagingToolResultDetails(receipt)) {
        sawCommittedReceipt = true;
        continue;
      }
      if (hasExplicitNonDeliveryEvidenceAtDepth(receipt, 0)) {
        sawNonDeliveryReceipt = true;
      }
    } catch {
      // Ignore non-JSON text blocks.
    }
  }
  return sawCommittedReceipt ? "committed" : sawNonDeliveryReceipt ? "non_delivery" : "unknown";
}

export function hasCommittedMessagingToolResultContent(result: unknown): boolean {
  return getMessagingToolResultContentDeliveryState(result) === "committed";
}

export function getGatewayAgentResult(response: unknown): AgentDeliveryEvidence | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const candidate = hasAgentDeliveryEvidenceShape(response)
    ? response
    : (response as { result?: unknown }).result;
  if (!candidate || typeof candidate !== "object" || !hasAgentDeliveryEvidenceShape(candidate)) {
    return null;
  }
  return candidate as AgentDeliveryEvidence;
}

function hasAgentDeliveryEvidenceShape(value: object): boolean {
  return (
    "payloads" in value ||
    "deliveryStatus" in value ||
    "didSendViaMessagingTool" in value ||
    "messagingToolSentTexts" in value ||
    "messagingToolSentMediaUrls" in value ||
    "messagingToolSentTargets" in value ||
    "messagingToolSourceReplyPayloads" in value ||
    "acceptedSessionSpawns" in value ||
    "successfulCronAdds" in value ||
    "meta" in value
  );
}

export function hasVisibleAgentPayload(
  result: Pick<AgentDeliveryEvidence, "payloads">,
  options: { includeErrorPayloads?: boolean; includeReasoningPayloads?: boolean } = {},
): boolean {
  const payloads = result.payloads;
  if (!Array.isArray(payloads)) {
    return false;
  }
  return payloads.some((payload) => {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const record = payload as AgentPayloadLike;
    if (options.includeErrorPayloads === false && record.isError === true) {
      return false;
    }
    if (options.includeReasoningPayloads === false && record.isReasoning === true) {
      return false;
    }
    return hasVisibleReplyShape(record);
  });
}

export function hasErrorAgentPayload(result: Pick<AgentDeliveryEvidence, "payloads">): boolean {
  const payloads = result.payloads;
  if (!Array.isArray(payloads)) {
    return false;
  }
  return payloads.some(
    (payload) => payload && typeof payload === "object" && payload.isError === true,
  );
}

export function hasCompletedToolActivityEvidence(
  result: Pick<AgentDeliveryEvidence, "meta">,
): boolean {
  const meta = result.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  const toolSummary = (meta as { toolSummary?: unknown }).toolSummary;
  if (!toolSummary || typeof toolSummary !== "object" || Array.isArray(toolSummary)) {
    return false;
  }
  const summary = toolSummary as { calls?: unknown; tools?: unknown };
  return (
    hasPositiveNumber(summary.calls) || (Array.isArray(summary.tools) && summary.tools.length > 0)
  );
}

export function hasMessagingToolDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return hasCommittedMessagingToolDeliveryEvidence(result);
}

export function hasCommittedMessagingToolDeliveryEvidence(
  result: Pick<
    AgentDeliveryEvidence,
    | "messagingToolSentTexts"
    | "messagingToolSentMediaUrls"
    | "messagingToolSentTargets"
    | "messagingToolSourceReplyPayloads"
  >,
): boolean {
  return (
    hasNonEmptyStringArray(result.messagingToolSentTexts) ||
    hasNonEmptyStringArray(result.messagingToolSentMediaUrls) ||
    hasVisibleMessagingTargetEvidence(result.messagingToolSentTargets) ||
    hasVisibleSourceReplyPayloadEvidence(result.messagingToolSourceReplyPayloads)
  );
}

export function hasMessagingToolSideEffectEvidence(
  result: Pick<
    AgentDeliveryEvidence,
    | "didSendViaMessagingTool"
    | "messagingToolSentTexts"
    | "messagingToolSentMediaUrls"
    | "messagingToolSentTargets"
    | "messagingToolSourceReplyPayloads"
  >,
): boolean {
  return (
    result.didSendViaMessagingTool === true ||
    hasCommittedMessagingToolDeliveryEvidence(result) ||
    hasPotentialMessagingTargetSideEffect(result.messagingToolSentTargets)
  );
}

export function hasVisibleOutboundDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    hasMessagingToolDeliveryEvidence(result) ||
    (Array.isArray(result.acceptedSessionSpawns) &&
      hasAcceptedSessionSpawn(result.acceptedSessionSpawns))
  );
}

export function hasSideEffectProgressEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    hasMessagingToolSideEffectEvidence(result) ||
    hasPositiveNumber(result.successfulCronAdds) ||
    (Array.isArray(result.acceptedSessionSpawns) &&
      hasAcceptedSessionSpawn(result.acceptedSessionSpawns))
  );
}

export function getAgentCommandDeliveryFailure(result: AgentDeliveryEvidence): string | undefined {
  const status = result.deliveryStatus?.status;
  if (status !== "failed" && status !== "partial_failed") {
    return undefined;
  }
  const message = result.deliveryStatus?.errorMessage;
  if (hasNonEmptyString(message)) {
    return message;
  }
  return status === "partial_failed" ? "agent delivery partially failed" : "agent delivery failed";
}
