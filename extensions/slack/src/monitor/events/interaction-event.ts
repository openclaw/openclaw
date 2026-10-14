import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { truncateSlackText } from "../../truncate.js";

const SLACK_INTERACTION_EVENT_PREFIX = "Slack interaction: ";
const REDACTED_INTERACTION_VALUE = "[redacted]";
const SLACK_INTERACTION_EVENT_MAX_CHARS = 2400;
const SLACK_INTERACTION_STRING_MAX_CHARS = 160;
const SLACK_INTERACTION_ARRAY_MAX_ITEMS = 64;
const SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS = 3;
const SLACK_INTERACTION_REDACTED_KEYS = new Set([
  "triggerId",
  "responseUrl",
  "workflowTriggerUrl",
  "privateMetadata",
  "viewHash",
]);

function sanitizeSlackInteractionPayloadValue(value: unknown, key?: string): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (key && SLACK_INTERACTION_REDACTED_KEYS.has(key)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return undefined;
    }
    return REDACTED_INTERACTION_VALUE;
  }
  if (typeof value === "string") {
    return truncateSlackText(value, SLACK_INTERACTION_STRING_MAX_CHARS);
  }
  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, SLACK_INTERACTION_ARRAY_MAX_ITEMS)
      .map((entry) => sanitizeSlackInteractionPayloadValue(entry))
      .filter((entry) => entry !== undefined);
    if (value.length > SLACK_INTERACTION_ARRAY_MAX_ITEMS) {
      sanitized.push(`…+${value.length - SLACK_INTERACTION_ARRAY_MAX_ITEMS} more`);
    }
    return sanitized;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const sanitized = sanitizeSlackInteractionPayloadValue(entryValue, entryKey);
    if (sanitized === undefined) {
      continue;
    }
    if (typeof sanitized === "string" && sanitized.length === 0) {
      continue;
    }
    if (Array.isArray(sanitized) && sanitized.length === 0) {
      continue;
    }
    output[entryKey] = sanitized;
  }
  return output;
}

function buildCompactSlackInteractionPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const rawInputs = Array.isArray(payload.inputs) ? payload.inputs : [];
  const compactInputs = rawInputs
    .slice(0, SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS)
    .flatMap((entry) => {
      const typed = asOptionalObjectRecord(entry);
      if (!typed) {
        return [];
      }
      return [
        {
          actionId: typed.actionId,
          blockId: typed.blockId,
          actionType: typed.actionType,
          inputKind: typed.inputKind,
          selectedValues: typed.selectedValues,
          selectedLabels: typed.selectedLabels,
          inputValue: typed.inputValue,
          inputNumber: typed.inputNumber,
          selectedDate: typed.selectedDate,
          selectedTime: typed.selectedTime,
          selectedDateTime: typed.selectedDateTime,
          richTextPreview: typed.richTextPreview,
        },
      ];
    });

  return {
    interactionType: payload.interactionType,
    actionId: payload.actionId,
    callbackId: payload.callbackId,
    actionType: payload.actionType,
    actionTs: payload.actionTs,
    userId: payload.userId,
    teamId: payload.teamId,
    channelId: payload.channelId ?? payload.routedChannelId,
    messageTs: payload.messageTs,
    threadTs: payload.threadTs,
    messageUserId: payload.messageUserId,
    messageText: payload.messageText,
    viewId: payload.viewId,
    isCleared: payload.isCleared,
    selectedValues: payload.selectedValues,
    selectedLabels: payload.selectedLabels,
    selectedDate: payload.selectedDate,
    selectedTime: payload.selectedTime,
    selectedDateTime: payload.selectedDateTime,
    workflowId: payload.workflowId,
    routedChannelType: payload.routedChannelType,
    pluginHandled: payload.pluginHandled,
    pluginNamespace: payload.pluginNamespace,
    pluginDuplicate: payload.pluginDuplicate,
    pluginSystemEvent: payload.pluginSystemEvent,
    inputs: compactInputs.length > 0 ? compactInputs : undefined,
    inputsOmitted:
      rawInputs.length > SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS
        ? rawInputs.length - SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS
        : undefined,
    payloadTruncated: true,
  };
}

function formatSlackInteractionSystemEvent(payload: Record<string, unknown>): string {
  const toEventText = (value: Record<string, unknown>): string =>
    `${SLACK_INTERACTION_EVENT_PREFIX}${JSON.stringify(value)}`;

  const sanitizedPayload =
    // SAFETY: All event callers supply object literals; sanitizing their fields returns a record.
    (sanitizeSlackInteractionPayloadValue(payload) as Record<string, unknown> | undefined) ?? {};
  let eventText = toEventText(sanitizedPayload);
  if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) {
    return eventText;
  }

  const compactPayload = sanitizeSlackInteractionPayloadValue(
    buildCompactSlackInteractionPayload(sanitizedPayload),
    // SAFETY: The compact builder returns an object literal, so the sanitizer returns a record.
  ) as Record<string, unknown>;
  eventText = toEventText(compactPayload);
  if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) {
    return eventText;
  }

  return toEventText({
    interactionType: sanitizedPayload.interactionType,
    actionId: sanitizedPayload.actionId ?? "unknown",
    userId: sanitizedPayload.userId,
    channelId: sanitizedPayload.channelId ?? sanitizedPayload.routedChannelId,
    payloadTruncated: true,
  });
}

export function enqueueSlackInteractionEvent(
  payload: Record<string, unknown>,
  route: Parameters<typeof enqueueRoutedSystemEvent>[1],
  options: Parameters<typeof enqueueRoutedSystemEvent>[2],
): void {
  if (enqueueRoutedSystemEvent(formatSlackInteractionSystemEvent(payload), route, options)) {
    requestHeartbeat({
      source: "hook",
      intent: "immediate",
      reason: "hook:slack-interaction",
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      heartbeat: { target: "last" },
    });
  }
}
