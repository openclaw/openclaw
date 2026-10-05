/**
 * Shared validation for model-supplied tool parameters.
 * Converts malformed file-tool arguments into retryable errors and fixes the
 * specific XML suffix and Office-extension corruption seen in path arguments.
 */
import { asOptionalObjectRecord as getToolParamsRecord } from "@openclaw/normalization-core/record-coerce";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { preserveAtPrefixedRelativePath } from "./path-policy.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

/** Return a record view of model-supplied tool params when possible. */
export { getToolParamsRecord };

export type RequiredParamGroup = {
  keys: readonly string[];
  allowEmpty?: boolean;
  label?: string;
  validator?: (record: Record<string, unknown>) => boolean;
};

const RETRY_GUIDANCE_SUFFIX = " Supply correct parameters before retrying.";
const XML_ARG_VALUE_SUFFIX_RE = /<\/arg_value>>+$/;
const HALLUCINATED_OFFICE_PATH_EXTENSION_RE = /\.(doc|ppt|xls)(?:odex|codex|xodex|xcodex)$/i;
const OFFICE_EXTENSION_BY_FAMILY: Record<string, string> = {
  doc: ".docx",
  ppt: ".pptx",
  xls: ".xlsx",
};

function parameterValidationError(message: string): Error {
  return new Error(`${message}.${RETRY_GUIDANCE_SUFFIX}`);
}

function describeReceivedParamValue(value: unknown, allowEmpty = false): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    if (allowEmpty || value.trim().length > 0) {
      return undefined;
    }
    return "<empty-string>";
  }
  if (Array.isArray(value)) {
    return "<array>";
  }
  return `<${typeof value}>`;
}

function formatReceivedParamHint(
  record: Record<string, unknown>,
  groups: readonly RequiredParamGroup[],
): string {
  // Include only present fields so errors can distinguish missing parameters
  // from wrong-shaped or empty values without echoing full content.
  const allowEmptyKeys = new Set(groups.flatMap((group) => (group.allowEmpty ? group.keys : [])));
  const received: string[] = [];
  for (const key of Object.keys(record)) {
    const detail = describeReceivedParamValue(record[key], allowEmptyKeys.has(key));
    if (record[key] === undefined || record[key] === null) {
      continue;
    }
    received.push(detail ? `${key}=${detail}` : key);
  }
  return received.length > 0 ? ` (received: ${received.join(", ")})` : "";
}

function isValidEditReplacement(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.oldText === "string" &&
    record.oldText.trim().length > 0 &&
    typeof record.newText === "string"
  );
}

function hasValidEditReplacements(record: Record<string, unknown>): boolean {
  const edits = record.edits;
  return Array.isArray(edits) && edits.length > 0 && edits.every(isValidEditReplacement);
}

/** Required parameter groups for file-style tools that need retry guidance. */
export const REQUIRED_PARAM_GROUPS = {
  read: [{ keys: ["path"], label: "path" }],
  write: [
    { keys: ["path"], label: "path" },
    { keys: ["content"], label: "content", allowEmpty: true },
  ],
  edit: [
    { keys: ["path"], label: "path" },
    { keys: ["edits"], label: "edits", validator: hasValidEditReplacements },
  ],
} as const;

/** Strip extra closing markers sometimes produced in XML arg_value path params. */
function stripMalformedXmlArgValueSuffix(value: string): string {
  return value.includes("</arg_value>") ? value.replace(XML_ARG_VALUE_SUFFIX_RE, "") : value;
}

/** Normalize model-supplied file-tool path params without touching payload text. */
export function normalizeFileToolPathParam(value: string): string;
export function normalizeFileToolPathParam(
  value: string,
  cwd: string,
  bridge?: SandboxFsBridge,
): Promise<string>;
export function normalizeFileToolPathParam(
  value: string,
  cwd?: string,
  bridge?: SandboxFsBridge,
): string | Promise<string> {
  const repaired = stripMalformedXmlArgValueSuffix(value).replace(
    HALLUCINATED_OFFICE_PATH_EXTENSION_RE,
    (match, family: string) => OFFICE_EXTENSION_BY_FAMILY[family.toLowerCase()] ?? match,
  );
  return cwd ? Promise.resolve(preserveAtPrefixedRelativePath(repaired, cwd, bridge)) : repaired;
}

/** Strip malformed XML suffixes from selected string fields without mutating input. */
export function stripMalformedXmlArgValueSuffixFromKeys<T extends Record<string, unknown>>(
  record: T,
  keys: readonly string[],
): T {
  let normalized: T | undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const stripped = stripMalformedXmlArgValueSuffix(value);
    if (stripped !== value) {
      normalized ??= { ...record };
      normalized[key as keyof T] = stripped as T[keyof T];
    }
  }
  return normalized ?? record;
}

/** Normalize selected file-tool path fields without mutating input. */
export async function normalizeFileToolPathParamsFromKeys<T extends Record<string, unknown>>(
  record: T,
  keys: readonly string[],
  cwd?: string,
  bridge?: SandboxFsBridge,
): Promise<T> {
  let normalized: T | undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const normalizedValue = cwd
      ? await normalizeFileToolPathParam(value, cwd, bridge)
      : normalizeFileToolPathParam(value);
    if (normalizedValue !== value) {
      normalized ??= { ...record };
      normalized[key as keyof T] = normalizedValue as T[keyof T];
    }
  }
  return normalized ?? record;
}

export function missingRequiredParamLabels(
  record: Record<string, unknown> | undefined,
  groups: readonly RequiredParamGroup[],
): string[] {
  return groups
    .filter(
      (group) =>
        !record ||
        !(
          group.validator?.(record) ??
          group.keys.some((key) => {
            if (!(key in record)) {
              return false;
            }
            const value = record[key];
            return typeof value === "string" && (group.allowEmpty || value.trim().length > 0);
          })
        ),
    )
    .map((group) => group.label ?? group.keys.join(" or "));
}

/** Throw actionable retry guidance when required tool params are missing. */
export function assertRequiredParams(
  record: Record<string, unknown> | undefined,
  groups: readonly RequiredParamGroup[],
  toolName: string,
): void {
  if (!record || typeof record !== "object") {
    throw parameterValidationError(`Missing parameters for ${toolName}`);
  }

  const missingLabels = missingRequiredParamLabels(record, groups);

  if (missingLabels.length > 0) {
    const joined = missingLabels.join(", ");
    const noun = missingLabels.length === 1 ? "parameter" : "parameters";
    const receivedHint = formatReceivedParamHint(record, groups);
    throw parameterValidationError(`Missing required ${noun}: ${joined}${receivedHint}`);
  }
}

/** Wrap a tool execute function with required-parameter validation. */
export function wrapToolParamValidation(
  tool: AnyAgentTool,
  requiredParamGroups?: readonly RequiredParamGroup[],
  cwd?: string,
  bridge?: SandboxFsBridge,
): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const record = getToolParamsRecord(params);
      const pathKeys = requiredParamGroups?.some((group) => group.keys.includes("path"))
        ? ["path"]
        : [];
      const normalizedParams =
        record && pathKeys.length > 0
          ? await normalizeFileToolPathParamsFromKeys(record, pathKeys, cwd, bridge)
          : params;
      if (requiredParamGroups?.length) {
        assertRequiredParams(getToolParamsRecord(normalizedParams), requiredParamGroups, tool.name);
      }
      return tool.execute(toolCallId, normalizedParams, signal, onUpdate);
    },
  };
}
