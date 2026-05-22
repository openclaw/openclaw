import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
export type AgentToolWithMeta<TParameters extends TSchema, TResult> = AgentTool<TParameters, TResult> & {
    ownerOnly?: boolean;
    displaySummary?: string;
};
type ErasedAgentToolExecute = {
    execute(this: void, toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<unknown>): Promise<AgentToolResult<unknown>>;
};
export type AnyAgentTool = Omit<AgentTool<TSchema, unknown>, "execute"> & ErasedAgentToolExecute & {
    ownerOnly?: boolean;
    displaySummary?: string;
};
export declare function asToolParamsRecord(params: unknown): Record<string, unknown>;
export type StringParamOptions = {
    required?: boolean;
    trim?: boolean;
    label?: string;
    allowEmpty?: boolean;
};
export type ActionGate<T extends Record<string, boolean | undefined>> = (key: keyof T, defaultValue?: boolean) => boolean;
export declare const OWNER_ONLY_TOOL_ERROR = "Tool restricted to owner senders.";
export declare class ToolInputError extends Error {
    readonly status: number;
    constructor(message: string);
}
export declare class ToolAuthorizationError extends ToolInputError {
    readonly status = 403;
    constructor(message: string);
}
export declare function createActionGate<T extends Record<string, boolean | undefined>>(actions: T | undefined): ActionGate<T>;
export declare function readStringParam(params: Record<string, unknown>, key: string, options: StringParamOptions & {
    required: true;
}): string;
export declare function readStringParam(params: Record<string, unknown>, key: string, options?: StringParamOptions): string | undefined;
export declare function readStringOrNumberParam(params: Record<string, unknown>, key: string, options?: {
    required?: boolean;
    label?: string;
}): string | undefined;
export declare function readNumberParam(params: Record<string, unknown>, key: string, options?: {
    required?: boolean;
    label?: string;
    integer?: boolean;
    strict?: boolean;
}): number | undefined;
export declare function readStringArrayParam(params: Record<string, unknown>, key: string, options: StringParamOptions & {
    required: true;
}): string[];
export declare function readStringArrayParam(params: Record<string, unknown>, key: string, options?: StringParamOptions): string[] | undefined;
export type ReactionParams = {
    emoji: string;
    remove: boolean;
    isEmpty: boolean;
};
export declare function readReactionParams(params: Record<string, unknown>, options: {
    emojiKey?: string;
    removeKey?: string;
    removeErrorMessage: string;
}): ReactionParams;
export declare function stringifyToolPayload(payload: unknown): string;
export declare function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails>;
export declare function failedTextResult<TDetails extends {
    status: "failed";
}>(text: string, details: TDetails): AgentToolResult<TDetails>;
export declare function payloadTextResult<TDetails>(payload: TDetails): AgentToolResult<TDetails>;
export declare function jsonResult(payload: unknown): AgentToolResult<unknown>;
export declare function wrapOwnerOnlyToolExecution(tool: AnyAgentTool, senderIsOwner: boolean): AnyAgentTool;
export declare function imageResult(params: {
    label: string;
    path: string;
    base64: string;
    mimeType: string;
    extraText?: string;
    details?: Record<string, unknown>;
    imageSanitization?: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>>;
export declare function imageResultFromFile(params: {
    label: string;
    path: string;
    extraText?: string;
    details?: Record<string, unknown>;
    imageSanitization?: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>>;
export type AvailableTag = {
    id?: string;
    name: string;
    moderated?: boolean;
    emoji_id?: string | null;
    emoji_name?: string | null;
};
/**
 * Validate and parse an `availableTags` parameter from untrusted input.
 * Returns `undefined` when the value is missing or not an array.
 * Entries that lack a string `name` are silently dropped.
 */
export declare function parseAvailableTags(raw: unknown): AvailableTag[] | undefined;
export {};
