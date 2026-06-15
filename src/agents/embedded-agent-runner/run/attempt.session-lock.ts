/**
 * Coordinates embedded-attempt session ownership, takeover, and prompt locks.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  type OwnedSessionTranscriptWriteOptions,
  type OwnedSessionTranscriptCacheSnapshot,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { isSessionWriteLockAcquireError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";
import type {
  CustomEntry,
  LabelEntry,
  SessionInfoEntry,
  SessionMessageEntry,
} from "../../sessions/session-manager.js";
import { resolveEmbeddedSessionFileKey } from "../session-file-key.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;
type ActiveWriteLockState = {
  active: boolean;
  publishingOwnedWrite: boolean;
};

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type SessionFileWriteAppendValidator<T> = (result: T, appendedText: string) => boolean;

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

export type TrustedSessionFileSnapshot = Extract<SessionFileFingerprint, { exists: true }>;

const TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS = new Set(["delivery-mirror", "gateway-injected"]);
const MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES = 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_RESULT_BYTES =
  MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES + MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES;
const MAX_BENIGN_SESSION_FENCE_CTIME_DIGEST_BYTES = 32 * 1024 * 1024;
const MAX_SAFE_FILE_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

type SessionFileFenceSnapshot = {
  fingerprint: SessionFileFingerprint;
  digest?: string;
  text?: string;
};

function sameSessionFileFingerprint(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  if (!left || left.exists !== right.exists) {
    return false;
  }
  if (!left.exists || !right.exists) {
    return true;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameSessionFileIdentity(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  return Boolean(left?.exists && right.exists && left.dev === right.dev && left.ino === right.ino);
}

function sameSessionFileContentMetadata(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  return Boolean(
    left?.exists &&
    right.exists &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs,
  );
}

function splitSessionFileLines(text: string): string[] {
  return normalizeStringEntries(text.split(/\r?\n/));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePromptReleasedMessageLine(
  line: string,
  options?: { allowAnyMessage?: boolean },
): SessionMessageEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      !isJsonRecord(parsed) ||
      typeof parsed.id !== "string" ||
      parsed.id.trim().length === 0 ||
      typeof parsed.timestamp !== "string" ||
      parsed.timestamp.trim().length === 0 ||
      (parsed.parentId !== undefined &&
        parsed.parentId !== null &&
        typeof parsed.parentId !== "string")
    ) {
      return undefined;
    }
    const message = parsed.message;
    if (!isJsonRecord(message)) {
      return undefined;
    }
    const isOpenClawTranscriptOnlyAssistant =
      message.role === "assistant" &&
      message.provider === "openclaw" &&
      typeof message.model === "string" &&
      TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS.has(message.model);
    if (
      typeof message.role !== "string" ||
      (!options?.allowAnyMessage && !isOpenClawTranscriptOnlyAssistant)
    ) {
      return undefined;
    }
    return {
      type: "message",
      id: parsed.id,
      parentId: parsed.parentId ?? null,
      timestamp: parsed.timestamp,
      message: message as unknown as SessionMessageEntry["message"],
    };
  } catch {
    return undefined;
  }
}

function hasSessionEntryBase(record: Record<string, unknown>): boolean {
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    (record.parentId === null || typeof record.parentId === "string") &&
    typeof record.timestamp === "string" &&
    record.timestamp.trim().length > 0
  );
}

export type PromptReleasedSessionMetadataEntry = CustomEntry | LabelEntry | SessionInfoEntry;

export type PromptReleasedSessionEntry = SessionMessageEntry | PromptReleasedSessionMetadataEntry;

function parsePromptReleasedGlobalMetadataLine(
  line: string,
): PromptReleasedSessionMetadataEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isJsonRecord(parsed) || !hasSessionEntryBase(parsed)) {
      return undefined;
    }
    const base = {
      id: parsed.id as string,
      parentId: parsed.parentId as string | null,
      timestamp: parsed.timestamp as string,
    };
    // These records are resolved globally rather than through the active branch.
    // Accepting them keeps an in-flight reply alive without losing branch-scoped
    // model or thinking state when the active SessionManager is stale.
    switch (parsed.type) {
      case "custom":
        return typeof parsed.customType === "string" && parsed.customType.trim().length > 0
          ? {
              ...base,
              type: "custom",
              customType: parsed.customType,
              ...(Object.hasOwn(parsed, "data") ? { data: parsed.data } : {}),
            }
          : undefined;
      case "label":
        return typeof parsed.targetId === "string" &&
          parsed.targetId.trim().length > 0 &&
          (parsed.label === undefined || typeof parsed.label === "string")
          ? {
              ...base,
              type: "label",
              targetId: parsed.targetId,
              label: parsed.label,
            }
          : undefined;
      case "session_info":
        return parsed.name === undefined || typeof parsed.name === "string"
          ? {
              ...base,
              type: "session_info",
              ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
            }
          : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

type PromptReleasedSessionChange =
  | {
      kind: "transcript-only";
      entries: SessionMessageEntry[];
    }
  | {
      kind: "global-metadata";
      entries: PromptReleasedSessionEntry[];
    };

function classifyPromptReleasedSessionLines(
  lines: string[],
  options?: { allowAnyMessage?: boolean },
): PromptReleasedSessionChange | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const entries: PromptReleasedSessionEntry[] = [];
  let hasGlobalMetadata = false;
  for (const line of lines) {
    const transcriptEntry = parsePromptReleasedMessageLine(line, options);
    if (transcriptEntry) {
      entries.push(transcriptEntry);
      continue;
    }
    const metadataEntry = parsePromptReleasedGlobalMetadataLine(line);
    if (!metadataEntry) {
      return undefined;
    }
    entries.push(metadataEntry);
    hasGlobalMetadata = true;
  }
  return hasGlobalMetadata
    ? { kind: "global-metadata", entries }
    : { kind: "transcript-only", entries: entries as SessionMessageEntry[] };
}

function normalizeTranscriptEntryId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function omitRecordKeys(
  record: Record<string, unknown>,
  keys: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function lineMatchesLinearTranscriptMigration(params: {
  previousLine: string;
  currentLine: string;
  expectedParentId: string | null;
}): { ok: true; nextPreviousId?: string } | { ok: false } {
  let previousParsed: unknown;
  let currentParsed: unknown;
  try {
    previousParsed = JSON.parse(params.previousLine);
    currentParsed = JSON.parse(params.currentLine);
  } catch {
    return params.previousLine === params.currentLine ? { ok: true } : { ok: false };
  }
  if (!isJsonRecord(previousParsed)) {
    return params.previousLine === params.currentLine ? { ok: true } : { ok: false };
  }
  if (!isJsonRecord(currentParsed)) {
    return { ok: false };
  }
  if (previousParsed.type === "session") {
    return isDeepStrictEqual(
      omitRecordKeys(previousParsed, new Set(["version"])),
      omitRecordKeys(currentParsed, new Set(["version"])),
    )
      ? { ok: true }
      : { ok: false };
  }

  const previousId = normalizeTranscriptEntryId(previousParsed.id);
  const currentId = normalizeTranscriptEntryId(currentParsed.id);
  if (previousId ? currentId !== previousId : !currentId) {
    return { ok: false };
  }
  if (Object.hasOwn(previousParsed, "parentId")) {
    if (!isDeepStrictEqual(previousParsed.parentId, currentParsed.parentId)) {
      return { ok: false };
    }
  } else if (!isDeepStrictEqual(currentParsed.parentId, params.expectedParentId)) {
    return { ok: false };
  }

  return isDeepStrictEqual(
    omitRecordKeys(previousParsed, new Set(["id", "parentId"])),
    omitRecordKeys(currentParsed, new Set(["id", "parentId"])),
  )
    ? { ok: true, nextPreviousId: currentId }
    : { ok: false };
}

async function readAppendedSessionFileText(params: {
  sessionFile: string;
  previous: Extract<SessionFileFingerprint, { exists: true }>;
  current: Extract<SessionFileFingerprint, { exists: true }>;
}): Promise<string | undefined> {
  if (params.current.size <= params.previous.size || params.previous.size > MAX_SAFE_FILE_OFFSET) {
    return undefined;
  }
  const appendedBytes = params.current.size - params.previous.size;
  if (
    appendedBytes > BigInt(MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES) ||
    appendedBytes > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  const length = Number(appendedBytes);
  const buffer = Buffer.alloc(length);
  const file = await fs.open(params.sessionFile, "r");
  try {
    const { bytesRead } = await file.read(buffer, 0, length, Number(params.previous.size));
    if (bytesRead !== length) {
      return undefined;
    }
  } finally {
    await file.close();
  }
  return buffer.toString("utf8");
}

async function readSessionFileFenceSnapshot(
  sessionFile: string,
): Promise<SessionFileFenceSnapshot> {
  const fingerprint = await readSessionFileFingerprint(sessionFile);
  if (!fingerprint.exists) {
    return { fingerprint };
  }
  if (
    fingerprint.size <= BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES) &&
    fingerprint.size <= MAX_SAFE_FILE_OFFSET
  ) {
    try {
      return {
        fingerprint,
        text: await fs.readFile(sessionFile, "utf8"),
      };
    } catch {
      return { fingerprint };
    }
  }
  if (fingerprint.size > BigInt(MAX_BENIGN_SESSION_FENCE_CTIME_DIGEST_BYTES)) {
    return { fingerprint };
  }
  return {
    fingerprint,
    digest: await readSessionFileDigest(sessionFile),
  };
}

async function readSessionFileDigest(sessionFile: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  return await new Promise<string | undefined>((resolve) => {
    const stream = createReadStream(sessionFile);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", () => {
      resolve(undefined);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

async function classifySessionFenceAdvance(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  allowAnyMessage?: boolean;
}): Promise<PromptReleasedSessionChange | undefined> {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current)
  ) {
    return undefined;
  }
  const text = await readAppendedSessionFileText({
    sessionFile: params.sessionFile,
    previous: params.previous.fingerprint,
    current: params.current,
  });
  if (!text?.endsWith("\n")) {
    return undefined;
  }
  const lines = normalizeStringEntries(text.split("\n"));
  return classifyPromptReleasedSessionLines(lines, params);
}

async function sessionFenceCtimeDriftIsBenign(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
}): Promise<boolean> {
  if (
    !sameSessionFileContentMetadata(params.previous?.fingerprint, params.current) ||
    params.previous?.fingerprint.exists !== true ||
    !params.current.exists ||
    params.previous.fingerprint.ctimeNs === params.current.ctimeNs
  ) {
    return false;
  }
  if (params.previous.text === undefined) {
    if (params.previous.digest === undefined) {
      return false;
    }
    const currentDigest = await readSessionFileDigest(params.sessionFile);
    return currentDigest !== undefined && currentDigest === params.previous.digest;
  }
  try {
    return (await fs.readFile(params.sessionFile, "utf8")) === params.previous.text;
  } catch {
    return false;
  }
}

async function classifySessionFenceRewrite(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  allowAnyMessage?: boolean;
}): Promise<PromptReleasedSessionChange | undefined> {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    !params.previous.text ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current) ||
    params.current.size > BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_RESULT_BYTES) ||
    params.current.size > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  let currentText: string;
  try {
    currentText = await fs.readFile(params.sessionFile, "utf8");
  } catch {
    return undefined;
  }
  if (!currentText.endsWith("\n")) {
    return undefined;
  }
  const previousLines = splitSessionFileLines(params.previous.text);
  const currentLines = splitSessionFileLines(currentText);
  if (currentLines.length <= previousLines.length) {
    return undefined;
  }
  let expectedParentId: string | null = null;
  for (let index = 0; index < previousLines.length; index += 1) {
    const lineMatch = lineMatchesLinearTranscriptMigration({
      previousLine: previousLines[index] ?? "",
      currentLine: currentLines[index] ?? "",
      expectedParentId,
    });
    if (!lineMatch.ok) {
      return undefined;
    }
    expectedParentId = lineMatch.nextPreviousId ?? expectedParentId;
  }
  const appendedLines = currentLines.slice(previousLines.length);
  return classifyPromptReleasedSessionLines(appendedLines, params);
}

async function classifySessionFenceChange(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  allowAnyMessage?: boolean;
}): Promise<PromptReleasedSessionChange | undefined> {
  return (await classifySessionFenceAdvance(params)) ?? (await classifySessionFenceRewrite(params));
}

type OwnedSessionFileWrite = {
  generation: number;
  fingerprint: SessionFileFingerprint;
  entryIds?: readonly string[];
};

type OwnedSessionFileWriteHistory = {
  activeFenceGenerations: Map<symbol, number>;
  writes: OwnedSessionFileWrite[];
};

type TrustedSessionFileState = {
  generation: number;
  fingerprint: SessionFileFingerprint;
};

// Controllers in the same OpenClaw process can legitimately take turns writing
// the same session file while another attempt is released for model I/O. Track
// only fingerprints that changed while OpenClaw held the write lock so the
// takeover fence can distinguish those locked in-process writes from unowned
// external file changes.
const ownedSessionFileWrites = new Map<string, OwnedSessionFileWriteHistory>();
const trustedSessionFileStates = new Map<string, TrustedSessionFileState>();
let ownedSessionFileWriteGeneration = 0;

function resolveSessionFileFenceKey(sessionFile: string): string {
  return resolveEmbeddedSessionFileKey(sessionFile);
}

type SessionFileOwnerWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
};

type SessionFileOwnerEntry = {
  ownerId: symbol;
  waiters: Set<SessionFileOwnerWaiter>;
};

type SessionFileOwnerState = {
  owners: Map<string, SessionFileOwnerEntry>;
};

const EMBEDDED_ATTEMPT_SESSION_FILE_OWNER_STATE_KEY = Symbol.for(
  "openclaw.embeddedAttemptSessionFileOwnerState",
);

const sessionFileOwnerState = resolveGlobalSingleton(
  EMBEDDED_ATTEMPT_SESSION_FILE_OWNER_STATE_KEY,
  (): SessionFileOwnerState => ({
    owners: new Map<string, SessionFileOwnerEntry>(),
  }),
);

export type EmbeddedAttemptSessionFileOwner = {
  sessionFileKey: string;
  release(): void;
};

export class EmbeddedAttemptSessionFileOwnerTimeoutError extends Error {
  constructor(sessionFile: string, timeoutMs: number) {
    super(`timed out waiting for embedded session file owner after ${timeoutMs}ms: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionFileOwnerTimeoutError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

function abortOwnerWaitReason(signal: AbortSignal): unknown {
  return abortReason(signal) ?? new Error("operation aborted", { cause: signal });
}

function waitForSessionFileOwnerRelease(params: {
  sessionFile: string;
  entry: SessionFileOwnerEntry;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    return Promise.reject(
      toLintErrorObject(abortOwnerWaitReason(params.signal), "Non-Error rejection"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: SessionFileOwnerWaiter = {
      resolve,
      reject,
      signal: params.signal,
    };
    const cleanup = () => {
      params.entry.waiters.delete(waiter);
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      }
    };
    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    waiter.reject = (error) => {
      cleanup();
      reject(toLintErrorObject(error, "Non-Error rejection"));
    };
    if (params.timeoutMs !== undefined && Number.isFinite(params.timeoutMs)) {
      waiter.timer = setTimeout(
        () => {
          waiter.reject(
            new EmbeddedAttemptSessionFileOwnerTimeoutError(
              params.sessionFile,
              params.timeoutMs ?? 0,
            ),
          );
        },
        Math.max(1, Math.floor(params.timeoutMs)),
      );
      waiter.timer.unref?.();
    }
    if (params.signal) {
      waiter.abortListener = () => {
        waiter.reject(abortOwnerWaitReason(params.signal!));
      };
      params.signal.addEventListener("abort", waiter.abortListener, { once: true });
    }
    params.entry.waiters.add(waiter);
  });
}

export async function acquireEmbeddedAttemptSessionFileOwner(params: {
  sessionFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EmbeddedAttemptSessionFileOwner> {
  const sessionFileKey = resolveEmbeddedSessionFileKey(params.sessionFile);
  const ownerId = Symbol(sessionFileKey);
  while (true) {
    if (params.signal?.aborted) {
      throw abortOwnerWaitReason(params.signal);
    }
    const entry = sessionFileOwnerState.owners.get(sessionFileKey);
    if (!entry) {
      sessionFileOwnerState.owners.set(sessionFileKey, {
        ownerId,
        waiters: new Set(),
      });
      return {
        sessionFileKey,
        release() {
          const current = sessionFileOwnerState.owners.get(sessionFileKey);
          if (!current || current.ownerId !== ownerId) {
            return;
          }
          sessionFileOwnerState.owners.delete(sessionFileKey);
          for (const waiter of current.waiters) {
            waiter.resolve();
          }
        },
      };
    }
    await waitForSessionFileOwnerRelease({
      sessionFile: params.sessionFile,
      entry,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  }
}

export function resetEmbeddedAttemptSessionFileOwnersForTest(): void {
  for (const entry of sessionFileOwnerState.owners.values()) {
    for (const waiter of entry.waiters) {
      waiter.reject(
        new Error("embedded attempt session file owners reset", {
          cause: "resetEmbeddedAttemptSessionFileOwnersForTest",
        }),
      );
    }
  }
  sessionFileOwnerState.owners.clear();
  ownedSessionFileWrites.clear();
  trustedSessionFileStates.clear();
  ownedSessionFileWriteGeneration = 0;
}

function resolveOwnedSessionFileWriteHistory(sessionFileKey: string): OwnedSessionFileWriteHistory {
  const existing = ownedSessionFileWrites.get(sessionFileKey);
  if (existing) {
    return existing;
  }
  const created = {
    activeFenceGenerations: new Map<symbol, number>(),
    writes: [],
  };
  ownedSessionFileWrites.set(sessionFileKey, created);
  return created;
}

function pruneOwnedSessionFileWriteHistory(
  sessionFileKey: string,
  history: OwnedSessionFileWriteHistory,
): void {
  if (history.activeFenceGenerations.size === 0) {
    ownedSessionFileWrites.delete(sessionFileKey);
    return;
  }
  const oldestFenceGeneration = Math.min(...history.activeFenceGenerations.values());
  history.writes = history.writes.filter((write) => write.generation > oldestFenceGeneration);
}

function recordOwnedSessionFileWrite(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
  entryIds?: readonly string[],
): number {
  ownedSessionFileWriteGeneration += 1;
  const state = {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
    ...(entryIds ? { entryIds: [...entryIds] } : {}),
  };
  const history = resolveOwnedSessionFileWriteHistory(sessionFileKey);
  history.writes.push(state);
  pruneOwnedSessionFileWriteHistory(sessionFileKey, history);
  trustedSessionFileStates.set(sessionFileKey, state);
  return ownedSessionFileWriteGeneration;
}

function recordTrustedSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): number {
  ownedSessionFileWriteGeneration += 1;
  const state = {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
  };
  trustedSessionFileStates.set(sessionFileKey, state);
  return ownedSessionFileWriteGeneration;
}

function trustSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): number | undefined {
  const trusted = trustedSessionFileStates.get(sessionFileKey);
  if (trusted) {
    return sameSessionFileFingerprint(trusted.fingerprint, fingerprint)
      ? trusted.generation
      : undefined;
  }
  ownedSessionFileWriteGeneration += 1;
  trustedSessionFileStates.set(sessionFileKey, {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
  });
  return ownedSessionFileWriteGeneration;
}

function isTrustedSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): boolean {
  const trusted = trustedSessionFileStates.get(sessionFileKey);
  return trusted !== undefined && sameSessionFileFingerprint(trusted.fingerprint, fingerprint);
}

async function readSessionFileFingerprint(sessionFile: string): Promise<SessionFileFingerprint> {
  try {
    const stat = await fs.stat(sessionFile, { bigint: true });
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

function readSessionFileFingerprintSync(sessionFile: string): SessionFileFingerprint {
  try {
    const stat = statSync(sessionFile, { bigint: true });
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function waitForSessionEventQueue(_session: unknown): Promise<void> {}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export type EmbeddedAttemptSessionLockController = {
  canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  readTrustedCurrentSessionFileSnapshot(): Promise<TrustedSessionFileSnapshot | undefined>;
  releaseForPrompt(): Promise<void>;
  releaseHeldLockForAbort(): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  withOwnedSessionFileWrite<T>(
    run: () => T,
    validateAppend?: SessionFileWriteAppendValidator<T>,
  ): T;
  reacquireAfterPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
  dispose(): Promise<void>;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  lockOptions: LockOptions;
  mergePromptReleasedSessionEntries?: (
    entries: readonly PromptReleasedSessionEntry[],
  ) => Promise<void> | void;
}): Promise<EmbeddedAttemptSessionLockController> {
  const acquireLock = async (): Promise<SessionLock> =>
    await params.acquireSessionWriteLock({
      sessionFile: params.lockOptions.sessionFile,
      timeoutMs: params.lockOptions.timeoutMs,
      staleMs: params.lockOptions.staleMs,
      maxHoldMs: params.lockOptions.maxHoldMs,
    });

  let heldLock: SessionLock | undefined = await acquireLock();
  const activeWriteLock = new AsyncLocalStorage<ActiveWriteLockState>();
  let ownedPublicationQueue: Promise<void> = Promise.resolve();
  let fenceFingerprint: SessionFileFingerprint | undefined;
  let fenceSnapshot: SessionFileFenceSnapshot | undefined;
  let fenceGeneration = 0;
  let fenceActive = false;
  let takeoverDetected = false;
  let retainedLockUseCount = 0;
  const retainedLockIdleWaiters = new Set<() => void>();
  let heldLockDraining = false;
  let heldLockDrainOwner: symbol | undefined;
  const heldLockDrainWaiters = new Set<() => void>();
  const sessionFileFenceKey = resolveSessionFileFenceKey(params.lockOptions.sessionFile);
  const controllerFenceId = Symbol(sessionFileFenceKey);

  function setFenceGeneration(generation: number): void {
    fenceGeneration = generation;
    if (!fenceActive) {
      return;
    }
    const history = resolveOwnedSessionFileWriteHistory(sessionFileFenceKey);
    history.activeFenceGenerations.set(controllerFenceId, generation);
    pruneOwnedSessionFileWriteHistory(sessionFileFenceKey, history);
  }

  function activateFence(generation: number): void {
    fenceActive = true;
    setFenceGeneration(generation);
  }

  function deactivateFence(): void {
    if (!fenceActive) {
      return;
    }
    fenceActive = false;
    const history = ownedSessionFileWrites.get(sessionFileFenceKey);
    if (!history) {
      return;
    }
    history.activeFenceGenerations.delete(controllerFenceId);
    pruneOwnedSessionFileWriteHistory(sessionFileFenceKey, history);
  }

  async function mergePromptReleasedSessionChange(
    previous: SessionFileFenceSnapshot | undefined,
    current: SessionFileFingerprint,
    options?: { expectedEntryIds?: readonly string[] },
  ): Promise<
    | {
        snapshot: SessionFileFenceSnapshot;
        entryIds: string[];
      }
    | undefined
  > {
    if (!params.mergePromptReleasedSessionEntries) {
      return undefined;
    }
    const change = await classifySessionFenceChange({
      sessionFile: params.lockOptions.sessionFile,
      previous,
      current,
      allowAnyMessage: options?.expectedEntryIds !== undefined,
    });
    if (!change) {
      return undefined;
    }
    if (
      options?.expectedEntryIds &&
      !isDeepStrictEqual(
        change.entries.map((entry) => entry.id),
        [...options.expectedEntryIds],
      )
    ) {
      return undefined;
    }
    try {
      await params.mergePromptReleasedSessionEntries(change.entries);
    } catch (error) {
      takeoverDetected = true;
      throw error;
    }
    const refreshedSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
    if (!sameSessionFileFingerprint(current, refreshedSnapshot.fingerprint)) {
      takeoverDetected = true;
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    return {
      snapshot: refreshedSnapshot,
      entryIds: change.entries.map((entry) => entry.id),
    };
  }

  function beginRetainedLockUse(): () => void {
    retainedLockUseCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      retainedLockUseCount -= 1;
      if (retainedLockUseCount === 0 && retainedLockIdleWaiters.size > 0) {
        const waiters = Array.from(retainedLockIdleWaiters);
        retainedLockIdleWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      }
    };
  }

  async function waitForRetainedLockIdle(): Promise<boolean> {
    if (retainedLockUseCount === 0) {
      return true;
    }
    if (activeWriteLock.getStore()?.active === true) {
      return false;
    }
    await new Promise<void>((resolve) => {
      retainedLockIdleWaiters.add(resolve);
    });
    return true;
  }

  async function acquireWriteLock(): Promise<{
    lock: SessionLock;
    owned: boolean;
    releaseRetainedUse?: () => void;
  }> {
    await waitForHeldLockDrain();
    if (heldLock) {
      return { lock: heldLock, owned: false, releaseRetainedUse: beginRetainedLockUse() };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockAcquireError(err)) {
        takeoverDetected = true;
      }
      throw err;
    }
  }

  async function waitForHeldLockDrain(): Promise<void> {
    for (;;) {
      if (!heldLockDraining) {
        return;
      }
      await new Promise<void>((resolve) => {
        heldLockDrainWaiters.add(resolve);
      });
    }
  }

  async function beginHeldLockDrain(): Promise<symbol> {
    for (;;) {
      if (!heldLockDraining) {
        const owner = Symbol("held-lock-drain");
        heldLockDraining = true;
        heldLockDrainOwner = owner;
        return owner;
      }
      await new Promise<void>((resolve) => {
        heldLockDrainWaiters.add(resolve);
      });
    }
  }

  function finishHeldLockDrain(owner: symbol): void {
    if (!heldLockDraining || heldLockDrainOwner !== owner) {
      return;
    }
    heldLockDraining = false;
    heldLockDrainOwner = undefined;
    if (heldLockDrainWaiters.size === 0) {
      return;
    }
    const waiters = Array.from(heldLockDrainWaiters);
    heldLockDrainWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  async function assertSessionFileFence(): Promise<void> {
    if (!fenceActive) {
      return;
    }
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(fenceFingerprint, current)) {
      return;
    }

    const ownedWriteHistory = ownedSessionFileWrites.get(sessionFileFenceKey)?.writes ?? [];
    const ownedWrite = ownedWriteHistory.at(-1);
    if (
      ownedWrite &&
      ownedWrite.generation > fenceGeneration &&
      sameSessionFileFingerprint(ownedWrite.fingerprint, current)
    ) {
      const unseenOwnedWrites = ownedWriteHistory.filter(
        (write) => write.generation > fenceGeneration,
      );
      const canValidateExactEntries = unseenOwnedWrites.every(
        (write) => write.entryIds !== undefined,
      );
      const expectedEntryIds = canValidateExactEntries
        ? unseenOwnedWrites.flatMap((write) => write.entryIds ?? [])
        : undefined;
      const mergedChange = await mergePromptReleasedSessionChange(
        fenceSnapshot,
        current,
        expectedEntryIds ? { expectedEntryIds } : undefined,
      );
      if (params.mergePromptReleasedSessionEntries && !mergedChange) {
        takeoverDetected = true;
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      fenceFingerprint = current;
      fenceSnapshot = mergedChange?.snapshot ?? { fingerprint: current };
      setFenceGeneration(ownedWrite.generation);
      return;
    }

    if (
      await sessionFenceCtimeDriftIsBenign({
        sessionFile: params.lockOptions.sessionFile,
        previous: fenceSnapshot,
        current,
      })
    ) {
      fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
      fenceFingerprint = fenceSnapshot.fingerprint;
      setFenceGeneration(recordTrustedSessionFileState(sessionFileFenceKey, current));
      return;
    }

    const changeKind = await classifySessionFenceChange({
      sessionFile: params.lockOptions.sessionFile,
      previous: fenceSnapshot,
      current,
    });
    if (changeKind?.kind === "transcript-only" && !params.mergePromptReleasedSessionEntries) {
      fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
      fenceFingerprint = fenceSnapshot.fingerprint;
      setFenceGeneration(trustSessionFileState(sessionFileFenceKey, current) ?? fenceGeneration);
      return;
    }
    if (changeKind && params.mergePromptReleasedSessionEntries) {
      const mergedChange = await mergePromptReleasedSessionChange(fenceSnapshot, current);
      if (!mergedChange) {
        takeoverDetected = true;
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      fenceSnapshot = mergedChange.snapshot;
      fenceFingerprint = mergedChange.snapshot.fingerprint;
      setFenceGeneration(
        trustSessionFileState(sessionFileFenceKey, mergedChange.snapshot.fingerprint) ??
          fenceGeneration,
      );
      return;
    }

    takeoverDetected = true;
    throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
  }

  async function refreshSessionFileFence(beforeWrite: SessionFileFingerprint): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const snapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
    if (!sameSessionFileFingerprint(beforeWrite, snapshot.fingerprint) && fenceActive) {
      fenceFingerprint = snapshot.fingerprint;
      fenceSnapshot = snapshot;
    }
  }

  async function captureOwnedSessionFileWriteStart(): Promise<SessionFileFenceSnapshot> {
    const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    const currentFenceSnapshot = fenceSnapshot;
    if (
      currentFenceSnapshot &&
      sameSessionFileFingerprint(currentFenceSnapshot.fingerprint, fingerprint)
    ) {
      return currentFenceSnapshot;
    }
    return { fingerprint };
  }

  async function publishOwnedSessionFileFence(
    beforeWrite: SessionFileFenceSnapshot,
    expectedEntryIds?: readonly string[],
  ): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(beforeWrite.fingerprint, current)) {
      return;
    }
    const beforeWriteIsTrusted =
      (fenceActive && sameSessionFileFingerprint(fenceFingerprint, beforeWrite.fingerprint)) ||
      isTrustedSessionFileState(sessionFileFenceKey, beforeWrite.fingerprint);
    if (!beforeWriteIsTrusted) {
      return;
    }
    const mergedChange = await mergePromptReleasedSessionChange(
      beforeWrite,
      current,
      expectedEntryIds ? { expectedEntryIds } : undefined,
    );
    if (params.mergePromptReleasedSessionEntries && !mergedChange) {
      takeoverDetected = true;
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    const publishedEntryIds = expectedEntryIds ?? mergedChange?.entryIds;
    const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, current, publishedEntryIds);
    if (fenceActive) {
      fenceFingerprint = current;
      fenceSnapshot =
        mergedChange?.snapshot ??
        (await readSessionFileFenceSnapshot(params.lockOptions.sessionFile));
      setFenceGeneration(generation);
    }
  }

  // Synchronous append paths cannot await withSessionWriteLock. Only publish
  // their post-write fingerprint when the pre-write state was already trusted.
  function publishOwnedSessionFileFenceSync<T>(write: {
    beforeWrite: SessionFileFingerprint;
    result: T;
    beforeText?: string;
    validateAppend?: SessionFileWriteAppendValidator<T>;
  }): void {
    if (takeoverDetected) {
      return;
    }
    const fingerprint = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
    const beforeWriteIsTrusted =
      (fenceActive && sameSessionFileFingerprint(fenceFingerprint, write.beforeWrite)) ||
      isTrustedSessionFileState(sessionFileFenceKey, write.beforeWrite);
    if (sameSessionFileFingerprint(write.beforeWrite, fingerprint) || !beforeWriteIsTrusted) {
      return;
    }
    if (write.validateAppend) {
      const afterText = readFileSync(params.lockOptions.sessionFile, "utf8");
      if (
        write.beforeText === undefined ||
        !afterText.startsWith(write.beforeText) ||
        !write.validateAppend(write.result, afterText.slice(write.beforeText.length))
      ) {
        return;
      }
    }
    const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, fingerprint);
    if (fenceActive) {
      fenceFingerprint = fingerprint;
      fenceSnapshot = { fingerprint };
      setFenceGeneration(generation);
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  async function releaseHeldLockWithFence(): Promise<void> {
    if (!heldLock) {
      await waitForHeldLockDrain();
      return;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        return;
      }
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      // Clearing `heldLock` transfers release ownership to this block. Fence reads can
      // throw after that transfer; release the underlying file lock anyway so later
      // turns do not wait for the maxHoldMs watchdog.
      try {
        const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
        const ownedWrite = ownedSessionFileWrites.get(sessionFileFenceKey)?.writes.at(-1);
        const trustedGeneration = trustSessionFileState(sessionFileFenceKey, fingerprint);
        fenceFingerprint = fingerprint;
        fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
        const releasedFenceGeneration =
          ownedWrite && sameSessionFileFingerprint(ownedWrite.fingerprint, fingerprint)
            ? ownedWrite.generation
            : (trustedGeneration ?? fenceGeneration);
        activateFence(releasedFenceGeneration);
      } finally {
        await lock.release();
      }
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function takeHeldLockAfterRetainedIdle(): Promise<SessionLock | undefined> {
    if (!heldLock) {
      return undefined;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        return undefined;
      }
      if (!heldLock) {
        return undefined;
      }
      const lock = heldLock;
      heldLock = undefined;
      return lock;
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function disposeHeldLockAfterRetainedIdle(): Promise<void> {
    if (!heldLock) {
      await waitForHeldLockDrain();
      return;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        return;
      }
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      await lock.release();
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function acquireCleanupLock(): Promise<SessionLock | undefined> {
    const retainedLock = await takeHeldLockAfterRetainedIdle();
    if (retainedLock) {
      return retainedLock;
    }
    await waitForHeldLockDrain();
    try {
      return await acquireLock();
    } catch (err) {
      if (isSessionWriteLockAcquireError(err)) {
        takeoverDetected = true;
        return undefined;
      }
      throw err;
    }
  }

  async function runWithRetainedLock<T>(
    run: () => Promise<T>,
    releaseRetainedUse: () => void,
  ): Promise<T> {
    try {
      const activeLockState: ActiveWriteLockState = {
        active: true,
        publishingOwnedWrite: false,
      };
      try {
        return await activeWriteLock.run(activeLockState, run);
      } finally {
        activeLockState.active = false;
      }
    } finally {
      releaseRetainedUse();
    }
  }

  async function runPublishingOwnedSessionFileWrite<T>(
    run: () => Promise<T> | T,
    resolvePublishedEntryIds?: (result: T) => readonly string[],
  ): Promise<T> {
    const parentLockState = activeWriteLock.getStore();
    if (parentLockState?.publishingOwnedWrite) {
      return await run();
    }
    let releaseQueue!: () => void;
    const currentQueueEntry = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const previousQueueEntry = ownedPublicationQueue.catch(() => undefined);
    ownedPublicationQueue = previousQueueEntry.then(() => currentQueueEntry);
    await previousQueueEntry;
    try {
      if (takeoverDetected) {
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      const beforeWrite = await captureOwnedSessionFileWriteStart();
      const publicationLockState: ActiveWriteLockState = {
        active: parentLockState?.active ?? true,
        publishingOwnedWrite: true,
      };
      try {
        return await activeWriteLock.run(publicationLockState, async () => {
          let expectedEntryIds: readonly string[] | undefined;
          try {
            const result = await run();
            expectedEntryIds = resolvePublishedEntryIds?.(result);
            return result;
          } finally {
            await publishOwnedSessionFileFence(beforeWrite, expectedEntryIds);
          }
        });
      } finally {
        publicationLockState.active = false;
      }
    } finally {
      releaseQueue();
    }
  }

  return {
    canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      if (takeoverDetected || activeWriteLock.getStore()?.active !== true) {
        return false;
      }
      const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
      return (
        (fenceActive && sameSessionFileFingerprint(fenceFingerprint, fingerprint)) ||
        isTrustedSessionFileState(sessionFileFenceKey, fingerprint)
      );
    },
    publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      if (takeoverDetected || activeWriteLock.getStore()?.active !== true) {
        return false;
      }
      const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
      const current = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      if (!sameSessionFileFingerprint(fingerprint, current)) {
        return false;
      }
      const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, current);
      if (fenceActive) {
        fenceFingerprint = current;
        fenceSnapshot = { fingerprint: current };
        setFenceGeneration(generation);
      }
      return true;
    },
    publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      if (takeoverDetected || !heldLock || heldLockDraining) {
        return false;
      }
      const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
      const current = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      if (!sameSessionFileFingerprint(fingerprint, current)) {
        return false;
      }
      setFenceGeneration(recordTrustedSessionFileState(sessionFileFenceKey, current));
      if (fenceActive) {
        fenceFingerprint = current;
        fenceSnapshot = { fingerprint: current };
      }
      return true;
    },
    async readTrustedCurrentSessionFileSnapshot(): Promise<TrustedSessionFileSnapshot | undefined> {
      const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
      return fingerprint.exists && isTrustedSessionFileState(sessionFileFenceKey, fingerprint)
        ? fingerprint
        : undefined;
    },
    async releaseForPrompt(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    async releaseHeldLockForAbort(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    refreshAfterOwnedSessionWrite(): void {
      if (takeoverDetected) {
        return;
      }
      const beforeWrite = fenceFingerprint;
      const fingerprint = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      if (!fenceActive) {
        // User-message persistence occurs before the prompt fence activates.
        // The retained session lock owns that write, so publish its exact state
        // for the next attempt before release establishes the active fence.
        setFenceGeneration(recordTrustedSessionFileState(sessionFileFenceKey, fingerprint));
        return;
      }
      if (
        !sameSessionFileFingerprint(beforeWrite, fingerprint) &&
        isTrustedSessionFileState(sessionFileFenceKey, beforeWrite ?? { exists: false })
      ) {
        setFenceGeneration(recordOwnedSessionFileWrite(sessionFileFenceKey, fingerprint));
      }
      fenceFingerprint = fingerprint;
      fenceSnapshot = { fingerprint };
    },
    withOwnedSessionFileWrite<T>(
      run: () => T,
      validateAppend?: SessionFileWriteAppendValidator<T>,
    ): T {
      const beforeWrite = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      const beforeText = validateAppend
        ? readFileSync(params.lockOptions.sessionFile, "utf8")
        : undefined;
      const result = run();
      publishOwnedSessionFileFenceSync({
        beforeWrite,
        result,
        ...(beforeText !== undefined ? { beforeText } : {}),
        ...(validateAppend ? { validateAppend } : {}),
      });
      return result;
    },
    async reacquireAfterPrompt(): Promise<void> {
      await waitForHeldLockDrain();
      if (takeoverDetected || heldLock) {
        return;
      }
      const lock = await acquireLock();
      try {
        heldLock = lock;
        await assertSessionFileFence();
      } catch (err) {
        heldLock = undefined;
        await lock.release();
        throw err;
      }
    },
    waitForSessionEvents: waitForSessionEventQueue,
    async withSessionWriteLock<T>(
      run: () => Promise<T> | T,
      options?: OwnedSessionTranscriptWriteOptions<T>,
    ): Promise<T> {
      if (takeoverDetected) {
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      if (activeWriteLock.getStore()?.active === true) {
        if (options?.publishOwnedWrite !== true) {
          return await run();
        }
        return await runPublishingOwnedSessionFileWrite(run, options.resolvePublishedEntryIds);
      }
      const { lock, owned, releaseRetainedUse } = await acquireWriteLock();
      try {
        const runLockedOperation = async () => {
          await assertSessionFileFence();
          const runWithLock = async () => {
            if (options?.publishOwnedWrite === true) {
              return await runPublishingOwnedSessionFileWrite(
                run,
                options.resolvePublishedEntryIds,
              );
            }
            const beforeWrite = await readSessionFileFingerprint(params.lockOptions.sessionFile);
            try {
              return await run();
            } finally {
              await refreshSessionFileFence(beforeWrite);
            }
          };
          return await runWithLock();
        };
        if (owned) {
          const activeLockState: ActiveWriteLockState = {
            active: true,
            publishingOwnedWrite: false,
          };
          try {
            return await activeWriteLock.run(activeLockState, runLockedOperation);
          } finally {
            activeLockState.active = false;
          }
        }
        return await runWithRetainedLock(runLockedOperation, releaseRetainedUse ?? (() => {}));
      } finally {
        if (owned) {
          await lock.release();
        }
      }
    },
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<SessionLock> {
      if (cleanupParams?.session) {
        await waitForSessionEventQueue(cleanupParams.session);
      }
      if (takeoverDetected) {
        return noopLock;
      }
      const cleanupLock = await acquireCleanupLock();
      if (!cleanupLock) {
        return noopLock;
      }
      try {
        await assertSessionFileFence();
      } catch (err) {
        await cleanupLock.release();
        if (err instanceof EmbeddedAttemptSessionTakeoverError) {
          return noopLock;
        }
        throw err;
      }
      return cleanupLock;
    },
    hasSessionTakeover(): boolean {
      return takeoverDetected;
    },
    async dispose(): Promise<void> {
      try {
        await disposeHeldLockAfterRetainedIdle();
      } finally {
        deactivateFence();
      }
    },
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
  sessionFile?: string;
  sessionKey?: string;
  withSessionWriteLock?: <T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ) => Promise<T>;
  canAdvanceSessionEntryCache?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
  publishSessionFileSnapshot?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn["__openclawSessionLockPromptReleaseInstalled"] === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    await params.waitForSessionEvents(params.session);
    await params.releaseForPrompt();
    try {
      if (params.sessionFile && params.withSessionWriteLock) {
        return await withOwnedSessionTranscriptWrites(
          {
            sessionFile: params.sessionFile,
            sessionKey: params.sessionKey,
            withSessionWriteLock: params.withSessionWriteLock,
            canAdvanceSessionEntryCache: params.canAdvanceSessionEntryCache,
            publishSessionFileSnapshot: params.publishSessionFileSnapshot,
          },
          async () => await originalStreamFn(...args),
        );
      }
      return await originalStreamFn(...args);
    } finally {
      await params.waitForSessionEvents(params.session);
      await params.reacquireAfterPrompt();
    }
  };
  wrappedStreamFn["__openclawSessionLockPromptReleaseInstalled"] = true;
  agent.streamFn = wrappedStreamFn;
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
