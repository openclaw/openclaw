import { hasAcceptedSessionSpawn } from "../accepted-session-spawn.js";

type AgentPayloadLike = {
  text?: unknown;
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  presentation?: unknown;
  interactive?: unknown;
  channelData?: unknown;
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

function hasVisibleReplyShape(value: unknown): boolean {
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
  };
  return Boolean(
    hasNonEmptyString(record.text) ||
    hasNonEmptyString(record.mediaUrl) ||
    hasNonEmptyStringArray(record.mediaUrls) ||
    record.presentation ||
    record.interactive ||
    record.channelData,
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

function isKnownNonSentDeliveryStatus(status: string): boolean {
  return (
    status === "failed" ||
    status === "partial_failed" ||
    status === "suppressed" ||
    status === "dry_run" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "cancelled_by_message_sending_hook" ||
    status === "cancelled-by-message-sending-hook"
  );
}

function hasSentPayloadOutcomeEvidence(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => {
    const outcome = readRecord(entry);
    if (!outcome) {
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
      (Array.isArray(results) && results.length > 0) ||
      hasMessageIdEvidence(outcome)
    );
  });
}

function hasInternalSourceReplyEvidence(details: Record<string, unknown>): boolean {
  if (details.sourceReplySink !== "internal-ui") {
    return false;
  }
  return hasVisibleReplyShape(details.sourceReply) || hasVisibleReplyShape(details);
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
  if (deliveryStatus && deliveryStatus !== "sent") {
    return false;
  }
  if (deliveryStatus === "sent") {
    return true;
  }
  const status = readLowercaseString(record.status);
  if (!deliveryStatus && status && isKnownNonSentDeliveryStatus(status)) {
    return false;
  }
  return (
    hasMessageIdEvidence(record) ||
    hasPositiveNumber(record.resultCount) ||
    hasSentPayloadOutcomeEvidence(record.payloadOutcomes) ||
    hasInternalSourceReplyEvidence(record) ||
    (depth < 3 && hasCommittedMessagingToolResultDetailsAtDepth(record.result, depth + 1))
  );
}

export function hasCommittedMessagingToolResultDetails(details: unknown): boolean {
  return hasCommittedMessagingToolResultDetailsAtDepth(details, 0);
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
