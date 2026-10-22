import { parseStrictInteger } from "@openclaw/normalization-core/number-coercion";
import { sliceUtf16Safe } from "../utils.js";
import type { SandboxBackendHandle } from "./sandbox/backend-handle.types.js";
import type { ReadOnlyWorkspaceSkillMount } from "./sandbox/workspace-mounts.js";

const CHUNK_LIMIT = 8 * 1024;

export type BashSandboxConfig = {
  containerName: string;
  workspaceDir: string;
  containerWorkdir: string;
  workdirValidation?: SandboxBackendHandle["workdirValidation"];
  validateWorkdir?: SandboxBackendHandle["validateWorkdir"];
  discardPreparedWorkdir?: SandboxBackendHandle["discardPreparedWorkdir"];
  workdirRoots?: readonly string[];
  /** Approved read-only skill mounts that may be selected as an exec workdir. */
  readOnlyWorkspaceSkillMounts?: readonly ReadOnlyWorkspaceSkillMount[];
  env?: Record<string, string>;
  prepareProcessCleanup?: SandboxBackendHandle["prepareProcessCleanup"];
  buildExecSpec?: SandboxBackendHandle["buildExecSpec"];
  finalizeExec?: SandboxBackendHandle["finalizeExec"];
};

export function buildSandboxEnv(params: {
  defaultPath: string;
  paramsEnv?: Record<string, string>;
  sandboxEnv?: Record<string, string>;
  containerWorkdir: string;
}): Record<string, string> {
  return Object.assign(
    { PATH: params.defaultPath, HOME: params.containerWorkdir },
    params.sandboxEnv,
    params.paramsEnv,
  );
}

/** Coerces process/env-like records to string-only environment variables. */
export function coerceEnv(env?: NodeJS.ProcessEnv | Record<string, string>) {
  const record: Record<string, string> = {};
  if (!env) {
    return record;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
}

/**
 * Clamp a number within min/max bounds, using defaultValue if undefined or NaN.
 */
export function clampWithDefault(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
) {
  if (value === undefined || Number.isNaN(value)) {
    return defaultValue;
  }
  return Math.min(Math.max(value, min), max);
}

/** Reads a strict integer from the preferred env var or one legacy alias. */
export function readEnvInt(key: string, legacyKey?: string) {
  const raw = process.env[key] || (legacyKey ? process.env[legacyKey] : undefined);
  return parseStrictInteger(raw);
}

/** Splits output into bounded chunks without splitting UTF-16 surrogate pairs. */
export function chunkString(input: string) {
  const chunks: string[] = [];
  let i = 0;
  while (i < input.length) {
    const chunk = sliceUtf16Safe(input, i, i + CHUNK_LIMIT);
    chunks.push(chunk);
    i += chunk.length;
  }
  return chunks;
}

/** Truncates long labels in the middle while preserving UTF-16 boundaries. */
export function truncateMiddle(str: string, max: number) {
  if (str.length <= max) {
    return str;
  }
  const half = Math.floor((max - 3) / 2);
  return `${sliceUtf16Safe(str, 0, half)}...${sliceUtf16Safe(str, -half)}`;
}

export function sliceLogLines(
  text: string,
  offset?: number,
  limit?: number,
): { slice: string; totalLines: number; totalChars: number } {
  if (!text) {
    return { slice: "", totalLines: 0, totalChars: 0 };
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  const totalChars = text.length;
  let start =
    typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  if (limit !== undefined && offset === undefined) {
    const tailCount = Math.max(0, Math.floor(limit));
    start = Math.max(totalLines - tailCount, 0);
  }
  const end =
    typeof limit === "number" && Number.isFinite(limit)
      ? start + Math.max(0, Math.floor(limit))
      : undefined;
  return { slice: lines.slice(start, end).join("\n"), totalLines, totalChars };
}

/** Derives a compact human label from a shell command. */
export function deriveSessionName(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  const verb = tokens[0];
  if (!verb) {
    return undefined;
  }
  let target = tokens.slice(1).find((t) => !t.startsWith("-"));
  if (!target) {
    target = tokens[1];
  }
  if (!target) {
    return verb;
  }
  const cleaned = truncateMiddle(stripQuotes(target), 48);
  return `${stripQuotes(verb)} ${cleaned}`;
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
  return matches.map((token) => stripQuotes(token)).filter(Boolean);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
