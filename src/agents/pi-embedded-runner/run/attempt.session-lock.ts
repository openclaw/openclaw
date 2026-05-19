import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { isSessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";
import { isSessionEntry } from "../transcript-file-state.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
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
  const extensionRunner = session["_extensionRunner"];
  const hasHandlers = extensionRunner?.hasHandlers;
  if (typeof hasHandlers !== "function") {
    return false;
  }
  try {
    return hasHandlers.call(extensionRunner, eventType);
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
  if (typeof current !== "function" || current["__openclawSessionWriteLockInstalled"] === true) {
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
  wrapped["__openclawSessionWriteLockInstalled"] = true;
  params.owner[params.key] = wrapped;
}

type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
      birthtimeNs: bigint;
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
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
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
      birthtimeNs: stat.birthtimeNs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

// The runner's own transcript appends during the released prompt window
// (appendSessionTranscriptMessageLocked with allowReentrant:true) change the
// session file's stat without going through refreshSessionFileFence, so any
// stat mismatch needs a tighter check before being treated as a takeover.
// We only tolerate a fingerprint mismatch when ALL of these hold:
//   - same dev/ino (no atomic replacement)
//   - file grew (size only increases between fence set and assert)
//   - bytes [0, fenceSize) hash identical to the fenced prefix hash
//   - bytes [fenceSize, currentSize) contain only message entries whose
//     role is in the runner-owned persisted set: assistant, toolResult,
//     or bashExecution. Non-message tail entries (custom, branch_summary,
//     compaction, session) and any other role are rejected.
// Anything else — file replacement, shrink, in-place rewrite of earlier
// bytes, a new user-role entry, or a malformed tail — remains a real takeover.

type FenceSnapshot = {
  fingerprint: SessionFileFingerprint;
  prefixHashHex: string | null;
};

async function snapshotSessionFileFence(sessionFile: string): Promise<FenceSnapshot> {
  const fingerprint = await readSessionFileFingerprint(sessionFile);
  if (!fingerprint.exists) {
    return { fingerprint, prefixHashHex: null };
  }
  const buffer = await fs.readFile(sessionFile).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!buffer) {
    return { fingerprint: { exists: false }, prefixHashHex: null };
  }
  // Confirm the read buffer matches the pre-read stat; otherwise an in-place
  // rewrite (same size or otherwise) between the two could leave us hashing
  // post-rewrite content against a pre-rewrite fingerprint. Re-stat and
  // compare every fingerprint field, including mtimeNs / ctimeNs, so a
  // same-size rewrite still fails closed. Returning prefixHashHex: null
  // forces the next assertSessionFileFence to treat the file as taken over
  // instead of blessing a mixed-snapshot baseline.
  const postReadFingerprint = await readSessionFileFingerprint(sessionFile);
  const fenceOffset = Number(fingerprint.size);
  if (
    !Number.isSafeInteger(fenceOffset) ||
    buffer.byteLength !== fenceOffset ||
    !sameSessionFileFingerprint(fingerprint, postReadFingerprint)
  ) {
    return { fingerprint, prefixHashHex: null };
  }
  return {
    fingerprint,
    prefixHashHex: createHash("sha256").update(buffer.subarray(0, fenceOffset)).digest("hex"),
  };
}

type AppendOnlyVerification = { ok: true; nextSnapshot: FenceSnapshot } | { ok: false };

async function verifyAppendOnlyRunnerOwnedExtension(
  sessionFile: string,
  fence: FenceSnapshot,
): Promise<AppendOnlyVerification> {
  if (!fence.fingerprint.exists || fence.prefixHashHex === null) {
    return { ok: false };
  }
  const fenceOffset = Number(fence.fingerprint.size);
  if (!Number.isSafeInteger(fenceOffset) || fenceOffset < 0) {
    return { ok: false };
  }
  const fingerprint = await readSessionFileFingerprint(sessionFile);
  if (!fingerprint.exists) {
    return { ok: false };
  }
  // dev/ino guard catches replacement onto a new inode; birthtime guard catches
  // the unlink+recreate-same-inode case (common on tmpfs/ext4 with rapid
  // recreation), where dev and ino are reused but the inode itself is fresh.
  if (
    fingerprint.dev !== fence.fingerprint.dev ||
    fingerprint.ino !== fence.fingerprint.ino ||
    fingerprint.birthtimeNs !== fence.fingerprint.birthtimeNs
  ) {
    return { ok: false };
  }
  if (fingerprint.size <= fence.fingerprint.size) {
    return { ok: false };
  }
  const buffer = await fs.readFile(sessionFile).catch(() => null);
  const currentOffset = Number(fingerprint.size);
  if (
    !buffer ||
    !Number.isSafeInteger(currentOffset) ||
    buffer.byteLength !== currentOffset ||
    buffer.byteLength < fenceOffset
  ) {
    // Refuse when a concurrent write between stat and read left the buffer
    // and fingerprint out of sync; otherwise the snapshot we return would
    // describe a different file than the next slow path reads.
    return { ok: false };
  }
  // Re-stat after the read so a same-size in-place rewrite during the
  // stat -> read gap fails closed: the post-read fingerprint will differ
  // in mtimeNs / ctimeNs from the pre-read one even when byte length and
  // dev/ino/birthtime are identical.
  const postReadFingerprint = await readSessionFileFingerprint(sessionFile);
  if (!sameSessionFileFingerprint(fingerprint, postReadFingerprint)) {
    return { ok: false };
  }
  const prefixHash = createHash("sha256").update(buffer.subarray(0, fenceOffset)).digest("hex");
  if (prefixHash !== fence.prefixHashHex) {
    return { ok: false };
  }
  const tail = buffer.subarray(fenceOffset).toString("utf8");
  for (const line of tail.split("\n")) {
    if (!line) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // Malformed tail line (partial write); refuse to bless the change.
      return { ok: false };
    }
    // Delegate the whole-entry contract (record shape, type, id, parentId,
    // timestamp, message shape) to the canonical isSessionEntry validator,
    // then narrow to the runner-owned role subset. User and custom roles
    // remain real takeover signals even when the underlying entry is
    // well-formed.
    if (!isSessionEntry(entry) || entry.type !== "message") {
      return { ok: false };
    }
    const role = (entry.message as { role?: unknown }).role;
    if (role !== "assistant" && role !== "toolResult" && role !== "bashExecution") {
      return { ok: false };
    }
  }
  // The gate-check prefixHash above covers only the bytes up to the old
  // fence offset. The next slow path will rehash the file up to the new
  // fingerprint.size, so the stored snapshot must describe the full
  // current file. Otherwise a guarded operation that throws between
  // assertSessionFileFence and refreshSessionFileFence leaves a poisoned
  // fence (next legitimate runner append false-positives as takeover).
  const nextPrefixHash = createHash("sha256").update(buffer).digest("hex");
  return {
    ok: true,
    nextSnapshot: { fingerprint, prefixHashHex: nextPrefixHash },
  };
}

async function waitForSessionEventQueue(session: unknown): Promise<void> {
  const owner = session as SessionEventQueueOwner;
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const queue = owner?.["_agentEventQueue"];
    if (!queue || typeof queue.then !== "function") {
      return;
    }
    await Promise.resolve(queue).catch(() => {});
    if (owner?.["_agentEventQueue"] === queue) {
      return;
    }
  }
  const queue = owner?.["_agentEventQueue"];
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
  const original = session["_processAgentEvent"];
  if (
    typeof original !== "function" ||
    session["__openclawSessionEventWriteLockInstalled"] === true
  ) {
    return;
  }
  session["__openclawSessionEventWriteLockInstalled"] = true;
  session["_processAgentEvent"] = async function lockedProcessAgentEvent(
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
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
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
  const activeWriteLock = new AsyncLocalStorage<SessionLock>();
  let fenceSnapshot: FenceSnapshot | undefined;
  let fenceActive = false;
  let takeoverDetected = false;

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
    if (!fenceActive || !fenceSnapshot) {
      return;
    }
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(fenceSnapshot.fingerprint, current)) {
      return;
    }
    const verified = await verifyAppendOnlyRunnerOwnedExtension(
      params.lockOptions.sessionFile,
      fenceSnapshot,
    );
    if (!verified.ok) {
      takeoverDetected = true;
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    fenceSnapshot = verified.nextSnapshot;
  }

  async function refreshSessionFileFence(): Promise<void> {
    if (fenceActive && !takeoverDetected) {
      fenceSnapshot = await snapshotSessionFileFence(params.lockOptions.sessionFile);
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  return {
    async releaseForPrompt(): Promise<void> {
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      fenceSnapshot = await snapshotSessionFileFence(params.lockOptions.sessionFile);
      fenceActive = true;
      await lock.release();
    },
    waitForSessionEvents: waitForSessionEventQueue,
    async withSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T> {
      if (takeoverDetected) {
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      if (activeWriteLock.getStore()) {
        return await run();
      }
      const { lock, owned } = await acquireWriteLock();
      try {
        await assertSessionFileFence();
        const runWithLock = async () => {
          const result = await run();
          await refreshSessionFileFence();
          return result;
        };
        if (owned) {
          return await activeWriteLock.run(lock, runWithLock);
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
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
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
    return await originalStreamFn(...args);
  };
  wrappedStreamFn["__openclawSessionLockPromptReleaseInstalled"] = true;
  agent.streamFn = wrappedStreamFn;
}
