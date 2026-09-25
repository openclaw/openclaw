/** Overflow recovery for Codex app-server binding state (#125910). */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  bindingStoreKey,
  readStoredCodexAppServerBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";

// Overflow retries per insert. Each retry means a just-freed row was claimed
// by a racing insert; past a few, fail with the limit error instead of
// evicting rows in an unbounded loop.
const BINDING_INSERT_EVICTION_ATTEMPTS = 4;
// One recovery call scans at most this many storage-side pages, so a full
// namespace never turns into unbounded Gateway-thread work per failure.
const BINDING_OVERFLOW_PAGES_PER_CALL = 4;
// Rows per page. Listing, ordering, and JSON decoding happen in the storage
// worker; the caller's thread only sees the materialized page.
const BINDING_OVERFLOW_PAGE_LIMIT = 512;
// One capacity failure sheds up to this many disposable rows, so one scan
// pays off across many inserts instead of one row per failure.
const BINDING_OVERFLOW_SHED_PER_CALL = 8;

export type CodexBindingOverflowRecoveryBounds = {
  evictionAttempts: number;
  pageLimit: number;
  pagesPerCall: number;
  shedPerCall: number;
};

const DEFAULT_RECOVERY_BOUNDS: CodexBindingOverflowRecoveryBounds = {
  evictionAttempts: BINDING_INSERT_EVICTION_ATTEMPTS,
  pageLimit: BINDING_OVERFLOW_PAGE_LIMIT,
  pagesPerCall: BINDING_OVERFLOW_PAGES_PER_CALL,
  shedPerCall: BINDING_OVERFLOW_SHED_PER_CALL,
};

export type CodexBindingOverflowRecoveryState = Pick<
  PluginStateKeyedStore<StoredCodexAppServerBinding>,
  "compareAndApply" | "entriesInKeyRange" | "observe" | "withCurrent"
>;

// A full namespace must not hard-fail every new session. Only row-count
// overflows free a row on retry: the same code also covers value-size
// rejects, which no eviction can fix.
function isCodexBindingRowLimitError(error: unknown): boolean {
  return (
    // SAFETY: probing an unknown thrown value; absent code reads as undefined.
    (error as { code?: unknown }).code === "PLUGIN_STATE_LIMIT_EXCEEDED" &&
    error instanceof Error &&
    error.message.includes("row limit")
  );
}

// Destructive eligibility is decided on the raw record, not the tolerant
// codec: readStoredCodexAppServerBinding catches a malformed lease or
// retirement marker to undefined, which would make an ambiguous row look
// unprotected. Anything uncertain is preserved.
function readRawLeaseProtection(
  value: unknown,
): { kind: "none" } | { kind: "valid"; expiresAt: number } | { kind: "ambiguous" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "ambiguous" };
  }
  // SAFETY: the object guard above proves the record shape for the field read.
  const raw = (value as Record<string, unknown>).lease;
  if (raw === undefined) {
    return { kind: "none" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "ambiguous" };
  }
  // SAFETY: both fields are re-validated with typeof checks right after this.
  const { token, expiresAt } = raw as { token?: unknown; expiresAt?: unknown };
  if (typeof token !== "string" || !token.trim()) {
    return { kind: "ambiguous" };
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return { kind: "ambiguous" };
  }
  return { kind: "valid", expiresAt };
}

// Only an abandoned cleared row may be shed for an insert. Retirement fences,
// legacy-clear provenance, live leases, active bindings, and any row whose raw
// protection fields do not parse cleanly are never candidates; without those
// exclusions a sweep could reopen native authority for stale owners.
function isDisposableBindingRow(
  key: string,
  value: unknown,
  stored: StoredCodexAppServerBinding,
  now: number,
): boolean {
  if (
    stored.state !== "cleared" ||
    stored.retired === true ||
    key.startsWith("conversation:legacy-")
  ) {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // SAFETY: the object guard above proves the record shape for the field read.
  const raw = value as Record<string, unknown>;
  // A retirement marker in any shape is a fence, not garbage.
  if (raw.retired !== undefined) {
    return false;
  }
  const lease = readRawLeaseProtection(value);
  return lease.kind === "none" || (lease.kind === "valid" && lease.expiresAt <= now);
}

/**
 * Adds bounded capacity recovery to the binding store's insert path. Listing
 * and deletion run through the async worker-backed handle, so a full namespace
 * never parks the Gateway thread on a whole-table decode; each failure scans
 * at most a few storage-side pages. Rows are re-validated at delete time via
 * observe + compareAndApply, so a row that gained a lease or a fence between
 * the page read and the delete is preserved.
 */
export function withCodexBindingOverflowRecovery(
  store: CodexAppServerBindingStore,
  recovery: CodexBindingOverflowRecoveryState,
  overrides: Partial<CodexBindingOverflowRecoveryBounds> = {},
): CodexAppServerBindingStore {
  const bounds = { ...DEFAULT_RECOVERY_BOUNDS, ...overrides };
  const entriesInKeyRange = recovery.entriesInKeyRange?.bind(recovery);
  const observe = recovery.observe?.bind(recovery);
  const compareAndApply = recovery.compareAndApply?.bind(recovery);
  const withCurrent = recovery.withCurrent?.bind(recovery);
  if (!entriesInKeyRange || !observe || !compareAndApply || !withCurrent) {
    // Hosts without ranged listing, row CAS, or authority-bound writes get
    // the pre-recovery behavior: the row-limit error propagates instead of a
    // full-table scan or an unfenced delete.
    return store;
  }
  // Lexical position of the last examined row; undefined scans from the start.
  // Persisted across calls, so spaced failures keep advancing instead of
  // re-reading the same protected prefix every time.
  let cursor: string | undefined;
  const evictDisposableBindingRows = async (
    insertKey: string,
    assertCurrent: (() => void) | undefined,
  ): Promise<number> => {
    const now = Date.now();
    let shed = 0;
    let pages = 0;
    const startedFromBeginning = cursor === undefined;
    while (shed < bounds.shedPerCall && pages < bounds.pagesPerCall) {
      const page = await entriesInKeyRange({
        keyStartInclusive: cursor ?? "",
        keyEndExclusive: "\uffff",
        limit: bounds.pageLimit,
        order: "asc",
      });
      pages += 1;
      if (page.length === 0) {
        if (startedFromBeginning) {
          break;
        }
        // The cursor passed the last key; restart the pass from the beginning.
        cursor = undefined;
        continue;
      }
      // Shed oldest first within the page, the store's own eviction courtesy.
      // The cursor still tracks lexical page order, not this candidate order.
      const candidates = page.toSorted(
        (a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
      for (const entry of candidates) {
        if (shed >= bounds.shedPerCall) {
          break;
        }
        if (entry.key === insertKey) {
          continue;
        }
        const stored = readStoredCodexAppServerBinding(entry.value);
        if (!stored || !isDisposableBindingRow(entry.key, entry.value, stored, now)) {
          continue;
        }
        const observation = await observe(entry.key);
        const current = observation.value;
        const currentStored =
          current === undefined ? undefined : readStoredCodexAppServerBinding(current);
        if (
          current === undefined ||
          !currentStored ||
          !isDisposableBindingRow(entry.key, current, currentStored, now)
        ) {
          continue;
        }
        // Recovery ran awaited work since the failed insert, so the caller may
        // hold no authority anymore. Row CAS proves the row is unchanged but
        // says nothing about the caller: fence every delete on live authority,
        // locally before dispatch and again at the worker's write admission.
        assertCurrent?.();
        const writer = assertCurrent ? withCurrent({ assertCurrent }) : undefined;
        const result = await (writer?.compareAndApply ?? compareAndApply)(
          entry.key,
          observation.comparison,
          {
            operation: "delete",
            action: "delete",
          },
        );
        if (result.status === "applied") {
          shed += 1;
        }
      }
      if (page.length < bounds.pageLimit) {
        // End of the namespace: the pass is complete, so the next call scans
        // from the start; rows examined earlier can turn disposable once their
        // leases lapse. Keep scanning this call only if it started mid-table.
        cursor = undefined;
        if (startedFromBeginning) {
          break;
        }
        continue;
      }
      cursor = page.at(-1)?.key;
    }
    return shed;
  };
  const guardedMutate: CodexAppServerBindingStore["mutate"] = async (
    identity,
    mutation,
    assertCurrent,
  ) => {
    let evictions = 0;
    while (true) {
      try {
        return await store.mutate(identity, mutation, assertCurrent);
      } catch (error) {
        if (!isCodexBindingRowLimitError(error) || evictions >= bounds.evictionAttempts) {
          throw error;
        }
        // The failed insert owns no row yet, so the sweep skips nothing by
        // key; the skip only guards a concurrent insert claiming it mid-retry.
        if ((await evictDisposableBindingRows(bindingStoreKey(identity), assertCurrent)) === 0) {
          throw error;
        }
        evictions += 1;
      }
    }
  };
  return { ...store, mutate: guardedMutate };
}
