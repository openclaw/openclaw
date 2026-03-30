import type { AnyAgentTool } from "./pi-tools.types.js";

export type RequiredParamGroup = {
  keys: readonly string[];
  allowEmpty?: boolean;
  label?: string;
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
    },
    {
      keys: ["newText", "new_string", "new_text", "newString"],
      label: "newText alias",
      allowEmpty: true,
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
  normalizeClaudeParamAliases(normalized);
  // Some providers/models emit text payloads as structured blocks instead of raw strings.
  // Normalize these for write/edit so content matching and writes stay deterministic.
  normalizeTextLikeParam(normalized, "content");
  normalizeTextLikeParam(normalized, "oldText");
  normalizeTextLikeParam(normalized, "newText");
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
    const satisfied = group.keys.some((key) => {
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
    // Log actual keys and value types to diagnose model tool-call mismatches
    const receivedKeys = Object.keys(record);
    const receivedTypes = receivedKeys.map((k) => `${k}:${typeof record[k]}`).join(", ");
    const diagnostic = ` Received keys: [${receivedTypes}]`;
    throw parameterValidationError(`Missing required ${noun}: ${joined}${diagnostic}`);
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
