import { createHash, randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { CodexResetClaim } from "./reset-credit-recovery.js";

/**
 * Shared, worker-backed SQLite plugin-state namespace. Do not place this data
 * in per-agent auth JSON files, home directories, or process-local maps.
 */
export const CODEX_RESET_LEDGER_NAMESPACE = "codex-earned-reset-ledger";
export const CODEX_RESET_LEDGER_KEY = "shared";
const WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 90_000;
const MAX_COMPARE_ATTEMPTS = 8;

type AttemptStatus = "pending" | "uncertain" | "restored" | "not-restored" | "not-needed";
type LedgerAttempt = {
  attemptId: string;
  idempotencyKey: string;
  /** Hashed native account identifier; never log tokens or emails. */
  accountHash: string;
  credentialGeneration: string;
  startedAt: number;
  updatedAt: number;
  leaseUntil: number;
  leaseToken: string;
  status: AttemptStatus;
};
type Ledger = {
  version: 1;
  attempts: LedgerAttempt[];
};

export type CodexResetLedgerStore = Pick<
  PluginStateKeyedStore<Ledger, 2>,
  "observe" | "compareAndApply" | "lookup"
>;

export type CodexResetSubject = {
  /** Must come from currently authorized, owner-held account identity. */
  accountId: string;
  /** Non-secret generation digest of the selected credential. */
  credentialGeneration: string;
};

type LedgerDeps = {
  store: CodexResetLedgerStore;
  getSubject: (profileId: string) => Promise<CodexResetSubject>;
  now?: () => number;
  leaseMs?: number;
};

function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex");
}

function isAttempt(value: unknown): value is LedgerAttempt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const a = value as Partial<LedgerAttempt>;
  return (
    typeof a.attemptId === "string" &&
    typeof a.idempotencyKey === "string" &&
    typeof a.accountHash === "string" &&
    typeof a.credentialGeneration === "string" &&
    typeof a.leaseToken === "string" &&
    typeof a.startedAt === "number" &&
    Number.isFinite(a.startedAt) &&
    typeof a.updatedAt === "number" &&
    Number.isFinite(a.updatedAt) &&
    typeof a.leaseUntil === "number" &&
    Number.isFinite(a.leaseUntil) &&
    (a.status === "pending" ||
      a.status === "uncertain" ||
      a.status === "restored" ||
      a.status === "not-restored" ||
      a.status === "not-needed")
  );
}

function readLedger(raw: unknown): Ledger {
  if (raw === undefined) {
    return { version: 1, attempts: [] };
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as Ledger).version !== 1 ||
    !Array.isArray((raw as Ledger).attempts) ||
    !(raw as Ledger).attempts.every(isAttempt)
  ) {
    // A corrupt ledger must never be treated as empty; this would reset the
    // spend cap and erase uncertain attempts.
    throw new Error("Codex reset credit ledger is unreadable");
  }
  return raw as Ledger;
}

function boundedLedger(ledger: Ledger, now: number): Ledger {
  // Never prune unresolved attempts, regardless of age or failed requests.
  return {
    version: 1,
    attempts: ledger.attempts.filter(
      (attempt) =>
        attempt.status === "pending" ||
        attempt.status === "uncertain" ||
        now - attempt.startedAt < WINDOW_MS,
    ),
  };
}

/**
 * Atomic compare-and-apply prevents two independent Gateway workers using the
 * same backing SQLite state from inventing separate consumption keys.
 */
export function createCodexResetCreditLedger(deps: LedgerDeps) {
  const nowFn = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("Invalid Codex earned credit lease duration");
  }
  // Only this instance's owned lease may settle an attempt. A restarted
  // process reclaims the same key with a new lease token.
  const owned = new Map<string, string>();

  const modify = async <T>(
    decide: (ledger: Ledger, now: number) => { value: T; next: Ledger; onCommit?: () => void },
  ): Promise<T> => {
    for (let i = 0; i < MAX_COMPARE_ATTEMPTS; i++) {
      const observed = await deps.store.observe(CODEX_RESET_LEDGER_KEY);
      const now = nowFn();
      const ledger = boundedLedger(readLedger(observed.value), now);
      const decision = decide(ledger, now);
      if (decision.next === ledger) {
        // Fail-closed no-op decisions require no mutation or ownership claim.
        return decision.value;
      }
      const result = await deps.store.compareAndApply(
        CODEX_RESET_LEDGER_KEY,
        observed.comparison,
        { operation: "update", action: "set", value: decision.next },
      );
      if (result.status === "applied") {
        decision.onCommit?.();
        return decision.value;
      }
      if (result.status === "unchanged") {
        // Never grant ownership without evidence the durable claim was written.
        throw new Error("Codex reset ledger write was not committed");
      }
      // On conflict, compare again against the latest committed state.
    }
    throw new Error("Codex reset ledger compare-and-apply contention");
  };

  async function claim(profileId: string, maxPer24Hours: number): Promise<CodexResetClaim> {
    if (!Number.isSafeInteger(maxPer24Hours) || maxPer24Hours < 1 || maxPer24Hours > 10) {
      return { status: "limit" };
    }
    const subject = await deps.getSubject(profileId);
    if (!subject.accountId?.trim() || !subject.credentialGeneration?.trim()) {
      return { status: "uncertain" };
    }
    const account = accountHash(subject.accountId);
    return modify((ledger, now) => {
      const unresolved = ledger.attempts.find(
        (a) => a.status === "pending" || a.status === "uncertain",
      );
      if (unresolved) {
        if (
          unresolved.accountHash !== account ||
          unresolved.credentialGeneration !== subject.credentialGeneration
        ) {
          return {
            value: { status: "uncertain" } as CodexResetClaim,
            next: ledger,
          };
        }
        if (unresolved.leaseUntil > now) {
          return {
            value: {
              status: unresolved.status === "pending" ? "busy" : "uncertain",
            } as CodexResetClaim,
            next: ledger,
          };
        }
        const leaseToken = randomUUID();
        const resumed = {
          ...unresolved,
          status: "pending" as const,
          updatedAt: now,
          leaseUntil: now + leaseMs,
          leaseToken,
        };
        return {
          value: {
            status: "owned",
            attemptId: resumed.attemptId,
            idempotencyKey: resumed.idempotencyKey,
          } as CodexResetClaim,
          next: {
            ...ledger,
            attempts: ledger.attempts.map((a) =>
              a.attemptId === resumed.attemptId ? resumed : a,
            ),
          },
          onCommit: () => owned.set(resumed.attemptId, leaseToken),
        };
      }
      const spendCount = ledger.attempts.filter(
        (a) => a.status !== "not-needed" && now - a.startedAt < WINDOW_MS,
      ).length;
      if (spendCount >= maxPer24Hours) {
        return {
          value: { status: "limit" } as CodexResetClaim,
          next: ledger,
        };
      }
      const attemptId = randomUUID();
      const idempotencyKey = randomUUID();
      const leaseToken = randomUUID();
      const attempt: LedgerAttempt = {
        attemptId,
        idempotencyKey,
        accountHash: account,
        credentialGeneration: subject.credentialGeneration,
        startedAt: now,
        updatedAt: now,
        leaseUntil: now + leaseMs,
        leaseToken,
        status: "pending",
      };
      return {
        value: { status: "owned", attemptId, idempotencyKey } as CodexResetClaim,
        next: { ...ledger, attempts: [...ledger.attempts, attempt] },
        onCommit: () => owned.set(attemptId, leaseToken),
      };
    });
  }

  async function settle(
    _profileId: string,
    attemptId: string,
    status: "restored" | "not-restored" | "uncertain" | "not-needed",
  ): Promise<void> {
    const token = owned.get(attemptId);
    if (!token) {
      throw new Error("Codex earned credit settlement has no owned attempt");
    }
    await modify((ledger, now) => {
      const existing = ledger.attempts.find((a) => a.attemptId === attemptId);
      if (!existing || existing.status !== "pending" || existing.leaseToken !== token) {
        throw new Error("Codex earned credit lease no longer owns this attempt");
      }
      const updated: LedgerAttempt = {
        ...existing,
        status,
        updatedAt: now,
        leaseUntil: status === "uncertain" ? Math.max(existing.leaseUntil, now) : 0,
      };
      return {
        value: undefined,
        next: {
          ...ledger,
          attempts: ledger.attempts.map((a) => a.attemptId === attemptId ? updated : a),
        },
      };
    });
    owned.delete(attemptId);
  }

  async function inspect(): Promise<Ledger> {
    return readLedger(await deps.store.lookup(CODEX_RESET_LEDGER_KEY));
  }

  /**
   * Cross-process waiters observe the durable result rather than acquiring an
   * independent spend claim. The caller MUST recheck authorized account health
   * after "settled"; it is not a credential or replay authorization.
   */
  async function waitForPending(options: {
    timeoutMs: number;
    signal?: AbortSignal;
    pollMs?: number;
  }): Promise<"settled" | "uncertain" | "timeout" | "aborted"> {
    const { timeoutMs, signal } = options;
    const pollMs = options.pollMs ?? 200;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000 ||
      !Number.isSafeInteger(pollMs) ||
      pollMs < 10 ||
      pollMs > 5_000
    ) {
      return "timeout";
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        return "aborted";
      }
      const ledger = await inspect();
      const pending = ledger.attempts.find(
        (a) => a.status === "pending" || a.status === "uncertain",
      );
      if (!pending) {
        return "settled";
      }
      if (pending.status === "uncertain") {
        return "uncertain";
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (timer) {
            clearTimeout(timer);
          }
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        timer = setTimeout(finish, Math.min(pollMs, remaining));
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) {
          finish();
        }
      });
    }
    return signal?.aborted ? "aborted" : "timeout";
  }

  return { claim, settle, inspect, waitForPending };
}
