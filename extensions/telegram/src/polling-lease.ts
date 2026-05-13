import { registerInProcessRestartHook } from "openclaw/plugin-sdk/lifecycle-restart-hooks";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const TELEGRAM_POLLING_LEASES_KEY = Symbol.for("openclaw.telegram.pollingLeases");
const DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS = 5_000;

type TelegramPollingLeaseEntry = {
  accountId: string;
  abortSignal?: AbortSignal;
  done: Promise<void>;
  owner: symbol;
  resolveDone: () => void;
  startedAt: number;
};

type TelegramPollingLeaseRegistry = Map<string, TelegramPollingLeaseEntry>;

export type TelegramPollingLease = {
  tokenFingerprint: string;
  waitedForPrevious: boolean;
  replacedStoppingPrevious: boolean;
  release: () => void;
};

type AcquireTelegramPollingLeaseOpts = {
  token: string;
  accountId: string;
  abortSignal?: AbortSignal;
  waitMs?: number;
};

type WaitForPreviousResult = "released" | "timeout" | "aborted";

function pollingLeaseRegistry(): TelegramPollingLeaseRegistry {
  const proc = process as NodeJS.Process & {
    [TELEGRAM_POLLING_LEASES_KEY]?: TelegramPollingLeaseRegistry;
  };
  proc[TELEGRAM_POLLING_LEASES_KEY] ??= new Map();
  return proc[TELEGRAM_POLLING_LEASES_KEY];
}

function createDuplicatePollingError(params: {
  accountId: string;
  existing: TelegramPollingLeaseEntry;
  tokenFingerprint: string;
}): Error {
  const ageMs = Math.max(0, Date.now() - params.existing.startedAt);
  const ageSeconds = Math.round(ageMs / 1000);
  return new Error(
    `Telegram polling already active for bot token ${params.tokenFingerprint} on account "${params.existing.accountId}" (${ageSeconds}s old); refusing duplicate poller for account "${params.accountId}". Stop the existing OpenClaw gateway/poller or use a different bot token.`,
  );
}

async function waitForPreviousRelease(params: {
  done: Promise<void>;
  signal?: AbortSignal;
  waitMs: number;
}): Promise<WaitForPreviousResult> {
  if (params.signal?.aborted) {
    return "aborted";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, params.waitMs));
      timer.unref?.();
    });
    const aborted = new Promise<"aborted">((resolve) => {
      abortListener = () => resolve("aborted");
      params.signal?.addEventListener("abort", abortListener, { once: true });
    });
    const released = params.done.then(() => "released" as const);
    return await Promise.race([released, timeout, aborted]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (abortListener) {
      params.signal?.removeEventListener("abort", abortListener);
    }
  }
}

function createLease(params: {
  accountId: string;
  abortSignal?: AbortSignal;
  registry: TelegramPollingLeaseRegistry;
  tokenFingerprint: string;
  waitedForPrevious: boolean;
  replacedStoppingPrevious: boolean;
}): TelegramPollingLease {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const owner = Symbol(`telegram-polling:${params.accountId}`);
  const entry: TelegramPollingLeaseEntry = {
    accountId: params.accountId,
    abortSignal: params.abortSignal,
    done,
    owner,
    resolveDone,
    startedAt: Date.now(),
  };
  params.registry.set(params.tokenFingerprint, entry);

  let released = false;
  return {
    tokenFingerprint: params.tokenFingerprint,
    waitedForPrevious: params.waitedForPrevious,
    replacedStoppingPrevious: params.replacedStoppingPrevious,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = params.registry.get(params.tokenFingerprint);
      if (current?.owner === owner) {
        params.registry.delete(params.tokenFingerprint);
      }
      resolveDone();
    },
  };
}

export async function acquireTelegramPollingLease(
  opts: AcquireTelegramPollingLeaseOpts,
): Promise<TelegramPollingLease> {
  const registry = pollingLeaseRegistry();
  const fingerprint = fingerprintTelegramBotToken(opts.token);
  const waitMs = opts.waitMs ?? DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS;
  let waitedForPrevious = false;

  for (;;) {
    const existing = registry.get(fingerprint);
    if (!existing) {
      return createLease({
        accountId: opts.accountId,
        abortSignal: opts.abortSignal,
        registry,
        tokenFingerprint: fingerprint,
        waitedForPrevious,
        replacedStoppingPrevious: false,
      });
    }

    if (!existing.abortSignal?.aborted) {
      throw createDuplicatePollingError({
        accountId: opts.accountId,
        existing,
        tokenFingerprint: fingerprint,
      });
    }

    waitedForPrevious = true;
    const waitResult = await waitForPreviousRelease({
      done: existing.done,
      signal: opts.abortSignal,
      waitMs,
    });
    if (waitResult === "aborted") {
      throw new Error(
        `Telegram polling start aborted while waiting for previous poller for bot token ${fingerprint} to stop.`,
      );
    }

    const current = registry.get(fingerprint);
    if (current !== existing) {
      continue;
    }
    if (waitResult === "released") {
      continue;
    }

    return createLease({
      accountId: opts.accountId,
      abortSignal: opts.abortSignal,
      registry,
      tokenFingerprint: fingerprint,
      waitedForPrevious,
      replacedStoppingPrevious: true,
    });
  }
}

export function resetTelegramPollingLeasesForTests(): void {
  pollingLeaseRegistry().clear();
}

/**
 * Self-register the lifecycle reset hook on first module load. The underlying
 * registry already de-duplicates by hook identity, but a fresh closure would
 * be created on every module load, so we guard with a process-symbol flag to
 * keep the registration idempotent across ESM/CJS interop boundaries.
 */
const LIFECYCLE_HOOK_REGISTERED_KEY = Symbol.for(
  "openclaw.telegram.pollingLeases.lifecycleHookRegistered",
);
{
  const host = process as NodeJS.Process & {
    [LIFECYCLE_HOOK_REGISTERED_KEY]?: boolean;
  };
  if (!host[LIFECYCLE_HOOK_REGISTERED_KEY]) {
    host[LIFECYCLE_HOOK_REGISTERED_KEY] = true;
    registerInProcessRestartHook(() => {
      releaseTelegramPollingLeasesForLifecycleReset();
    });
  }
}

/**
 * Lifecycle boundary cleanup for in-process gateway restarts.
 *
 * The lease registry lives on a process-global symbol so it survives Node-level
 * restarts that recycle the gateway lifecycle without exiting the process
 * (SIGUSR1 in-process restart, OPENCLAW_NO_RESPAWN reload, etc.). When the old
 * lifecycle's monitor task is dropped before its `finally` releases the lease,
 * the next lifecycle's `acquireTelegramPollingLease()` sees a stale same-token
 * entry and rejects every Telegram account with the duplicate-poller error.
 *
 * The fix is lifecycle-owned: at the restart boundary the gateway clears every
 * lease this process is holding. We deliberately drop entries even if the
 * abort signal has not yet observed the abort, because by definition the old
 * lifecycle is ending and any still-running poller belongs to it. Late
 * `release()` calls from the dropped tasks are safe — release() is idempotent
 * and owner-checked, so they will not delete a fresh lease acquired by the new
 * lifecycle.
 *
 * Same-token guard within a single lifecycle is unaffected: this function is
 * only called from the in-process restart boundary, never from steady-state
 * acquire/release paths. Two concurrent live pollers within one lifecycle are
 * still rejected by `acquireTelegramPollingLease()`.
 *
 * Issue: openclaw/openclaw#81507
 */
export function releaseTelegramPollingLeasesForLifecycleReset(): number {
  const registry = pollingLeaseRegistry();
  if (registry.size === 0) {
    return 0;
  }
  const entries = Array.from(registry.values());
  registry.clear();
  for (const entry of entries) {
    try {
      entry.resolveDone();
    } catch {
      // resolveDone is safe to call multiple times; ignore.
    }
  }
  return entries.length;
}
