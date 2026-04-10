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
  const allowEmptyKeys = new Set(
    groups.filter((group) => group.allowEmpty).flatMap((group) => group.keys),
  );
  const received = Object.keys(record).flatMap((key) => {
    const detail = describeReceivedParamValue(record[key], allowEmptyKeys.has(key));
    if (record[key] === undefined || record[key] === null) {
      return [];
    }
    return [detail ? `${key}=${detail}` : key];
  });
  return received.length > 0 ? ` (received: ${received.join(", ")})` : "";
}

type EditReplacement = {
  oldText: string;
  newText: string;
};

function isValidEditReplacement(value: unknown): value is EditReplacement {
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
  return (
    Array.isArray(edits) &&
    edits.length > 0 &&
    edits.every((entry) => isValidEditReplacement(entry))
  );
}

export const REQUIRED_PARAM_GROUPS = {
  read: [{ keys: ["path"], label: "path" }],
  write: [
    { keys: ["path"], label: "path" },
    { keys: ["content"], label: "content" },
  ],
  edit: [
    { keys: ["path"], label: "path" },
    { keys: ["edits"], label: "edits", validator: hasValidEditReplacements },
  ],
} as const;

// ========== FORK PATCH: Claude Code alias mapping via prepareArguments ==========
// 3rd party models (GPT-5 via unleashed, Qwen via litellm) are trained on Claude Code
// conventions and emit {file_path, old_string, new_string} instead of pi-coding-agent's
// {path, oldText, newText}. We chain into the tool's prepareArguments hook (which runs
// BEFORE schema validation in pi-agent-core) to map aliases before upstream's own
// normalization (prepareEditArguments: flat → edits[] array).

const CLAUDE_CODE_ALIASES: readonly { original: string; alias: string }[] = [
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

function mapClaudeCodeAliases(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const record = args as Record<string, unknown>;
  let changed = false;
  const result: Record<string, unknown> = { ...record };
  for (const { original, alias } of CLAUDE_CODE_ALIASES) {
    if (alias in result) {
      if (!(original in result)) {
        result[original] = result[alias];
      }
      delete result[alias];
      changed = true;
    }
  }
  return changed ? result : args;
}

/**
 * Wrap a tool's prepareArguments hook to map Claude Code aliases
 * (file_path/old_string/new_string) to pi-coding-agent conventions
 * (path/oldText/newText) BEFORE the upstream prepareArguments runs.
 *
 * pi-coding-agent's edit tool already has prepareEditArguments that wraps
 * flat {oldText, newText} into {edits: [{oldText, newText}]}. After our
 * alias mapping, that upstream logic handles the rest.
 */
export function wrapToolWithClaudeCodeAliases(tool: AnyAgentTool): AnyAgentTool {
  const upstreamPrepare = tool.prepareArguments;
  return {
    ...tool,
    prepareArguments: (args: unknown) => {
      const aliased = mapClaudeCodeAliases(args);
      return upstreamPrepare ? upstreamPrepare(aliased) : aliased;
    },
  } as AnyAgentTool;
}

// ========== END FORK PATCH ==========

export function getToolParamsRecord(params: unknown): Record<string, unknown> | undefined {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
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
    const receivedHint = formatReceivedParamHint(record, groups);
    throw parameterValidationError(`Missing required ${noun}: ${joined}${receivedHint}`);
  }
}

export function wrapToolParamValidation(
  tool: AnyAgentTool,
  requiredParamGroups?: readonly RequiredParamGroup[],
): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const record = getToolParamsRecord(params);
      if (requiredParamGroups?.length) {
        assertRequiredParams(record, requiredParamGroups, tool.name);
      }
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}
