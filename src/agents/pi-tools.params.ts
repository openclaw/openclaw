import type { AnyAgentTool } from "./pi-tools.types.js";

export type RequiredParamGroup = {
  keys: readonly string[];
  allowEmpty?: boolean;
  label?: string;
  validator?: (record: Record<string, unknown>) => boolean;
};

const RETRY_GUIDANCE_SUFFIX = " Supply correct parameters before retrying.";

function parameterValidationError(message: string): Error {
  return new Error(`${message}.${RETRY_GUIDANCE_SUFFIX}`);
}

export const CLAUDE_PARAM_GROUPS = {
  read: [{ keys: ["path", "file_path", "filePath", "file"], label: "path alias" }],
  write: [
    { keys: ["path", "file_path", "filePath", "file"], label: "path alias" },
    { keys: ["content"], label: "content" },
  ],
  edit: [
    { keys: ["path", "file_path", "filePath", "file"], label: "path alias" },
    {
      keys: ["oldText", "old_string", "old_text", "oldString"],
      label: "oldText alias",
      validator: hasValidEditReplacements,
    },
    {
      keys: ["newText", "new_string", "new_text", "newString"],
      label: "newText alias",
      allowEmpty: true,
      validator: hasValidEditReplacements,
    },
  ],
} as const;

type ClaudeParamAlias = {
  original: string;
  alias: string;
};

const CLAUDE_PARAM_ALIASES: ClaudeParamAlias[] = [
  { original: "path", alias: "file_path" },
  { original: "path", alias: "filePath" },
  { original: "path", alias: "file" },
  { original: "oldText", alias: "old_string" },
  { original: "oldText", alias: "old_text" },
  { original: "oldText", alias: "oldString" },
  { original: "newText", alias: "new_string" },
  { original: "newText", alias: "new_text" },
  { original: "newText", alias: "newString" },
];

type EditReplacement = {
  oldText: string;
  newText: string;
};

function extractStructuredText(value: unknown, depth = 0): string | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractStructuredText(entry, depth + 1))
      .filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("") : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return extractStructuredText(record.content, depth + 1);
  }
  if (Array.isArray(record.parts)) {
    return extractStructuredText(record.parts, depth + 1);
  }
  if (typeof record.value === "string" && record.value.length > 0) {
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    const kind = typeof record.kind === "string" ? record.kind.toLowerCase() : "";
    if (type.includes("text") || kind === "text") {
      return record.value;
    }
  }
  return undefined;
}

function normalizeTextLikeParam(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value === "string") {
    return;
  }
  const extracted = extractStructuredText(value);
  if (typeof extracted === "string") {
    record[key] = extracted;
  }
}

function normalizeEditReplacement(value: unknown): EditReplacement | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const normalized = { ...(value as Record<string, unknown>) };
  normalizeClaudeParamAliases(normalized);
  normalizeTextLikeParam(normalized, "oldText");
  normalizeTextLikeParam(normalized, "newText");
  if (typeof normalized.oldText !== "string" || normalized.oldText.trim().length === 0) {
    return undefined;
  }
  if (typeof normalized.newText !== "string") {
    return undefined;
  }
  return {
    oldText: normalized.oldText,
    newText: normalized.newText,
  };
}

function normalizeEditReplacements(
  record: Record<string, unknown>,
  opts: { editHoistedFromArray?: boolean } = {},
) {
  const replacements: EditReplacement[] = [];
  if (Array.isArray(record.edits)) {
    for (const entry of record.edits) {
      const normalized = normalizeEditReplacement(entry);
      if (normalized) {
        replacements.push(normalized);
      }
    }
  }
  // Append top-level oldText/newText when:
  //  - edits[] produced no valid replacements (fallback for malformed arrays), OR
  //  - the top-level pair was user-provided (not hoisted from edits[0])
  // Skip when the top-level values were hoisted from edits[0] and edits[]
  // already produced valid entries — appending would create a duplicate.
  const skipTopLevel = opts.editHoistedFromArray && replacements.length > 0;
  if (
    !skipTopLevel &&
    typeof record.oldText === "string" &&
    record.oldText.trim().length > 0
  ) {
    if (typeof record.newText === "string") {
      replacements.push({
        oldText: record.oldText,
        newText: record.newText,
      });
    }
  }
  if (replacements.length > 0) {
    record.edits = replacements;
  }
}

function hasValidEditReplacements(record: Record<string, unknown>): boolean {
  const edits = record.edits;
  return (
    Array.isArray(edits) &&
    edits.length > 0 &&
    edits.every((entry) => normalizeEditReplacement(entry) !== undefined)
  );
}

function normalizeClaudeParamAliases(record: Record<string, unknown>) {
  for (const { original, alias } of CLAUDE_PARAM_ALIASES) {
    if (alias in record && !(original in record)) {
      record[original] = record[alias];
    }
    delete record[alias];
  }
}

function addClaudeParamAliasesToSchema(params: {
  properties: Record<string, unknown>;
  required: string[];
}): boolean {
  let changed = false;
  for (const { original, alias } of CLAUDE_PARAM_ALIASES) {
    if (!(original in params.properties)) {
      continue;
    }
    if (!(alias in params.properties)) {
      params.properties[alias] = params.properties[original];
      changed = true;
    }
    const idx = params.required.indexOf(original);
    if (idx !== -1) {
      params.required.splice(idx, 1);
      changed = true;
    }
  }
  return changed;
}

// Normalize tool parameters from Claude Code conventions to pi-coding-agent conventions.
// Claude Code uses file_path/old_string/new_string while pi-coding-agent uses path/oldText/newText.
// This prevents models trained on Claude Code from getting stuck in tool-call loops.
export function normalizeToolParams(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const normalized = { ...record };

  // Normalize aliases first so top-level old_string/new_string are resolved
  // to canonical oldText/newText before the edits[] hoist runs. This ensures
  // top-level aliases take precedence over nested edits[0] values.
  normalizeClaudeParamAliases(normalized);

  // Some models/schemas wrap edit params inside an edits[] array.
  // Hoist oldText/newText from edits[0] to the top level so downstream
  // validation and normalization find them.
  // Track whether the top-level edit pair was provided by the caller (true)
  // or hoisted from edits[0] (false) so normalizeEditReplacements can
  // decide whether to include it alongside the edits[] entries.
  // Both keys must exist for the pair to count as user-provided; a partial
  // top-level (e.g. oldText without newText) is not a valid edit pair.
  const hadTopLevelEditPair = "oldText" in normalized && "newText" in normalized;
  if (
    Array.isArray(normalized.edits) &&
    normalized.edits.length > 0 &&
    typeof normalized.edits[0] === "object" &&
    normalized.edits[0] !== null
  ) {
    const first = normalized.edits[0] as Record<string, unknown>;
    const oldKeys = ["oldText", "old_string", "old_text", "oldString"];
    const newKeys = ["newText", "new_string", "new_text", "newString"];
    const hasOld = oldKeys.some((k) => k in first);
    const hasNew = newKeys.some((k) => k in first);
    // Only hoist when edits[0] contains a complete edit pair (both an old
    // and a new key). Partial entries must not be combined with top-level
    // keys from a different source to form synthetic replacements.
    if (hasOld && hasNew) {
      for (const key of [...oldKeys, ...newKeys]) {
        if (key in first && !(key in normalized)) {
          normalized[key] = first[key];
        }
      }
    }
    // Re-run alias normalization so hoisted alias keys (e.g. old_string
    // from edits[0]) are converted to canonical keys (oldText/newText).
    normalizeClaudeParamAliases(normalized);
  }
  const editHoistedFromArray = !hadTopLevelEditPair && "oldText" in normalized && "newText" in normalized;
  // Some providers/models emit text payloads as structured blocks instead of raw strings.
  // Normalize these for write/edit so content matching and writes stay deterministic.
  normalizeTextLikeParam(normalized, "content");
  normalizeTextLikeParam(normalized, "oldText");
  normalizeTextLikeParam(normalized, "newText");
  normalizeEditReplacements(normalized, { editHoistedFromArray });
  return normalized;
}

export function patchToolSchemaForClaudeCompatibility(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;

  if (!schema || !schema.properties || typeof schema.properties !== "object") {
    return tool;
  }

  const properties = { ...(schema.properties as Record<string, unknown>) };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  const changed = addClaudeParamAliasesToSchema({ properties, required });

  if (!changed) {
    return tool;
  }

  return {
    ...tool,
    parameters: {
      ...schema,
      properties,
      required,
    },
  };
}

export function assertRequiredParams(
  record: Record<string, unknown> | undefined,
  groups: readonly RequiredParamGroup[],
  toolName: string,
): void {
  if (!record || typeof record !== "object") {
    throw parameterValidationError(`Missing parameters for ${toolName}`);
  }

  const missingLabels: string[] = [];
  for (const group of groups) {
    const satisfied =
      group.validator?.(record) ??
      group.keys.some((key) => {
        if (!(key in record)) {
          return false;
        }
        const value = record[key];
        if (typeof value !== "string") {
          return false;
        }
        if (group.allowEmpty) {
          return true;
        }
        return value.trim().length > 0;
      });

    if (!satisfied) {
      const label = group.label ?? group.keys.join(" or ");
      missingLabels.push(label);
    }
  }

  if (missingLabels.length > 0) {
    const joined = missingLabels.join(", ");
    const noun = missingLabels.length === 1 ? "parameter" : "parameters";
    throw parameterValidationError(`Missing required ${noun}: ${joined}`);
  }
}

// Generic wrapper to normalize parameters for any tool.
export function wrapToolParamNormalization(
  tool: AnyAgentTool,
  requiredParamGroups?: readonly RequiredParamGroup[],
): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(tool);
  return {
    ...patched,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      if (requiredParamGroups?.length) {
        assertRequiredParams(record, requiredParamGroups, tool.name);
      }
      return tool.execute(toolCallId, normalized ?? params, signal, onUpdate);
    },
  };
}
