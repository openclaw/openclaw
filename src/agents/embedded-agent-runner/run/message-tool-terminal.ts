import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { isMessageToolSendActionName } from "../../embedded-agent-messaging.js";
import { isToolResultError } from "../../embedded-agent-subscribe.tools.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";
import { normalizeToolName } from "../../tool-policy.js";

const MESSAGE_TOOL_NAME = "message";
const EXPLICIT_MESSAGE_ROUTE_KEYS = ["channel", "target", "to", "channelId", "provider"];
const DRY_RUN_DELIVERY_STATUS = "dry_run";
const SENT_DELIVERY_STATUS = "sent";
const RESULT_ENVELOPE_KEYS = [
  "details",
  "payload",
  "result",
  "results",
  "sendResult",
  "toolResult",
];

function argsRecordForToolCall(context: AfterToolCallContext): Record<string, unknown> {
  if (context.args && typeof context.args === "object" && !Array.isArray(context.args)) {
    return context.args as Record<string, unknown>;
  }
  const fallbackArgs = context.toolCall.arguments;
  return fallbackArgs && typeof fallbackArgs === "object" && !Array.isArray(fallbackArgs)
    ? fallbackArgs
    : {};
}

function hasStringValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns true when the message tool targets anything other than the source reply route. */
function hasExplicitMessageRoute(args: Record<string, unknown>): boolean {
  if (EXPLICIT_MESSAGE_ROUTE_KEYS.some((key) => hasStringValue(args[key]))) {
    return true;
  }
  return Array.isArray(args.targets) && args.targets.some((value) => hasStringValue(value));
}

function normalizeStatus(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Detects concrete channel receipts rather than generic ok/success envelopes. */
function recordHasDeliveredMessageId(record: Record<string, unknown>): boolean {
  if (hasStringValue(record.messageId)) {
    return true;
  }
  const receipt = record.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return false;
  }
  const receiptRecord = receipt as Record<string, unknown>;
  return (
    hasStringValue(receiptRecord.primaryPlatformMessageId) ||
    (Array.isArray(receiptRecord.platformMessageIds) &&
      receiptRecord.platformMessageIds.some((value) => hasStringValue(value)))
  );
}

function deliveryEnvelopeIndicatesDryRun(value: unknown, depth = 0): boolean {
  // Tool results can wrap channel receipts inside nested SDK envelopes or text
  // JSON blocks; keep the scan bounded so malformed tool output cannot recurse.
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeIndicatesDryRun(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  if (
    record.dryRun === true ||
    normalizeStatus(record.deliveryStatus) === DRY_RUN_DELIVERY_STATUS
  ) {
    return true;
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (deliveryEnvelopeIndicatesDryRun(item, depth + 1)) {
        return true;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string") {
          const parsed = parseJsonRecord(text);
          if (parsed && deliveryEnvelopeIndicatesDryRun(parsed, depth + 1)) {
            return true;
          }
        }
      }
    }
  }

  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesDryRun(record[key], depth + 1),
  );
}

function deliveryEnvelopeIndicatesDelivered(value: unknown, depth = 0): boolean {
  // Prefer concrete delivery receipts over generic success flags: a suppressed
  // or dry-run send must not end the source reply turn.
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeIndicatesDelivered(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  if (
    normalizeStatus(record.deliveryStatus) === SENT_DELIVERY_STATUS ||
    recordHasDeliveredMessageId(record)
  ) {
    return true;
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (deliveryEnvelopeIndicatesDelivered(item, depth + 1)) {
        return true;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string") {
          const parsed = parseJsonRecord(text);
          if (parsed && deliveryEnvelopeIndicatesDelivered(parsed, depth + 1)) {
            return true;
          }
        }
      }
    }
  }

  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesDelivered(record[key], depth + 1),
  );
}

/**
 * Returns true only when a same-channel message-tool send should terminate the
 * current model turn in message-tool-only delivery mode.
 */
export function shouldTerminateAfterMessageToolOnlySend(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  context: AfterToolCallContext;
  hookResult?: AfterToolCallResult;
}): boolean {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return false;
  }
  const toolName = normalizeToolName(params.context.toolCall.name);
  if (toolName !== MESSAGE_TOOL_NAME) {
    return false;
  }
  const args = argsRecordForToolCall(params.context);
  if (!isMessageToolSendActionName(args.action) || hasExplicitMessageRoute(args)) {
    return false;
  }
  const isError = params.hookResult?.isError ?? params.context.isError;
  if (isError || isToolResultError(params.context.result)) {
    return false;
  }
  if (
    args.dryRun === true ||
    deliveryEnvelopeIndicatesDryRun(params.context.result) ||
    deliveryEnvelopeIndicatesDryRun(params.hookResult)
  ) {
    return false;
  }
  if (
    !deliveryEnvelopeIndicatesDelivered(params.context.result) &&
    !deliveryEnvelopeIndicatesDelivered(params.hookResult)
  ) {
    return false;
  }
  return true;
}

/**
 * Wraps an agent's after-tool-call hook so message-tool-only replies stop once
 * the source-channel message tool produced concrete delivery evidence.
 */
export function installMessageToolOnlyTerminalHook(params: {
  agent: Agent;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): void {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    if (
      shouldTerminateAfterMessageToolOnlySend({
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        context,
        hookResult,
      })
    ) {
      return { ...hookResult, terminate: true };
    }
    return hookResult;
  };
}
