import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { getRuntimeConfig } from "../config/io.js";
import {
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
  type SessionRuntimeEnvelope,
} from "../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeToolName } from "./tool-policy.js";

export type SessionRuntimeEnvelopeDecision = { allowed: true } | { allowed: false; reason: string };
export type SessionRuntimeEnvelopeReadResult =
  | { ok: true; envelope?: SessionRuntimeEnvelope }
  | { ok: false; reason: string };

const PATH_KEYS = new Set([
  "path",
  "filepath",
  "file_path",
  "filename",
  "file",
  "directory",
  "dir",
  "cwd",
  "workspacedir",
  "workspace_dir",
  "root",
]);
const PATH_ARRAY_KEYS = new Set(["paths", "files", "directories"]);
const COMMAND_KEYS = new Set(["command", "cmd", "script"]);
const SHELL_CONTROL_PATTERN = /(?:&&|\|\||[;&|<>]|\$\(|`|\r|\n)/;

function nonEmptyList(values?: string[]): string[] {
  return Array.isArray(values) ? values.map((value) => value.trim()).filter(Boolean) : [];
}

function canonicalizePathForEnvelope(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.normalize(trimmed);
}

function matchesGlob(value: string, pattern: string): boolean {
  const canonicalValue = canonicalizePathForEnvelope(value);
  const canonicalPattern = canonicalizePathForEnvelope(pattern);
  return (
    canonicalValue === canonicalPattern ||
    minimatch(canonicalValue, canonicalPattern, { dot: true })
  );
}

function matchesAny(value: string, patterns?: string[]): boolean {
  return nonEmptyList(patterns).some((pattern) => matchesGlob(value, pattern));
}

function matchesToolName(toolName: string, tools?: string[]): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  return nonEmptyList(tools).some(
    (tool) => tool === toolName || normalizeToolName(tool) === normalizedToolName,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectStringsByKey(params: unknown, keys: Set<string>, arrayKeys = new Set<string>()) {
  const values: string[] = [];
  const visit = (value: unknown, keyHint = "", depth = 0): void => {
    if (depth > 5) {
      return;
    }
    const normalizedKey = keyHint.toLowerCase();
    if (typeof value === "string") {
      if (keys.has(normalizedKey)) {
        const trimmed = value.trim();
        if (trimmed) {
          values.push(trimmed);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (arrayKeys.has(normalizedKey) && typeof item === "string" && item.trim()) {
          values.push(item.trim());
        } else {
          visit(item, keyHint, depth + 1);
        }
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, key, depth + 1);
    }
  };
  visit(params);
  return [...new Set(values)];
}

function commandMatchesAllowlist(command: string, patterns?: string[]): boolean {
  const trimmedCommand = command.trim();
  return nonEmptyList(patterns).some((pattern) => {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      try {
        const match = new RegExp(pattern.slice(1, -1)).exec(trimmedCommand);
        return match !== null && match.index === 0 && match[0] === trimmedCommand;
      } catch {
        return false;
      }
    }
    if (trimmedCommand === pattern) {
      return true;
    }
    if (!trimmedCommand.startsWith(pattern)) {
      return false;
    }
    const boundary = trimmedCommand.charAt(pattern.length);
    if (!/\s/.test(boundary)) {
      return false;
    }
    const suffix = trimmedCommand.slice(pattern.length).trim();
    return suffix.length > 0 && !SHELL_CONTROL_PATTERN.test(suffix);
  });
}

function readSessionStoreStrict(
  storePath: string,
): { ok: true; store: Record<string, SessionEntry> } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, store: {} };
    }
    return {
      ok: false,
      reason: `Session envelope unavailable; blocking tool call: failed to read session store: ${String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `Session envelope unavailable; blocking tool call: failed to parse session store: ${String(err)}`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: "Session envelope unavailable; blocking tool call: session store is not an object",
    };
  }
  return { ok: true, store: parsed as Record<string, SessionEntry> };
}

export function readSessionRuntimeEnvelope(sessionKey?: string): SessionRuntimeEnvelopeReadResult {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return { ok: true };
  }
  try {
    const cfg = getRuntimeConfig();
    const agentId = resolveAgentIdFromSessionKey(normalizedSessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const storeRead = readSessionStoreStrict(storePath);
    if (!storeRead.ok) {
      return storeRead;
    }
    const { existing } = resolveSessionStoreEntry({
      store: storeRead.store,
      sessionKey: normalizedSessionKey,
    });
    return { ok: true, envelope: existing?.envelope };
  } catch (err) {
    return {
      ok: false,
      reason: `Session envelope unavailable; blocking tool call: ${String(err)}`,
    };
  }
}

export function evaluateSessionRuntimeEnvelope(params: {
  envelope?: SessionRuntimeEnvelope;
  toolName: string;
  toolParams: unknown;
}): SessionRuntimeEnvelopeDecision {
  const envelope = params.envelope;
  if (!envelope) {
    return { allowed: true };
  }

  const toolName = params.toolName || "tool";
  if (matchesToolName(toolName, envelope.disallowedTools)) {
    return { allowed: false, reason: `Tool blocked by session envelope: ${toolName}` };
  }
  const allowedTools = nonEmptyList(envelope.allowedTools);
  if (allowedTools.length > 0 && !matchesToolName(toolName, allowedTools)) {
    return { allowed: false, reason: `Tool not allowed by session envelope: ${toolName}` };
  }

  const pathValues = collectStringsByKey(params.toolParams, PATH_KEYS, PATH_ARRAY_KEYS).map(
    canonicalizePathForEnvelope,
  );
  for (const value of pathValues) {
    if (matchesAny(value, envelope.deniedPaths)) {
      return { allowed: false, reason: `Path blocked by session envelope: ${value}` };
    }
  }
  const allowedPaths = nonEmptyList(envelope.allowedPaths);
  if (allowedPaths.length > 0) {
    const blocked = pathValues.find((value) => !matchesAny(value, allowedPaths));
    if (blocked) {
      return { allowed: false, reason: `Path outside session envelope: ${blocked}` };
    }
  }

  const commands = collectStringsByKey(params.toolParams, COMMAND_KEYS);
  const bashAllowlist = nonEmptyList(envelope.bashCommandAllowlist);
  if (bashAllowlist.length > 0) {
    const blocked = commands.find((command) => !commandMatchesAllowlist(command, bashAllowlist));
    if (blocked) {
      return { allowed: false, reason: `Command blocked by session envelope: ${blocked}` };
    }
  }

  return { allowed: true };
}
