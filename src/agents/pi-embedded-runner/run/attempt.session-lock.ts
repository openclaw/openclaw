import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { isSessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type AbandonDiagnosticLogger = (message: string) => void;

function defaultAbandonDiagnosticLogger(message: string): void {
  process.stderr.write(`${message}\n`);
}

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
  logAbandonDiagnostic?: AbandonDiagnosticLogger;
}): Promise<EmbeddedAttemptSessionLockController> {
  const logAbandon = params.logAbandonDiagnostic ?? defaultAbandonDiagnosticLogger;
  const acquireLock = async (): Promise<SessionLock> =>
    await params.acquireSessionWriteLock({
      sessionFile: params.lockOptions.sessionFile,
      timeoutMs: params.lockOptions.timeoutMs,
      staleMs: params.lockOptions.staleMs,
      maxHoldMs: params.lockOptions.maxHoldMs,
    });

  let heldLock: SessionLock | undefined = await acquireLock();
  const activeWriteLock = new AsyncLocalStorage<SessionLock>();
  let fenceFingerprint: SessionFileFingerprint | undefined;
  let fenceActive = false;
  let takeoverDetected = false;

  type InFlightLockEntry = { lock: SessionLock; released: boolean };
  const inFlightWriteLocks = new Set<InFlightLockEntry>();

  async function releaseInFlightEntry(entry: InFlightLockEntry): Promise<void> {
    if (entry.released) {
      return;
    }
    entry.released = true;
    inFlightWriteLocks.delete(entry);
    await entry.lock.release();
  }

  // Hung post-run Pi auto-compaction can keep a reacquired write lock held
  // long past the run's timeout, blocking every later turn on the same
  // session until the watchdog max-hold timer fires (openclaw#84193). Cleanup
  // calls this to abandon any reacquired locks whose `run()` body never
  // settled so the next turn can acquire the session file.
  async function abandonInFlightWriteLocks(): Promise<boolean> {
    if (inFlightWriteLocks.size === 0) {
      return false;
    }
    takeoverDetected = true;
    const drained = Array.from(inFlightWriteLocks);
    inFlightWriteLocks.clear();
    const pendingReleases: Array<Promise<void>> = [];
    for (const entry of drained) {
      if (entry.released) {
        continue;
      }
      entry.released = true;
      pendingReleases.push(entry.lock.release().catch(() => undefined));
    }
    if (pendingReleases.length > 0) {
      logAbandon(
        `[session-write-lock] abandoned ${pendingReleases.length} in-flight lock(s) on attempt cleanup: ` +
          `sessionFile=${params.lockOptions.sessionFile} owner=pid=${process.pid} ` +
          `reason=stuck-compaction-or-hook`,
      );
    }
    // Await every release before returning so the next acquire in this cleanup
    // path (and any concurrent same-process acquire) sees the .jsonl.lock file
    // gone — otherwise the watchdog still sees it and the next acquire bounces
    // on "file lock stale" until the orphan-self detection fires.
    await Promise.all(pendingReleases);
    return true;
  }

  async function acquireWriteLock(): Promise<{
    lock: SessionLock;
    owned: boolean;
    entry?: InFlightLockEntry;
  }> {
    if (heldLock) {
      return { lock: heldLock, owned: false };
    }
    try {
      const lock = await acquireLock();
      const entry: InFlightLockEntry = { lock, released: false };
      inFlightWriteLocks.add(entry);
      return { lock, owned: true, entry };
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
    if (!sameSessionFileFingerprint(fenceFingerprint, current)) {
      takeoverDetected = true;
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
  }

  async function refreshSessionFileFence(): Promise<void> {
    if (fenceActive && !takeoverDetected) {
      fenceFingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
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
      fenceFingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
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
      const { lock, owned, entry } = await acquireWriteLock();
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
        if (owned && entry) {
          await releaseInFlightEntry(entry);
        }
      }
    },
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<SessionLock> {
      if (cleanupParams?.session) {
        await waitForSessionEventQueue(cleanupParams.session);
      }
      // If a reacquired write lock (e.g. wrapping Pi auto-compaction) never
      // settled its run() body, the lock is still held by this controller and
      // would block both this cleanup acquire and the next turn's acquire.
      // Abandon those before attempting cleanup so the session file unblocks
      // immediately. The fence already tracks session file mutations, so the
      // next turn can detect any partial-write divergence on its own acquire.
      const abandoned = await abandonInFlightWriteLocks();
      if (takeoverDetected) {
        if (abandoned && heldLock) {
          const orphan = heldLock;
          heldLock = undefined;
          await orphan.release().catch(() => {});
        }
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
