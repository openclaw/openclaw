/**
 * Correlates Codex app-server notifications with the active thread/turn so
 * projectors can ignore global or stale events without losing diagnostics.
 */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCodexAppServerHomeDir } from "./auth-bridge.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

/** Returns true when a notification payload belongs to the exact active thread and turn. */
export function isCodexNotificationForTurn(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    readCodexNotificationThreadId(value) === threadId &&
    readCodexNotificationTurnId(value) === turnId
  );
}

/**
 * Reads a thread id from canonical top-level or nested thread payloads.
 * The generated v2 schemas require top-level `threadId` on turn/item-scoped
 * notifications and define `Turn` without one, so `turn.threadId` is not a
 * wire shape and is deliberately not read here.
 */
export function readCodexNotificationThreadId(record: JsonObject): string | undefined {
  const thread = isJsonObject(record.thread) ? record.thread : undefined;
  return readString(record, "threadId") ?? (thread ? readString(thread, "id") : undefined);
}

/** Reads a turn id from either top-level notification params or nested turn payloads. */
export function readCodexNotificationTurnId(record: JsonObject): string | undefined {
  return readNestedTurnId(record) ?? readString(record, "turnId");
}

function readNestedTurnId(record: JsonObject): string | undefined {
  const turn = record.turn;
  return isJsonObject(turn) ? readString(turn, "id") : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const NATIVE_PATCH_DIAGNOSTIC_MAX_ENTRIES = 256;
const NATIVE_PATCH_DIAGNOSTIC_MAX_DIRECTORIES = 48;
const NATIVE_PATCH_DIAGNOSTIC_MAX_FILES = 4;
const NATIVE_PATCH_DIAGNOSTIC_MAX_FILE_BYTES = 5 * 1024 * 1024;
const NATIVE_PATCH_DIAGNOSTIC_MAX_TAIL_BYTES = 512 * 1024;
const NATIVE_PATCH_DIAGNOSTIC_MAX_LINES = 2_048;
const NATIVE_PATCH_DIAGNOSTIC_MAX_DURATION_MS = 250;
const NATIVE_PATCH_DIAGNOSTIC_PREVIEW_MAX_CHARS = 1_000;
const NATIVE_PATCH_DIAGNOSTIC_UNSAFE_TEXT_RE =
  /(?:\*\*\* Begin Patch|\*\*\* End Patch|\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z_]*\s*=|authorization|bearer\s+[a-z0-9._~+/=-]{8,}|password|secret|token|sk-[a-z0-9_-]{8,})/iu;
const NATIVE_PATCH_DIAGNOSTIC_UNIFIED_DIFF_RE =
  /(?:^|\n)(?:diff --git\b|---\s+a\/|\+\+\+\s+b\/|@@(?:\s|$))/iu;
const NATIVE_PATCH_DIAGNOSTIC_ABSOLUTE_PATH_RE = /\/[^\s"'`<>]+/g;
const NATIVE_PATCH_DIAGNOSTIC_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const NATIVE_PATCH_DIAGNOSTIC_PATH_RE = /^[a-z0-9._/-]{1,512}$/iu;
const NATIVE_PATCH_DIAGNOSTIC_STATUSES = new Set([
  "cancelled",
  "completed",
  "error",
  "failed",
  "incomplete",
  "ok",
  "success",
  "succeeded",
]);
const NATIVE_PATCH_DIAGNOSTIC_CHANGE_KINDS = new Set([
  "add",
  "create",
  "delete",
  "move",
  "rename",
  "unknown",
  "update",
]);
const NATIVE_PATCH_DIAGNOSTIC_FALLBACKS = new Set([
  "diagnostic_scan_failed",
  "invalid_correlation",
  "patch_apply_end_unavailable",
  "rollout_oversized",
  "rollout_unavailable",
  "rollout_unreadable",
  "scan_directory_limit",
  "scan_entry_limit",
  "scan_file_limit",
  "scan_line_limit",
  "scan_time_limit",
  "unsafe_stderr_redacted",
]);

export type CodexNativePatchFailureDiagnostic = {
  schema: "openclaw.sandbox.write_diagnostic.v1";
  operation: "apply_patch";
  boundary: "codex_native_patch_apply_end_rollout";
  phase: "native_patch_apply_end_observation";
  fileChangeItemId: string;
  turnId: string;
  nativePatchApplyEndObserved: boolean;
  nativePatchApplyEndStatus?: string;
  nativePatchApplyEndSuccess?: boolean;
  nativePatchApplyEndStderrPreview?: string;
  nativePatchApplyEndStdoutPreview?: string;
  nativePatchApplyEndChanges?: Array<{ path: string; kind: string }>;
  nativePatchApplyEndDiagnosticFallback?: string;
  nativePatchApplyEndScanBounded: true;
};

type CodexNativePatchDiagnosticLimits = {
  maxEntries: number;
  maxDirectories: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTailBytes: number;
  maxLines: number;
  maxDurationMs: number;
};

const NATIVE_PATCH_DIAGNOSTIC_LIMITS: CodexNativePatchDiagnosticLimits = {
  maxEntries: NATIVE_PATCH_DIAGNOSTIC_MAX_ENTRIES,
  maxDirectories: NATIVE_PATCH_DIAGNOSTIC_MAX_DIRECTORIES,
  maxFiles: NATIVE_PATCH_DIAGNOSTIC_MAX_FILES,
  maxFileBytes: NATIVE_PATCH_DIAGNOSTIC_MAX_FILE_BYTES,
  maxTailBytes: NATIVE_PATCH_DIAGNOSTIC_MAX_TAIL_BYTES,
  maxLines: NATIVE_PATCH_DIAGNOSTIC_MAX_LINES,
  maxDurationMs: NATIVE_PATCH_DIAGNOSTIC_MAX_DURATION_MS,
};

/**
 * Reads the current failed native apply_patch observation without putting a
 * recursive session-root walk on successful or unrelated turns. Every
 * filesystem dimension is capped because this runs on the turn drain path.
 */
export async function readBoundedCodexNativePatchFailureDiagnostic(params: {
  agentDir: string;
  codexHome?: string;
  threadId: string;
  turnId: string;
  callId: string;
  /** Test-only bound overrides; production callers use the fixed defaults. */
  limits?: Partial<CodexNativePatchDiagnosticLimits>;
}): Promise<CodexNativePatchFailureDiagnostic> {
  const base = baseNativePatchFailureDiagnostic(params.callId, params.turnId);
  const threadId = params.threadId.trim();
  const turnId = params.turnId.trim();
  const callId = params.callId.trim();
  if (!threadId || !turnId || !callId) {
    return { ...base, nativePatchApplyEndDiagnosticFallback: "invalid_correlation" };
  }
  const limits = normalizeNativePatchDiagnosticLimits(params.limits);
  const deadline = Date.now() + limits.maxDurationMs;
  const rolloutFiles = await listBoundedCodexRolloutFilesForThread({
    agentDir: params.agentDir,
    codexHome: params.codexHome,
    threadId,
    deadline,
    limits,
  });
  if (rolloutFiles.reason === "scan_time_limit") {
    return { ...base, nativePatchApplyEndDiagnosticFallback: rolloutFiles.reason };
  }
  if (rolloutFiles.files.length === 0) {
    return { ...base, nativePatchApplyEndDiagnosticFallback: "rollout_unavailable" };
  }
  let scanFallback: string | undefined;
  for (const file of rolloutFiles.files) {
    if (Date.now() >= deadline) {
      return { ...base, nativePatchApplyEndDiagnosticFallback: "scan_time_limit" };
    }
    const match = await readBoundedNativePatchApplyEndFromFile({
      file,
      turnId,
      callId,
      deadline,
      limits,
    });
    if (match.payload) {
      return sanitizeNativePatchFailureDiagnostic(base, match.payload);
    }
    scanFallback ??= match.reason;
    if (match.reason === "scan_time_limit" || match.reason === "rollout_oversized") {
      return { ...base, nativePatchApplyEndDiagnosticFallback: match.reason };
    }
  }
  return {
    ...base,
    nativePatchApplyEndDiagnosticFallback:
      scanFallback ?? rolloutFiles.reason ?? "patch_apply_end_unavailable",
  };
}

function normalizeNativePatchDiagnosticLimits(
  overrides: Partial<CodexNativePatchDiagnosticLimits> | undefined,
): CodexNativePatchDiagnosticLimits {
  const positiveInteger = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.max(1, Math.floor(value))
      : fallback;
  return {
    maxEntries: positiveInteger(overrides?.maxEntries, NATIVE_PATCH_DIAGNOSTIC_LIMITS.maxEntries),
    maxDirectories: positiveInteger(
      overrides?.maxDirectories,
      NATIVE_PATCH_DIAGNOSTIC_LIMITS.maxDirectories,
    ),
    maxFiles: positiveInteger(overrides?.maxFiles, NATIVE_PATCH_DIAGNOSTIC_LIMITS.maxFiles),
    maxFileBytes: positiveInteger(
      overrides?.maxFileBytes,
      NATIVE_PATCH_DIAGNOSTIC_LIMITS.maxFileBytes,
    ),
    maxTailBytes: positiveInteger(
      overrides?.maxTailBytes,
      NATIVE_PATCH_DIAGNOSTIC_LIMITS.maxTailBytes,
    ),
    maxLines: positiveInteger(overrides?.maxLines, NATIVE_PATCH_DIAGNOSTIC_LIMITS.maxLines),
    maxDurationMs: positiveInteger(
      overrides?.maxDurationMs,
      NATIVE_PATCH_DIAGNOSTIC_LIMITS.maxDurationMs,
    ),
  };
}

async function listBoundedCodexRolloutFilesForThread(params: {
  agentDir: string;
  codexHome?: string;
  threadId: string;
  deadline: number;
  limits: CodexNativePatchDiagnosticLimits;
}): Promise<{ files: Array<{ path: string; bytes: number }>; reason?: string }> {
  const resolvedAgentDir = path.resolve(params.agentDir);
  const resolvedCodexHome = params.codexHome?.trim()
    ? path.resolve(params.codexHome)
    : resolveCodexAppServerHomeDir(resolvedAgentDir);
  const roots = [
    path.join(resolvedCodexHome, "sessions"),
    path.join(resolveCodexAppServerHomeDir(resolvedAgentDir), "sessions"),
    path.join(resolvedAgentDir, "agent", "codex-home", "sessions"),
    path.join(path.dirname(resolvedAgentDir), "codex-home", "sessions"),
  ];
  const files: Array<{ path: string; bytes: number }> = [];
  const visitedRoots = new Set<string>();
  const visitedFiles = new Set<string>();
  let entryCount = 0;
  let directoryCount = 0;
  for (const root of roots) {
    if (visitedRoots.has(root)) {
      continue;
    }
    visitedRoots.add(root);
    const stack = [root];
    while (stack.length > 0) {
      if (Date.now() >= params.deadline) {
        return { files, reason: "scan_time_limit" };
      }
      if (directoryCount >= params.limits.maxDirectories) {
        return { files, reason: "scan_directory_limit" };
      }
      const dir = stack.pop();
      if (!dir) {
        continue;
      }
      directoryCount += 1;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      // Codex session paths are date-shaped; reverse lexical order reaches the
      // active rollout first while still respecting the hard traversal caps.
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > params.limits.maxEntries) {
          return { files, reason: "scan_entry_limit" };
        }
        const candidate = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(candidate);
          continue;
        }
        if (
          !entry.isFile() ||
          !isCodexAppServerRolloutFileNameForThread(candidate, params.threadId) ||
          visitedFiles.has(candidate)
        ) {
          continue;
        }
        visitedFiles.add(candidate);
        try {
          files.push({ path: candidate, bytes: (await fs.stat(candidate)).size });
        } catch {
          continue;
        }
        if (files.length >= params.limits.maxFiles) {
          return { files, reason: "scan_file_limit" };
        }
      }
    }
  }
  return { files };
}

async function readBoundedNativePatchApplyEndFromFile(params: {
  file: { path: string; bytes: number };
  turnId: string;
  callId: string;
  deadline: number;
  limits: CodexNativePatchDiagnosticLimits;
}): Promise<{ payload?: JsonObject; reason?: string }> {
  if (params.file.bytes > params.limits.maxFileBytes) {
    return { reason: "rollout_oversized" };
  }
  const bytesToRead = Math.min(params.file.bytes, params.limits.maxTailBytes);
  const offset = Math.max(0, params.file.bytes - bytesToRead);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(params.file.path, "r");
  } catch {
    return { reason: "rollout_unreadable" };
  }
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    const lines = text.split("\n");
    let inspected = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (Date.now() >= params.deadline) {
        return { reason: "scan_time_limit" };
      }
      if (inspected >= params.limits.maxLines) {
        return { reason: "scan_line_limit" };
      }
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      inspected += 1;
      let record: JsonValue;
      try {
        record = JSON.parse(line) as JsonValue;
      } catch {
        continue;
      }
      const payload = isJsonObject(record) && isJsonObject(record.payload) ? record.payload : null;
      if (
        payload?.type === "patch_apply_end" &&
        payload.turn_id === params.turnId &&
        payload.call_id === params.callId
      ) {
        return { payload };
      }
    }
    return {};
  } finally {
    await handle.close();
  }
}

function baseNativePatchFailureDiagnostic(
  callId: string,
  turnId: string,
): CodexNativePatchFailureDiagnostic {
  return {
    schema: "openclaw.sandbox.write_diagnostic.v1",
    operation: "apply_patch",
    boundary: "codex_native_patch_apply_end_rollout",
    phase: "native_patch_apply_end_observation",
    fileChangeItemId: sanitizeNativePatchDiagnosticIdentifier(callId, "<redacted-call-id>"),
    turnId: sanitizeNativePatchDiagnosticIdentifier(turnId, "<redacted-turn-id>"),
    nativePatchApplyEndObserved: false,
    nativePatchApplyEndScanBounded: true,
  };
}

function sanitizeNativePatchFailureDiagnostic(
  base: CodexNativePatchFailureDiagnostic,
  payload: JsonObject,
): CodexNativePatchFailureDiagnostic {
  const stderrPreview = sanitizeNativePatchDiagnosticPreview(payload.stderr);
  const stdoutPreview = sanitizeNativePatchDiagnosticPreview(payload.stdout);
  return {
    ...base,
    nativePatchApplyEndObserved: true,
    ...(typeof payload.status === "string"
      ? { nativePatchApplyEndStatus: sanitizeNativePatchDiagnosticStatus(payload.status) }
      : {}),
    ...(typeof payload.success === "boolean"
      ? { nativePatchApplyEndSuccess: payload.success }
      : {}),
    ...(stderrPreview ? { nativePatchApplyEndStderrPreview: stderrPreview } : {}),
    ...(stdoutPreview ? { nativePatchApplyEndStdoutPreview: stdoutPreview } : {}),
    nativePatchApplyEndChanges: sanitizeNativePatchDiagnosticChanges(payload.changes),
    ...(!stderrPreview && typeof payload.stderr === "string"
      ? { nativePatchApplyEndDiagnosticFallback: "unsafe_stderr_redacted" }
      : {}),
  };
}

function sanitizeNativePatchDiagnosticPreview(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const raw = value.trim();
  if (!raw || isUnsafeNativePatchDiagnosticString(raw)) {
    return undefined;
  }
  const redacted = raw
    .replace(NATIVE_PATCH_DIAGNOSTIC_ABSOLUTE_PATH_RE, (match) => {
      const trailing = match.match(/[),.;:!?]+$/u)?.[0] ?? "";
      const pathPart = trailing ? match.slice(0, -trailing.length) : match;
      return pathPart === "/workspace" || pathPart.startsWith("/workspace/")
        ? `${pathPart}${trailing}`
        : `<redacted-filechange-path>${trailing}`;
    })
    .trim();
  if (
    !redacted ||
    NATIVE_PATCH_DIAGNOSTIC_UNSAFE_TEXT_RE.test(redacted) ||
    NATIVE_PATCH_DIAGNOSTIC_UNIFIED_DIFF_RE.test(redacted)
  ) {
    return undefined;
  }
  return redacted.length <= NATIVE_PATCH_DIAGNOSTIC_PREVIEW_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, NATIVE_PATCH_DIAGNOSTIC_PREVIEW_MAX_CHARS)}...(truncated)`;
}

function sanitizeNativePatchDiagnosticChanges(
  value: unknown,
): Array<{ path: string; kind: string }> {
  if (!isJsonObject(value)) {
    return [];
  }
  return Object.entries(value)
    .slice(0, 32)
    .flatMap(([rawPath, rawChange]) => {
      const normalizedPath = sanitizeNativePatchDiagnosticPath(rawPath);
      if (!normalizedPath) {
        return [];
      }
      const change = isJsonObject(rawChange) ? rawChange : undefined;
      const kind =
        typeof change?.type === "string"
          ? sanitizeNativePatchDiagnosticChangeKind(change.type)
          : typeof change?.kind === "string"
            ? sanitizeNativePatchDiagnosticChangeKind(change.kind)
            : "unknown";
      return [{ path: normalizedPath, kind }];
    });
}

function sanitizeNativePatchDiagnosticPath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").trim();
  if (!normalized || normalized.includes("\0")) {
    return undefined;
  }
  if (
    !NATIVE_PATCH_DIAGNOSTIC_PATH_RE.test(normalized) ||
    isUnsafeNativePatchDiagnosticString(normalized)
  ) {
    return "<redacted-filechange-path>";
  }
  if (path.isAbsolute(normalized)) {
    return normalized === "/workspace" || normalized.startsWith("/workspace/")
      ? normalized
      : "<redacted-filechange-path>";
  }
  if (normalized.split("/").includes("..")) {
    return "<redacted-filechange-path>";
  }
  return normalized;
}

function isCodexAppServerRolloutFileNameForThread(fileName: string, threadId: string): boolean {
  const activeThreadId = threadId.trim();
  if (!activeThreadId) {
    return false;
  }
  const baseName = path.basename(fileName);
  if (!baseName.startsWith("rollout-") || !baseName.endsWith(".jsonl")) {
    return false;
  }
  if (baseName === `rollout-${activeThreadId}.jsonl`) {
    return true;
  }
  const escapedThreadId = activeThreadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${escapedThreadId}\\.jsonl$`,
    "u",
  ).test(baseName);
}

export function sanitizeNativePatchDiagnosticForEmission(
  value: CodexNativePatchFailureDiagnostic,
): CodexNativePatchFailureDiagnostic {
  const stderrPreview = sanitizeNativePatchDiagnosticPreview(
    value.nativePatchApplyEndStderrPreview,
  );
  const stdoutPreview = sanitizeNativePatchDiagnosticPreview(
    value.nativePatchApplyEndStdoutPreview,
  );
  return {
    schema: "openclaw.sandbox.write_diagnostic.v1",
    operation: "apply_patch",
    boundary: "codex_native_patch_apply_end_rollout",
    phase: "native_patch_apply_end_observation",
    fileChangeItemId: sanitizeNativePatchDiagnosticIdentifier(
      value.fileChangeItemId,
      "<redacted-call-id>",
    ),
    turnId: sanitizeNativePatchDiagnosticIdentifier(value.turnId, "<redacted-turn-id>"),
    nativePatchApplyEndObserved: value.nativePatchApplyEndObserved,
    ...(value.nativePatchApplyEndStatus
      ? {
          nativePatchApplyEndStatus: sanitizeNativePatchDiagnosticStatus(
            value.nativePatchApplyEndStatus,
          ),
        }
      : {}),
    ...(typeof value.nativePatchApplyEndSuccess === "boolean"
      ? { nativePatchApplyEndSuccess: value.nativePatchApplyEndSuccess }
      : {}),
    ...(stderrPreview ? { nativePatchApplyEndStderrPreview: stderrPreview } : {}),
    ...(stdoutPreview ? { nativePatchApplyEndStdoutPreview: stdoutPreview } : {}),
    ...(value.nativePatchApplyEndChanges
      ? {
          nativePatchApplyEndChanges: value.nativePatchApplyEndChanges
            .slice(0, 32)
            .map((change) => ({
              path: sanitizeNativePatchDiagnosticPath(change.path) ?? "<redacted-filechange-path>",
              kind: sanitizeNativePatchDiagnosticChangeKind(change.kind),
            })),
        }
      : {}),
    ...(value.nativePatchApplyEndDiagnosticFallback
      ? {
          nativePatchApplyEndDiagnosticFallback: NATIVE_PATCH_DIAGNOSTIC_FALLBACKS.has(
            value.nativePatchApplyEndDiagnosticFallback,
          )
            ? value.nativePatchApplyEndDiagnosticFallback
            : "diagnostic_scan_failed",
        }
      : {}),
    nativePatchApplyEndScanBounded: true,
  };
}

export function sanitizeNativePatchDiagnosticIdentifier(value: string, fallback: string): string {
  const normalized = value.trim();
  return NATIVE_PATCH_DIAGNOSTIC_ID_RE.test(normalized) &&
    !isUnsafeNativePatchDiagnosticString(normalized)
    ? normalized
    : fallback;
}

function sanitizeNativePatchDiagnosticStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  return NATIVE_PATCH_DIAGNOSTIC_STATUSES.has(normalized) ? normalized : "<redacted-status>";
}

function sanitizeNativePatchDiagnosticChangeKind(value: string): string {
  const normalized = value.trim().toLowerCase();
  return NATIVE_PATCH_DIAGNOSTIC_CHANGE_KINDS.has(normalized)
    ? normalized
    : "<redacted-change-kind>";
}

function isUnsafeNativePatchDiagnosticString(value: string): boolean {
  return (
    NATIVE_PATCH_DIAGNOSTIC_UNSAFE_TEXT_RE.test(value) ||
    NATIVE_PATCH_DIAGNOSTIC_UNIFIED_DIFF_RE.test(value)
  );
}
