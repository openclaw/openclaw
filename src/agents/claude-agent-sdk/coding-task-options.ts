import type { ClawdbotConfig } from "../../config/config.js";
import type { CodingTaskPermissionMode, CodingTaskToolPreset } from "../../config/types.tools.js";

import {
  CODING_TASK_CLAUDE_CODE_ALLOWED_TOOLS,
  CODING_TASK_DEFAULT_DISALLOWED_TOOLS,
  CODING_TASK_READONLY_ALLOWED_TOOLS,
  canonicalizeClaudeAgentSdkToolName,
  canonicalizeClaudeAgentSdkToolRule,
} from "./tools.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniq(list: string[]): string[] {
  return Array.from(new Set(list));
}

function lowerSet(list: string[]): Set<string> {
  return new Set(list.map((value) => value.toLowerCase()));
}

function extractBaseToolName(rule: string): string {
  const trimmed = rule.trim();
  if (!trimmed || trimmed === "*") return "";
  const openParen = trimmed.indexOf("(");
  const base = openParen === -1 ? trimmed : trimmed.slice(0, openParen).trim();
  return canonicalizeClaudeAgentSdkToolName(base);
}

export type CodingTaskSdkResolved = {
  options: Record<string, unknown>;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: CodingTaskPermissionMode;
  toolPreset: CodingTaskToolPreset;
};

export function buildCodingTaskSdkOptions(params: {
  config?: ClawdbotConfig;
  cwd: string;
}): CodingTaskSdkResolved {
  const cfg = params.config;
  const toolCfg = cfg?.tools?.codingTask;

  const permissionMode: CodingTaskPermissionMode = toolCfg?.permissionMode ?? "default";
  const toolPreset: CodingTaskToolPreset = toolCfg?.toolPreset ?? "readonly";

  const presetAllowed =
    toolPreset === "claude_code"
      ? [...CODING_TASK_CLAUDE_CODE_ALLOWED_TOOLS]
      : [...CODING_TASK_READONLY_ALLOWED_TOOLS];

  const allowedTools = uniq(
    (toolCfg?.allowedTools ?? presetAllowed)
      .map((value) => canonicalizeClaudeAgentSdkToolRule(value))
      .map((value) => value.trim())
      .filter(Boolean),
  );

  const presetDisallowed = [...CODING_TASK_DEFAULT_DISALLOWED_TOOLS];
  const disallowedTools = uniq(
    [...presetDisallowed, ...(toolCfg?.disallowedTools ?? [])]
      .map((value) => canonicalizeClaudeAgentSdkToolRule(value))
      .map((value) => value.trim())
      .filter(Boolean),
  );

  const allowedToolNames = allowedTools.map(extractBaseToolName).filter(Boolean);
  const disallowedToolNames = disallowedTools
    .filter((rule) => rule !== "*" && !rule.includes("("))
    .map((rule) => canonicalizeClaudeAgentSdkToolName(rule));

  const allowAll = allowedTools.some((rule) => rule.trim() === "*");
  const allowedLower = lowerSet(allowedToolNames);
  const disallowedLower = lowerSet(disallowedToolNames);

  const canUseTool = async (...args: unknown[]): Promise<Record<string, unknown>> => {
    let toolName: string | undefined;
    let input: unknown;

    if (args.length >= 2 && typeof args[0] === "string") {
      toolName = args[0];
      input = args[1];
    } else if (args.length >= 1 && isRecord(args[0])) {
      const record = args[0];
      if (typeof record.toolName === "string") toolName = record.toolName;
      if ("input" in record) input = record.input;
    }

    if (typeof toolName !== "string" || !toolName.trim()) {
      return { behavior: "deny", message: "Missing toolName for permission check." };
    }

    const normalized = canonicalizeClaudeAgentSdkToolName(toolName);
    const lower = normalized.toLowerCase();

    if (disallowedLower.has(lower)) {
      return {
        behavior: "deny",
        message: `Tool "${normalized}" is blocked by tools.codingTask.disallowedTools.`,
      };
    }

    if (allowAll || allowedLower.has(lower)) {
      return { behavior: "allow", updatedInput: input };
    }

    return {
      behavior: "deny",
      message:
        `Tool "${normalized}" is not allowed for coding_task.` +
        " Add it to tools.codingTask.allowedTools or use toolPreset=claude_code.",
    };
  };

  const options: Record<string, unknown> = {
    cwd: params.cwd,
    permissionMode,
    allowedTools,
    disallowedTools,
    canUseTool,
  };

  if (toolPreset === "claude_code") {
    options.systemPrompt = { type: "preset", preset: "claude_code" };
  }

  if (toolCfg?.settingSources && toolCfg.settingSources.length > 0) {
    options.settingSources = toolCfg.settingSources;
  }

  if (toolCfg?.additionalDirectories && toolCfg.additionalDirectories.length > 0) {
    options.additionalDirectories = toolCfg.additionalDirectories;
  }

  return {
    options,
    allowedTools,
    disallowedTools,
    permissionMode,
    toolPreset,
  };
}
