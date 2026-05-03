import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { minimatch } from "minimatch";
import { getRuntimeConfig } from "../config/io.js";
import {
  resolveSessionStoreEntry,
  type SessionEntry,
  type SessionRuntimeEnvelope,
} from "../config/sessions.js";
import { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import { isWindowsDrivePath } from "../infra/archive-path.js";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { hasEncodedFileUrlSeparator, trySafeFileURLToPath } from "../infra/local-file-access.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeToolName } from "./tool-policy.js";

export type SessionRuntimeEnvelopeDecision = { allowed: true } | { allowed: false; reason: string };
export type SessionRuntimeEnvelopeReadResult =
  | { ok: true; envelope?: SessionRuntimeEnvelope }
  | { ok: false; reason: string };
type EnvelopePathContext = {
  workspaceDir?: string;
  containerWorkdir?: string;
};

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

function normalizeFileUrlPathCandidate(value: string): string {
  if (!/^file:\/\//i.test(value)) {
    return value;
  }
  const safePath = trySafeFileURLToPath(value);
  if (safePath) {
    return safePath;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "file:") {
      return value;
    }
    const host = parsed.hostname.trim().toLowerCase();
    if (host && host !== "localhost") {
      return value;
    }
    if (hasEncodedFileUrlSeparator(parsed.pathname)) {
      return value;
    }
    return decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
  } catch {
    return value;
  }
}

function mapContainerPathToWorkspaceRoot(value: string, context: EnvelopePathContext): string {
  const workspaceDir = context.workspaceDir?.trim();
  const containerWorkdir = context.containerWorkdir?.trim();
  if (!workspaceDir || !containerWorkdir) {
    return value;
  }
  const normalizedWorkdir = containerWorkdir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedWorkdir.startsWith("/")) {
    return value;
  }
  const rawCandidate = normalizeFileUrlPathCandidate(
    value.startsWith("@") ? value.slice(1) : value,
  );
  const normalizedCandidate = rawCandidate.replace(/\\/g, "/");
  if (normalizedCandidate === normalizedWorkdir) {
    return path.resolve(workspaceDir);
  }
  const prefix = `${normalizedWorkdir}/`;
  if (!normalizedCandidate.startsWith(prefix)) {
    return value;
  }
  return path.resolve(workspaceDir, ...normalizedCandidate.slice(prefix.length).split("/"));
}

function expandTildeLikeHostFileTools(value: string): string {
  const osHome = resolveOsHomeDir();
  return osHome ? expandHomePrefix(value, { home: osHome }) : value;
}

function canonicalizePathForEnvelope(value: string, context: EnvelopePathContext = {}): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const mapped = mapContainerPathToWorkspaceRoot(trimmed, context);
  const candidate = normalizeFileUrlPathCandidate(
    mapped.startsWith("@") ? mapped.slice(1) : mapped,
  );
  const expanded = expandTildeLikeHostFileTools(candidate);
  if (isWindowsDrivePath(expanded)) {
    return path.win32.normalize(expanded);
  }
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  const workspaceDir = context.workspaceDir?.trim();
  if (workspaceDir) {
    return path.resolve(workspaceDir, expanded || ".");
  }
  return path.normalize(expanded);
}

function matchesGlob(value: string, pattern: string, context: EnvelopePathContext): boolean {
  const canonicalValue = canonicalizePathForEnvelope(value, context);
  const canonicalPattern = canonicalizePathForEnvelope(pattern, context);
  return (
    canonicalValue === canonicalPattern ||
    minimatch(canonicalValue, canonicalPattern, { dot: true })
  );
}

function matchesAny(
  value: string,
  patterns: string[] | undefined,
  context: EnvelopePathContext,
): boolean {
  return nonEmptyList(patterns).some((pattern) => matchesGlob(value, pattern, context));
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
    const target = resolveGatewaySessionStoreTarget({ cfg, key: normalizedSessionKey });
    const storeRead = readSessionStoreStrict(target.storePath);
    if (!storeRead.ok) {
      return storeRead;
    }
    for (const storeKey of target.storeKeys) {
      const { existing } = resolveSessionStoreEntry({
        store: storeRead.store,
        sessionKey: storeKey,
      });
      if (existing?.envelope) {
        return { ok: true, envelope: existing.envelope };
      }
    }
    return { ok: true };
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
  workspaceDir?: string;
  containerWorkdir?: string;
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

  const pathContext = {
    workspaceDir: params.workspaceDir,
    containerWorkdir: params.containerWorkdir,
  };
  const pathValues = collectStringsByKey(params.toolParams, PATH_KEYS, PATH_ARRAY_KEYS).map(
    (value) => canonicalizePathForEnvelope(value, pathContext),
  );
  for (const value of pathValues) {
    if (matchesAny(value, envelope.deniedPaths, pathContext)) {
      return { allowed: false, reason: `Path blocked by session envelope: ${value}` };
    }
  }
  const allowedPaths = nonEmptyList(envelope.allowedPaths);
  if (allowedPaths.length > 0) {
    const blocked = pathValues.find((value) => !matchesAny(value, allowedPaths, pathContext));
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
