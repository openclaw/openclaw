import { TSchema } from "typebox";
import { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

//#region src/agents/image-sanitization.d.ts
type ImageSanitizationLimits = {
  maxDimensionPx?: number;
  maxBytes?: number;
};
//#endregion
//#region src/agents/tools/common.d.ts
type AgentToolWithMeta<TParameters extends TSchema, TResult> = AgentTool<TParameters, TResult> & {
  displaySummary?: string;
};
type ErasedAgentToolExecute = {
  execute(this: void, toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<unknown>): Promise<AgentToolResult<unknown>>;
};
type AnyAgentTool = Omit<AgentTool<TSchema, unknown>, "execute"> & ErasedAgentToolExecute & {
  displaySummary?: string;
};
declare function asToolParamsRecord(params: unknown): Record<string, unknown>;
type StringParamOptions = {
  required?: boolean;
  trim?: boolean;
  label?: string;
  allowEmpty?: boolean;
};
type ActionGate<T extends Record<string, boolean | undefined>> = (key: keyof T, defaultValue?: boolean) => boolean;
declare class ToolInputError extends Error {
  readonly status: number;
  constructor(message: string);
}
declare class ToolAuthorizationError extends ToolInputError {
  readonly status = 403;
  constructor(message: string);
}
declare function createActionGate<T extends Record<string, boolean | undefined>>(actions: T | undefined): ActionGate<T>;
declare function readStringParam(params: Record<string, unknown>, key: string, options: StringParamOptions & {
  required: true;
}): string;
declare function readStringParam(params: Record<string, unknown>, key: string, options?: StringParamOptions): string | undefined;
/**
 * Normalize tool model override input.
 * - empty/whitespace => undefined
 * - "default" (case-insensitive) => undefined (sentinel: reset/fallback)
 * - otherwise returns trimmed explicit model string
 */
declare function normalizeToolModelOverride(value: string | undefined): string | undefined;
declare function readStringOrNumberParam(params: Record<string, unknown>, key: string, options?: {
  required?: boolean;
  label?: string;
}): string | undefined;
declare function readNumberParam(params: Record<string, unknown>, key: string, options?: {
  required?: boolean;
  label?: string;
  integer?: boolean;
  strict?: boolean;
}): number | undefined;
declare function readStringArrayParam(params: Record<string, unknown>, key: string, options: StringParamOptions & {
  required: true;
}): string[];
declare function readStringArrayParam(params: Record<string, unknown>, key: string, options?: StringParamOptions): string[] | undefined;
type ReactionParams = {
  emoji: string;
  remove: boolean;
  isEmpty: boolean;
};
declare function readReactionParams(params: Record<string, unknown>, options: {
  emojiKey?: string;
  removeKey?: string;
  removeErrorMessage: string;
}): ReactionParams;
declare function stringifyToolPayload(payload: unknown): string;
declare function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails>;
declare function failedTextResult<TDetails extends {
  status: "failed";
}>(text: string, details: TDetails): AgentToolResult<TDetails>;
declare function payloadTextResult<TDetails>(payload: TDetails): AgentToolResult<TDetails>;
declare function jsonResult(payload: unknown): AgentToolResult<unknown>;
declare function imageResult(params: {
  label: string;
  path: string;
  base64: string;
  mimeType: string;
  extraText?: string;
  details?: Record<string, unknown>;
  imageSanitization?: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>>;
declare function imageResultFromFile(params: {
  label: string;
  path: string;
  extraText?: string;
  details?: Record<string, unknown>;
  imageSanitization?: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>>;
type AvailableTag = {
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
declare function parseAvailableTags(raw: unknown): AvailableTag[] | undefined;
//#endregion
export { stringifyToolPayload as C, readStringParam as S, payloadTextResult as _, ReactionParams as a, readStringArrayParam as b, ToolInputError as c, failedTextResult as d, imageResult as f, parseAvailableTags as g, normalizeToolModelOverride as h, AvailableTag as i, asToolParamsRecord as l, jsonResult as m, AgentToolWithMeta as n, StringParamOptions as o, imageResultFromFile as p, AnyAgentTool as r, ToolAuthorizationError as s, ActionGate as t, createActionGate as u, readNumberParam as v, textResult as w, readStringOrNumberParam as x, readReactionParams as y };