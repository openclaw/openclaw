import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStringEntries } from "../../../shared/string-normalization.js";
import { isSessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type ActiveWriteLockState = {
  active: boolean;
};
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type SessionWriteLockRunOptions = {
  publishOwnedWrite?: boolean;
};

type SessionEventProcessor = {
  _processAgentEvent?: (event: unknown) => Promise<void>;
  _extensionRunner?: {
    hasHandlers?: (eventType: string) => boolean;
  };
  __openclawSessionEventWriteLockInstalled?: boolean;
};

type SessionEventQueueOwner = {
  _agentEventQueue?: PromiseLike<unknown>;
};

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type SessionWithExternalHooks = SessionEventProcessor & {
  compact?: LockableFunction;
  agent?: {
    beforeToolCall?: LockableFunction;
    afterToolCall?: LockableFunction;
    onPayload?: LockableFunction;
    onResponse?: LockableFunction;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type LockableFunction = ((...args: unknown[]) => unknown) & {
  __openclawSessionWriteLockInstalled?: boolean;
};

function sessionHasExtensionHandlers(session: SessionEventProcessor, eventType: string): boolean {
  const hasHandlers = session._extensionRunner?.hasHandlers;
  if (typeof hasHandlers !== "function") {
    return false;
  }
  try {
    return hasHandlers.call(session._extensionRunner, eventType);
  } catch {
    return true;
  }
}

function eventMayReachTranscriptWriters(session: SessionEventProcessor, event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type;
  if (type === "message_update" || type === "message_end" || type === "agent_end") {
    return true;
  }
  if (typeof type !== "string") {
    return false;
  }
  return sessionHasExtensionHandlers(session, type);
}

function installLockableFunction(params: {
  owner: Record<string, unknown>;
  key: string;
  shouldLock: () => boolean;
  waitBeforeLock?: () => Promise<void>;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const current = params.owner[params.key] as LockableFunction | undefined;
  if (typeof current !== "function" || current.__openclawSessionWriteLockInstalled === true) {
    return;
  }
  const wrapped: LockableFunction = async function lockedExternalHook(
    this: unknown,
    ...args: unknown[]
  ) {
    if (!params.shouldLock()) {
      return await current.apply(this, args);
    }
    await params.waitBeforeLock?.();
    return await params.withSessionWriteLock(async () => await current.apply(this, args));
  };
  wrapped.__openclawSessionWriteLockInstalled = true;
  params.owner[params.key] = wrapped;
}

export type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

const TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS = new Set(["delivery-mirror", "gateway-injected"]);
const MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES = 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_SAFE_FILE_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

type SessionFileFenceSnapshot = {
  fingerprint: SessionFileFingerprint;
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTranscriptOnlyOpenClawAssistantLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isJsonRecord(parsed)) {
      return false;
    }
    const message = parsed.message;
    if (!isJsonRecord(message)) {
      return false;
    }
    return (
      message.role === "assistant" &&
      message.provider === "openclaw" &&
      typeof message.model === "string" &&
      TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS.has(message.model)
    );
  } catch {
    return false;
  }
}

function readAppendedSessionFileTextSync(params: {
  sessionFile: string;
  previous: Extract<SessionFileFingerprint, { exists: true }>;
  current: Extract<SessionFileFingerprint, { exists: true }>;
}): string | undefined {
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
  const file = openSync(params.sessionFile, "r");
  try {
    const bytesRead = readSync(file, buffer, 0, length, Number(params.previous.size));
    if (bytesRead !== length) {
      return undefined;
    }
  } finally {
    closeSync(file);
  }
  return buffer.toString("utf8");
}

async function readSessionFileFenceSnapshot(
  sessionFile: string,
): Promise<SessionFileFenceSnapshot> {
  const fingerprint = await readSessionFileFingerprint(sessionFile);
  if (
    !fingerprint.exists ||
    fingerprint.size > BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES) ||
    fingerprint.size > MAX_SAFE_FILE_OFFSET
  ) {
    return { fingerprint };
  }
  try {
    return {
      fingerprint,
      text: await fs.readFile(sessionFile, "utf8"),
    };
  } catch {
    return { fingerprint };
  }
}

function readSessionFilePrefixSync(params: {
  sessionFile: string;
  length: bigint;
}): string | undefined {
  if (params.length > MAX_SAFE_FILE_OFFSET) {
    return undefined;
  }
  const length = Number(params.length);
  if (length === 0) {
    return "";
  }
  const buffer = Buffer.alloc(length);
  const file = openSync(params.sessionFile, "r");
  try {
    const bytesRead = readSync(file, buffer, 0, length, 0);
    if (bytesRead !== length) {
      return undefined;
    }
  } finally {
    closeSync(file);
  }
  return buffer.toString("utf8");
}

function sessionFenceAdvanceIsBenignSync(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
}): boolean {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current)
  ) {
    return false;
  }
  // Fail closed unless we can prove the fenced prefix is byte-identical to the
  // trusted snapshot. Otherwise a writer that rewrites the existing prefix AND
  // appends a benign-looking (delivery-mirror/gateway-injected) line could be
  // laundered as an owned advance, masking a genuine external takeover (#86572).
  if (params.previous.text === undefined) {
    return false;
  }
  const prefix = readSessionFilePrefixSync({
    sessionFile: params.sessionFile,
    length: params.previous.fingerprint.size,
  });
  if (prefix === undefined || prefix !== params.previous.text) {
    return false;
  }
  const text = readAppendedSessionFileTextSync({
    sessionFile: params.sessionFile,
    previous: params.previous.fingerprint,
    current: params.current,
  });
  if (!text?.endsWith("\n")) {
    return false;
  }
  const lines = normalizeStringEntries(text.split("\n"));
  return lines.length > 0 && lines.every(isTranscriptOnlyOpenClawAssistantLine);
}

type OwnedSessionFileWrite = {
  generation: number;
  fingerprint: SessionFileFingerprint;
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
const ownedSessionFileWrites = new Map<string, OwnedSessionFileWrite>();
const trustedSessionFileStates = new Map<string, TrustedSessionFileState>();
let ownedSessionFileWriteGeneration = 0;

function resolveSessionFileFenceKey(sessionFile: string): string {
  return path.resolve(sessionFile);
}

function recordOwnedSessionFileWrite(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): number {
  ownedSessionFileWriteGeneration += 1;
  const state = {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
  };
  ownedSessionFileWrites.set(sessionFileKey, state);
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
  return !!trusted && sameSessionFileFingerprint(trusted.fingerprint, fingerprint);
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

export function readSessionFileFingerprintSync(sessionFile: string): SessionFileFingerprint {
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

async function waitForSessionEventQueue(session: unknown): Promise<void> {
  const owner = session as SessionEventQueueOwner;
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const queue = owner?._agentEventQueue;
    if (!queue || typeof queue.then !== "function") {
      return;
    }
    await Promise.resolve(queue).catch(() => {});
    if (owner?._agentEventQueue === queue) {
      return;
    }
  }
  const queue = owner?._agentEventQueue;
  if (queue && typeof queue.then === "function") {
    await Promise.resolve(queue).catch(() => {});
  }
}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export function installSessionEventWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionEventProcessor;
  const original = session._processAgentEvent;
  if (typeof original !== "function" || session.__openclawSessionEventWriteLockInstalled === true) {
    return;
  }
  session.__openclawSessionEventWriteLockInstalled = true;
  session._processAgentEvent = async function lockedProcessAgentEvent(
    this: unknown,
    event: unknown,
  ) {
    if (!eventMayReachTranscriptWriters(session, event)) {
      return await original.call(this, event);
    }
    return await params.withSessionWriteLock(async () => await original.call(this, event));
  };
}

export function installSessionExternalHookWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionWithExternalHooks;
  const agent = session.agent;
  if (agent) {
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "beforeToolCall",
      shouldLock: () => true,
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "afterToolCall",
      shouldLock: () => sessionHasExtensionHandlers(session, "tool_result"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onPayload",
      shouldLock: () => sessionHasExtensionHandlers(session, "before_provider_request"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onResponse",
      shouldLock: () => sessionHasExtensionHandlers(session, "after_provider_response"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
  }
  installLockableFunction({
    owner: session as Record<string, unknown>,
    key: "compact",
    shouldLock: () => true,
    waitBeforeLock: () => waitForSessionEventQueue(session),
    withSessionWriteLock: params.withSessionWriteLock,
  });
}

export type EmbeddedAttemptSessionLockController = {
  releaseForPrompt(): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  publishOwnedPostMessageWrite(beforeWrite: SessionFileFingerprint | undefined): void;
  reacquireAfterPrompt(): Promise<void>;
  releaseHeldLockForAbort(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: SessionWriteLockRunOptions,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
  dispose(): Promise<void>;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  lockOptions: LockOptions;
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
  let fenceFingerprint: SessionFileFingerprint | undefined;
  let fenceSnapshot: SessionFileFenceSnapshot | undefined;
  let fenceGeneration = 0;
  let fenceActive = false;
  let takeoverDetected = false;
  const sessionFileFenceKey = resolveSessionFileFenceKey(params.lockOptions.sessionFile);

  async function acquireWriteLock(): Promise<{ lock: SessionLock; owned: boolean }> {
    if (heldLock) {
      return { lock: heldLock, owned: false };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockTimeoutError(err)) {
        takeoverDetected = true;
      }
      throw err;
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

    const ownedWrite = ownedSessionFileWrites.get(sessionFileFenceKey);
    if (
      ownedWrite &&
      ownedWrite.generation > fenceGeneration &&
      sameSessionFileFingerprint(ownedWrite.fingerprint, current)
    ) {
      fenceFingerprint = current;
      fenceGeneration = ownedWrite.generation;
      return;
    }

    takeoverDetected = true;
    throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
  }

  async function publishOwnedSessionFileWriteIfChanged(
    beforeWrite: SessionFileFingerprint,
  ): Promise<{
    fingerprint: SessionFileFingerprint;
    generation: number;
  } | null> {
    const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(beforeWrite, fingerprint)) {
      return null;
    }
    if (!isTrustedSessionFileState(sessionFileFenceKey, beforeWrite)) {
      return null;
    }
    const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, fingerprint);
    return { fingerprint, generation };
  }

  async function refreshSessionFileFence(beforeWrite: SessionFileFingerprint): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (!sameSessionFileFingerprint(beforeWrite, fingerprint) && fenceActive) {
      fenceFingerprint = fingerprint;
    }
  }

  async function publishOwnedSessionFileFence(beforeWrite: SessionFileFingerprint): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const ownedWrite = await publishOwnedSessionFileWriteIfChanged(beforeWrite);
    if (ownedWrite && fenceActive) {
      fenceFingerprint = ownedWrite.fingerprint;
      fenceGeneration = ownedWrite.generation;
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  async function releaseHeldLockWithFence(): Promise<void> {
    if (!heldLock) {
      return;
    }
    const lock = heldLock;
    heldLock = undefined;
    const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    const ownedWrite = ownedSessionFileWrites.get(sessionFileFenceKey);
    const trustedGeneration = trustSessionFileState(sessionFileFenceKey, fingerprint);
    fenceFingerprint = fingerprint;
    fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
    fenceGeneration =
      ownedWrite && sameSessionFileFingerprint(ownedWrite.fingerprint, fingerprint)
        ? ownedWrite.generation
        : (trustedGeneration ?? fenceGeneration);
    fenceActive = true;
    await lock.release();
  }

  return {
    async releaseForPrompt(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    async releaseHeldLockForAbort(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    refreshAfterOwnedSessionWrite(): void {
      if (fenceActive && !takeoverDetected) {
        fenceFingerprint = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      }
    },
    publishOwnedPostMessageWrite(beforeWrite: SessionFileFingerprint | undefined): void {
      // Called synchronously after pi's `sessionManager.appendMessage` →
      // `_persist` → `appendFileSync` from the `onMessagePersisted` callback.
      // `beforeWrite` is the file fingerprint captured immediately BEFORE the
      // session-manager append (passed through `beforeMessagePersist` in
      // `installSessionPersistenceGuard`). Records the post-write fingerprint
      // as an OWNED write in `ownedSessionFileWrites` so subsequent
      // `assertSessionFileFence` calls inside `withSessionWriteLock` accept
      // the lane's own writes via the owned-write match path.
      //
      // Fail-closed gate: the trust check runs on `beforeWrite`, not on the
      // current fence fingerprint. If an external mutation lands between
      // `releaseForPrompt` (which marks F0 trusted) and pi's append, then
      // `beforeWrite` = F1 ≠ F0 and `isTrustedSessionFileState` returns
      // false — publish is skipped and the external + pi combined state
      // (F2) is NOT recorded as owned. The subsequent hook-lock
      // `assertSessionFileFence` still sees current = F2 ≠ fence = F0 and
      // trips the takeover correctly.
      if (takeoverDetected) {
        return;
      }
      if (!beforeWrite) {
        return;
      }
      const beforeWriteMatchesActiveFence =
        fenceActive && sameSessionFileFingerprint(fenceFingerprint, beforeWrite);
      const beforeWriteIsBenignAdvance =
        fenceActive &&
        sessionFenceAdvanceIsBenignSync({
          sessionFile: params.lockOptions.sessionFile,
          previous: fenceSnapshot,
          current: beforeWrite,
        });
      if (
        !beforeWriteMatchesActiveFence &&
        !beforeWriteIsBenignAdvance &&
        !isTrustedSessionFileState(sessionFileFenceKey, beforeWrite)
      ) {
        return;
      }
      const current = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      if (sameSessionFileFingerprint(beforeWrite, current)) {
        return;
      }
      const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, current);
      if (fenceActive) {
        fenceFingerprint = current;
        fenceSnapshot = { fingerprint: current };
        fenceGeneration = generation;
      }
    },
    async reacquireAfterPrompt(): Promise<void> {
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
      options?: SessionWriteLockRunOptions,
    ): Promise<T> {
      if (takeoverDetected) {
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      if (activeWriteLock.getStore()?.active === true) {
        if (options?.publishOwnedWrite !== true) {
          return await run();
        }
        const beforeWrite = await readSessionFileFingerprint(params.lockOptions.sessionFile);
        try {
          return await run();
        } finally {
          await publishOwnedSessionFileFence(beforeWrite);
        }
      }
      const { lock, owned } = await acquireWriteLock();
      try {
        await assertSessionFileFence();
        const beforeWrite = await readSessionFileFingerprint(params.lockOptions.sessionFile);
        const runWithLock = async () => {
          try {
            return await run();
          } finally {
            if (options?.publishOwnedWrite === true) {
              await publishOwnedSessionFileFence(beforeWrite);
            } else {
              await refreshSessionFileFence(beforeWrite);
            }
          }
        };
        if (owned) {
          const activeLockState: ActiveWriteLockState = { active: true };
          try {
            return await activeWriteLock.run(activeLockState, runWithLock);
          } finally {
            activeLockState.active = false;
          }
        }
        return await runWithLock();
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
      try {
        heldLock ??= await acquireLock();
      } catch (err) {
        if (isSessionWriteLockTimeoutError(err)) {
          takeoverDetected = true;
          return noopLock;
        }
        throw err;
      }
      const cleanupLock = heldLock;
      heldLock = undefined;
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
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      await lock.release();
    },
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn.__openclawSessionLockPromptReleaseInstalled === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    await params.waitForSessionEvents(params.session);
    await params.releaseForPrompt();
    let streamResult: unknown;
    let streamError: unknown;
    let streamThrew = false;
    try {
      streamResult = await originalStreamFn(...args);
    } catch (err) {
      streamError = err;
      streamThrew = true;
    }
    // Always reacquire the prompt lock. If the stream itself already failed
    // (e.g. a provider error) AND the session file changed while the lock was
    // released, prefer the original provider error — don't let the reacquire
    // takeover error mask the real failure. Only surface the reacquire error
    // when the stream succeeded. (No throw inside finally — no-unsafe-finally.)
    try {
      await params.reacquireAfterPrompt();
    } catch (reacquireError) {
      if (!streamThrew) {
        throw reacquireError;
      }
    }
    if (streamThrew) {
      throw streamError;
    }
    return streamResult;
  };
  wrappedStreamFn.__openclawSessionLockPromptReleaseInstalled = true;
  agent.streamFn = wrappedStreamFn;
}
