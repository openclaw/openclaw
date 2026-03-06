import type { messagingApi } from "@line/bot-sdk";
export type Action = messagingApi.Action;
/**
 * Create a message action (sends text when tapped)
 */
export declare function messageAction(label: string, text?: string): Action;
/**
 * Create a URI action (opens a URL when tapped)
 */
export declare function uriAction(label: string, uri: string): Action;
/**
 * Create a postback action (sends data to webhook when tapped)
 */
export declare function postbackAction(label: string, data: string, displayText?: string): Action;
/**
 * Create a datetime picker action
 */
export declare function datetimePickerAction(label: string, data: string, mode: "date" | "time" | "datetime", options?: {
    initial?: string;
    max?: string;
    min?: string;
}): Action;
