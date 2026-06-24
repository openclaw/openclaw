// Line plugin module implements actions behavior.
import type { messagingApi } from "@line/bot-sdk";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export type Action = messagingApi.Action;

/**
 * Create a message action (sends text when tapped)
 */
export function messageAction(label: string, text?: string): Action {
  return {
    type: "message",
    label: truncateUtf16Safe(label, 20),
    text: text ?? label,
  };
}

/**
 * Create a URI action (opens a URL when tapped)
 */
export function uriAction(label: string, uri: string): Action {
  return {
    type: "uri",
    label: truncateUtf16Safe(label, 20),
    uri,
  };
}

/**
 * Create a postback action (sends data to webhook when tapped)
 */
export function postbackAction(label: string, data: string, displayText?: string): Action {
  return {
    type: "postback",
    label: truncateUtf16Safe(label, 20),
    data: truncateUtf16Safe(data, 300),
    displayText: displayText === undefined ? undefined : truncateUtf16Safe(displayText, 300),
  };
}

/**
 * Create a datetime picker action
 */
export function datetimePickerAction(
  label: string,
  data: string,
  mode: "date" | "time" | "datetime",
  options?: {
    initial?: string;
    max?: string;
    min?: string;
  },
): Action {
  return {
    type: "datetimepicker",
    label: truncateUtf16Safe(label, 20),
    data: truncateUtf16Safe(data, 300),
    mode,
    initial: options?.initial,
    max: options?.max,
    min: options?.min,
  };
}
