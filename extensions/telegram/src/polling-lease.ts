// Telegram plugin module implements polling lease behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
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

type ReleaseStoppedTelegramPollingLeaseOpts = {
  token: string;
  accountId: string;
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

function isLeaseStale(entry: TelegramPollingLeaseEntry): boolean {
  // Dynamic staleness threshold: consider a lease stale if it's been
  // aborting for more than 2x the typical wait time (10s default).
  // This accounts for network timeouts and graceful shutdown delays.
  const STALE_LEASE_THRESHOLD_MS = 2 * DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS;
  const ageMs = Date.now() - entry.startedAt;
  return entry.abortSignal?.aborted && ageMs > STALE_LEASE_THRESHOLD_MS;
}

function createDuplicatePollingError(params: {
  accountId: string;
  existing: TelegramPollingLeaseEntry;
  tokenFingerprint: string;
}): Error {
  const ageMs = Math.max(0, Date.now() - params.existing.startedAt);
  const ageSeconds = Math.round(ageMs / 1000);
  const staleInfo = params.existing.abortSignal?.aborted ? ` (aborting for ${ageSeconds}s)` : "";
  return new Error(
    `Telegram polling already active for bot token ${params.tokenFingerprint} on account "${params.existing.accountId}" (${ageSeconds}s${staleInfo}); refusing duplicate poller for account "${params.accountId}". Stop the existing OpenClaw gateway/poller or use a different bot token.`,
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
  if (params.waitMs <= 0) {
    return "timeout";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const waitMs = resolveTimerTimeoutMs(params.waitMs, DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS, 0);
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
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
  let replacedStoppingPrevious = false;

  for (;;) {
    const existing = registry.get(fingerprint);
    if (!existing) {
      return createLease({
        accountId: opts.accountId,
        abortSignal: opts.abortSignal,
        registry,
        tokenFingerprint: fingerprint,
        waitedForPrevious,
        replacedStoppingPrevious,
      });
    }

    // Check if the existing lease is stale (aborting for too long)
    if (isLeaseStale(existing)) {
      console.log(
        `[telegram-lease] Replacing stale lease for ${fingerprint} (aborting for ${Math.round((Date.now() - existing.startedAt) / 1000)}s)`,
      );
      registry.delete(fingerprint);
      existing.resolveDone();
      replacedStoppingPrevious = true;
      continue;
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

export async function releaseStoppedTelegramPollingLease(
  opts: ReleaseStoppedTelegramPollingLeaseOpts,
): Promise<boolean> {
  const registry = pollingLeaseRegistry();
  const fingerprint = fingerprintTelegramBotToken(opts.token);
  const existing = registry.get(fingerprint);
  if (!existing || existing.accountId !== opts.accountId) {
    return false;
  }

  if (!existing.abortSignal?.aborted) {
    return false;
  }

  const waitResult = await waitForPreviousRelease({
    done: existing.done,
    waitMs: opts.waitMs ?? DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS,
  });
  if (waitResult === "released" || registry.get(fingerprint) !== existing) {
    return false;
  }

  registry.delete(fingerprint);
  existing.resolveDone();
  return true;
}

export function resetTelegramPollingLeasesForTests(): void {
  pollingLeaseRegistry().clear();
}
