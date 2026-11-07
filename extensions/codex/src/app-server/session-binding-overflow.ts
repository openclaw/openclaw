/** Overflow recovery for Codex app-server binding state (#125910). */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  bindingStoreKey,
  readStoredCodexAppServerBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";
import type { CodexAppServerBindingStore, CodexBindingAuthority } from "./session-binding.js";

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

// All four capabilities are required: bundled plugins target the current
// host, which always carries the paging + CAS + authority-bound-writer
// contract (extensions/AGENTS.md), so there is no partial-capability stand
// down to support.
export type CodexBindingOverflowRecoveryState = Required<
  Pick<
    PluginStateKeyedStore<StoredCodexAppServerBinding>,
    "compareAndApply" | "entriesInKeyRange" | "observe" | "withCurrent"
  >
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
  // Task-import receipts are durable by design: clear, reset, and lease
  // release all retain the marker without expiry, and Doctor consults it to
  // avoid re-importing an already handled legacy task. Any marker shape,
  // including an unknown version, keeps the row.
  if (raw.nativeSubagentTaskImport !== undefined) {
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
  const entriesInKeyRange = recovery.entriesInKeyRange.bind(recovery);
  const observe = recovery.observe.bind(recovery);
  const withCurrent = recovery.withCurrent.bind(recovery);
  // Lexical position of the last examined row; undefined scans from the start.
  // Persisted across calls, so spaced failures keep advancing instead of
  // re-reading the same protected prefix every time.
  let cursor: string | undefined;
  const evictDisposableBindingRows = async (
    insertKey: string,
    assertCurrent: (() => void) | undefined,
    authority: CodexBindingAuthority | undefined,
  ): Promise<number> => {
    // Prepared on the first delete, not at sweep start: preparation itself
    // asserts caller authority, and a pass that sheds nothing must not pay
    // for it. The prepared session-entry restrictions then ride into the
    // worker's write admission, so a delete is fenced on the same checks the
    // caller's own mutation would carry.
    let deleteWriter: ReturnType<typeof withCurrent> | undefined;
    let deleteWriterPrepared = false;
    const recoveryWriter = async () => {
      if (!deleteWriterPrepared) {
        deleteWriterPrepared = true;
        if (authority) {
          const prepared = await authority.prepareMutation();
          deleteWriter = withCurrent({
            assertCurrent: () => {
              assertCurrent?.();
              prepared.assertCurrent();
            },
            ...(prepared.sessionEntryCurrent
              ? { sessionEntryCurrent: prepared.sessionEntryCurrent }
              : {}),
          });
        } else if (assertCurrent) {
          deleteWriter = withCurrent({ assertCurrent });
        }
      }
      return deleteWriter;
    };
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
        // A delete only ever runs under the caller's authority: with neither
        // an assertCurrent closure nor a prepared authority, recovery sheds
        // nothing and the row-limit error propagates. Plugin-runtime liveness
        // alone does not authorize deleting a shared row for a caller.
        const writer = await recoveryWriter();
        if (!writer) {
          continue;
        }
        const result = await writer.compareAndApply(entry.key, observation.comparison, {
          operation: "delete",
          action: "delete",
        });
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
    authority,
  ) => {
    let evictions = 0;
    while (true) {
      try {
        // The fourth argument carries prepared session lineage into the
        // worker's admission checks; dropping it here would strip those
        // checks from every mutation whenever recovery is enabled.
        return await store.mutate(identity, mutation, assertCurrent, authority);
      } catch (error) {
        if (!isCodexBindingRowLimitError(error) || evictions >= bounds.evictionAttempts) {
          throw error;
        }
        // The failed insert owns no row yet, so the sweep skips nothing by
        // key; the skip only guards a concurrent insert claiming it mid-retry.
        if (
          (await evictDisposableBindingRows(
            bindingStoreKey(identity),
            assertCurrent,
            authority,
          )) === 0
        ) {
          throw error;
        }
        evictions += 1;
      }
    }
  };
  // Lease admission is the other insert path: a fresh session's withLease
  // writes its cleared lease row before the thread-start callback can reach
  // mutate, so at capacity the failure surfaces here first. Retry only while
  // the caller's work has not started — once `run` executes, re-entering
  // withLease would double-start the session.
  const guardedWithLease: CodexAppServerBindingStore["withLease"] = async (
    identity,
    run,
    options,
  ) => {
    let evictions = 0;
    let runStarted = false;
    const guardedRun = async () => {
      runStarted = true;
      return await run();
    };
    while (true) {
      try {
        return await store.withLease(identity, guardedRun, options);
      } catch (error) {
        if (
          runStarted ||
          !isCodexBindingRowLimitError(error) ||
          evictions >= bounds.evictionAttempts
        ) {
          throw error;
        }
        if (
          (await evictDisposableBindingRows(
            bindingStoreKey(identity),
            options?.assertCurrent,
            options?.authority,
          )) === 0
        ) {
          throw error;
        }
        evictions += 1;
      }
    }
  };
  return { ...store, mutate: guardedMutate, withLease: guardedWithLease };
}
