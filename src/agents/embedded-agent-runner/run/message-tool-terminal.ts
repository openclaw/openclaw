import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { isMessageToolSendActionName } from "../../embedded-agent-messaging.js";
import { isToolResultError } from "../../embedded-agent-subscribe.tools.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";
import { normalizeToolName } from "../../tool-policy.js";

const MESSAGE_TOOL_NAME = "message";
// Explicit route args mean the message tool targeted a different destination;
// source-reply termination is only safe for implicit replies to the active turn.
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

/**
 * Returns true when a nested tool/hook envelope proves this was only a preview.
 * Message adapters can report dry-run status in raw results, detail payloads, or
 * JSON text blocks, so this scan intentionally mirrors delivered-message parsing.
 */
function deliveryEnvelopeIndicatesDryRun(value: unknown, depth = 0): boolean {
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

  // Delivery adapters may wrap status in provider-specific result/detail
  // envelopes; bound recursion so malformed tool output cannot hang the hook.
  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesDryRun(record[key], depth + 1),
  );
}

/**
 * Returns true when a nested tool/hook envelope contains durable delivery
 * evidence. Status alone is accepted only for the canonical `sent` value;
 * provider-specific receipts must expose a message id.
 */
function deliveryEnvelopeIndicatesDelivered(value: unknown, depth = 0): boolean {
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

  // Mirror the dry-run scan shape so terminal detection treats hook rewrites
  // and raw tool results consistently.
  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesDelivered(record[key], depth + 1),
  );
}

/**
 * Returns true when message-tool-only delivery already sent the final reply.
 * This is intentionally stricter than "message tool succeeded": explicit
 * routes, dry runs, failed results, and suppressed sends without delivery proof
 * must leave the model turn open.
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
  // Dry-run previews can look structurally successful, but they did not deliver
  // a channel reply and must not terminate the assistant turn.
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
 * Installs an afterToolCall hook that terminates message-tool-only delivered
 * replies while preserving any existing hook rewrite output.
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
