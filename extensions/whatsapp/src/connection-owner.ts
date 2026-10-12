import fs from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
// Whatsapp connection-owner lease serializes auth-backed Baileys sockets across processes.
import {
  acquireFileLock,
  FILE_LOCK_STALE_ERROR_CODE,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  type FileLockHandle,
} from "openclaw/plugin-sdk/file-lock";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

const WHATSAPP_CONNECTION_OWNER_BUSY_CODE = "whatsapp_connection_owner_busy";

export class WhatsAppConnectionOwnerBusyError extends Error {
  readonly code = WHATSAPP_CONNECTION_OWNER_BUSY_CODE;

  constructor(
    public readonly authDir: string,
    options?: ErrorOptions,
  ) {
    super("Another process owns this WhatsApp connection.", options);
    this.name = "WhatsAppConnectionOwnerBusyError";
  }
}

export type WhatsAppConnectionOwnerLease = Pick<FileLockHandle, "release">;

export type WhatsAppGatewayConnectionOwnerLease = WhatsAppConnectionOwnerLease & {
  /**
   * Registers how to finish this holder's unfinished cleanup and release the lease.
   * A later Gateway acquisition for the same auth directory runs it instead of waiting
   * on a holder that has already exited. It must do nothing while the holder is healthy.
   */
  setCleanupRetry: (retry: () => Promise<void>) => void;
};

const OWNER_LOCK_STALE_MS = 5 * 60_000;
const GATEWAY_LOCAL_OWNER_WAIT_MS = 150_000;
const INCUMBENT_CLEANUP_RETRY_MS = 5_000;

type ProcessOwner = {
  released: Promise<void>;
  resolveReleased: () => void;
  retryCleanup: (() => Promise<void>) | null;
  cleanupAttempt: Promise<void> | null;
  lastCleanupError: unknown;
};

const processOwners = new Map<string, ProcessOwner>();

function ownershipCancelledError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error(
        "WhatsApp connection ownership cancelled",
        reason === undefined ? {} : { cause: reason },
      );
}

// Single-flight so concurrent replacements never run the incumbent's cleanup twice.
function startIncumbentCleanup(owner: ProcessOwner): void {
  const retry = owner.retryCleanup;
  if (!retry || owner.cleanupAttempt) {
    return;
  }
  // Start through a promise so a synchronous throw is handled like a rejection.
  const attempt = Promise.resolve()
    .then(retry)
    .then(
      () => {
        // A retry that returns without releasing leaves the replacement waiting; say so.
        owner.lastCleanupError = owner.retryCleanup
          ? new Error("WhatsApp connection owner still holds this account")
          : undefined;
      },
      (error: unknown) => {
        // The incumbent keeps ownership until its own cleanup succeeds.
        owner.lastCleanupError = error;
      },
    );
  const settled = attempt.finally(() => {
    if (owner.cleanupAttempt === settled) {
      owner.cleanupAttempt = null;
    }
  });
  owner.cleanupAttempt = settled;
}

async function reserveProcessOwner(params: {
  authDir: string;
  ownerPath: string;
  signal?: AbortSignal;
  waitForLocalOwner: boolean;
}): Promise<ProcessOwner> {
  let waitingOn: ProcessOwner | undefined;
  let deadline = 0;
  while (true) {
    if (params.signal?.aborted) {
      throw ownershipCancelledError(params.signal);
    }
    const current = processOwners.get(params.ownerPath);
    if (!current) {
      const released = createDeferred<void>();
      const owner: ProcessOwner = {
        released: released.promise,
        resolveReleased: released.resolve,
        retryCleanup: null,
        cleanupAttempt: null,
        lastCleanupError: undefined,
      };
      processOwners.set(params.ownerPath, owner);
      return owner;
    }
    if (!params.waitForLocalOwner) {
      throw new WhatsAppConnectionOwnerBusyError(params.authDir);
    }
    if (waitingOn !== current) {
      // Each incumbent gets the full wait budget, as before the cleanup retry existed.
      waitingOn = current;
      deadline = Date.now() + GATEWAY_LOCAL_OWNER_WAIT_MS;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new WhatsAppConnectionOwnerBusyError(
        params.authDir,
        current.lastCleanupError === undefined ? undefined : { cause: current.lastCleanupError },
      );
    }
    // A failed incumbent shutdown leaves its lease held with no other caller able to
    // finish it, so the replacement drives that cleanup and waits for the release.
    startIncumbentCleanup(current);
    const outcome = await raceWithTimeout(
      current.released.then(() => "released" as const),
      Math.min(remainingMs, INCUMBENT_CLEANUP_RETRY_MS),
      (): "timed_out" | "aborted" => "timed_out",
      { ref: false, signal: params.signal, onAbort: () => "aborted" },
    );
    if (outcome === "aborted") {
      throw ownershipCancelledError(params.signal);
    }
  }
}

function abandonProcessOwner(ownerPath: string, owner: ProcessOwner): void {
  if (processOwners.get(ownerPath) !== owner) {
    return;
  }
  processOwners.delete(ownerPath);
  owner.retryCleanup = null;
  owner.resolveReleased();
}

async function acquireOwnerLease(params: {
  authDir: string;
  retries: number;
  signal?: AbortSignal;
  waitForLocalOwner: boolean;
}): Promise<WhatsAppGatewayConnectionOwnerLease> {
  const resolvedOwnerPath = resolveUserPath(params.authDir);
  await fs.mkdir(resolvedOwnerPath, { recursive: true });
  const ownerPath = await fs.realpath(resolvedOwnerPath);
  // Reserve before awaiting the filesystem so concurrent callers cannot use the
  // underlying file lock's intentionally re-entrant mode for two sockets.
  const processOwner = await reserveProcessOwner({
    authDir: params.authDir,
    ownerPath,
    signal: params.signal,
    waitForLocalOwner: params.waitForLocalOwner,
  });
  let fileLock: FileLockHandle;
  let attempt = 0;
  try {
    while (true) {
      if (params.signal?.aborted) {
        throw ownershipCancelledError(params.signal);
      }
      try {
        fileLock = await acquireFileLock(ownerPath, {
          retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
          stale: OWNER_LOCK_STALE_MS,
          // The shared lock wrapper reclaims only a definitely dead PID and removes
          // the exact unchanged sidecar. Live or ambiguous owners remain fail-closed.
          staleRecovery: "remove-if-unchanged",
        });
        break;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== FILE_LOCK_TIMEOUT_ERROR_CODE || attempt >= params.retries) {
          if (code === FILE_LOCK_TIMEOUT_ERROR_CODE || code === FILE_LOCK_STALE_ERROR_CODE) {
            throw new WhatsAppConnectionOwnerBusyError(params.authDir, { cause: error });
          }
          throw error;
        }
        const delayMs = Math.min(100 * 1.5 ** attempt, 1_000);
        attempt += 1;
        await sleepWithAbort(delayMs, params.signal).catch(() => {
          throw ownershipCancelledError(params.signal);
        });
      }
    }
  } catch (error) {
    abandonProcessOwner(ownerPath, processOwner);
    throw error;
  }
  let releasePromise: Promise<void> | null = null;
  return {
    setCleanupRetry: (retry) => {
      if (processOwners.get(ownerPath) === processOwner) {
        processOwner.retryCleanup = retry;
      }
    },
    release: async () => {
      if (!releasePromise) {
        releasePromise = fileLock
          .release()
          .then(() => {
            abandonProcessOwner(ownerPath, processOwner);
          })
          .catch((releaseError: unknown) => {
            releasePromise = null;
            throw releaseError;
          });
      }
      await releasePromise;
    },
  };
}

/** Gateway owner waits for a bounded standalone lookup to finish before startup. */
export async function acquireWhatsAppGatewayConnectionOwner(
  authDir: string,
  signal?: AbortSignal,
): Promise<WhatsAppGatewayConnectionOwnerLease> {
  // Gateway lifecycle stops an account before restarting it. A timed-out incumbent
  // must keep same-auth restarts blocked; handoff would permit concurrent sockets.
  return await acquireOwnerLease({ authDir, retries: 150, signal, waitForLocalOwner: true });
}

/** Standalone lookup fails quickly when a gateway already owns the account. */
export async function acquireWhatsAppStandaloneConnectionOwner(
  authDir: string,
): Promise<WhatsAppConnectionOwnerLease> {
  return await acquireOwnerLease({ authDir, retries: 3, waitForLocalOwner: false });
}
