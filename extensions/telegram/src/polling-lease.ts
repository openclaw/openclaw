import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const TELEGRAM_POLLING_LEASES_KEY = Symbol.for("openclaw.telegram.pollingLeases");
const DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS = 5_000;

type TelegramPollingLeaseEntry = {
  accountId: string;
  abortSignal?: AbortSignal;
  done: Promise<void>;
  resolveDone: () => void;
  startedAt: number;
};

type TelegramPollingLeaseRegistry = Map<string, TelegramPollingLeaseEntry>;

type TelegramPollingLease = {
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

  return await raceWithTimeout(
    params.done.then(() => "released" as const),
    resolveTimerTimeoutMs(params.waitMs, DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS, 0),
    (): WaitForPreviousResult => "timeout",
    { ref: false, signal: params.signal, onAbort: () => "aborted" },
  );
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
      break;
    }

    if (!existing.abortSignal?.aborted) {
      const ageMs = Math.max(0, Date.now() - existing.startedAt);
      const ageSeconds = Math.round(ageMs / 1000);
      throw new Error(
        `Telegram polling already active for bot token ${fingerprint} on account "${existing.accountId}" (${ageSeconds}s old); refusing duplicate poller for account "${opts.accountId}". Stop the existing OpenClaw gateway/poller or use a different bot token.`,
      );
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

    if (registry.get(fingerprint) !== existing || waitResult === "released") {
      continue;
    }

    replacedStoppingPrevious = true;
    break;
  }
  const { promise: done, resolve: resolveDone } = createDeferred<void>();
  const entry: TelegramPollingLeaseEntry = {
    accountId: opts.accountId,
    abortSignal: opts.abortSignal,
    done,
    resolveDone,
    startedAt: Date.now(),
  };
  registry.set(fingerprint, entry);

  return {
    tokenFingerprint: fingerprint,
    waitedForPrevious,
    replacedStoppingPrevious,
    release: () => {
      const current = registry.get(fingerprint);
      if (current === entry) {
        registry.delete(fingerprint);
      }
      resolveDone();
    },
  };
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
