const content = `type CodeModeResultReference = {
  id: string;
  bytes: number;
  /** Array length, object key count, or 1 for a scalar. */
  count: number;
  /** Observed, bounded sample shapes and nested array counts; not a schema. */
  shape: string;
  /** Small values: JSON. Larger values: a sampled view with array paths/counts/items
   * and compact envelope fields. May be a JSON prefix; never substitute it for full data. */
  preview: string;
  previewTruncated: boolean;
};
/** Up to 64 references share min(memoryLimitBytes, maxSnapshotBytes) encoded JSON
 * bytes (10 MiB by default), separately from the cell inbox. Full stores reject
 * saves without evicting entries. References survive cells and wait, but expire
 * when the current reply ends, or on abort, catalog replacement, permission
 * changes, or restart. Never reuse reference ids from earlier turns; use store
 * for small JSON values needed later.
 * Saved data is a snapshot, not current external state. Result operations are
 * unavailable in restartSafe cells because references are transient.
 * Oversized final objects/arrays are saved automatically in interactive exec/wait
 * when possible: value is {truncated:true, reference:CodeModeResultReference, guidance:string}.
 * Failed retention stays completed with a truncation marker explaining why it was not retained.
 * No automatic references in headless or restartSafe execution.
 * Array discovery visits at most 128 nodes, 5 levels, and 16 object keys per node;
 * arrays sample first/middle/last, with the 8 largest discovered arrays shown first.
 * Sample values visit 2 levels/6 fields, with bounded text. A descriptor is at most
 * 768 encoded JSON bytes, and display fitting can shorten shape/preview further.
 */
declare const results: {
  /** Save normalized JSON for later cells in this reply. Returns the descriptor above: emit it directly;
   * its preview, shape, and count are already prepared. The full JSON stays stored.
   * Example: return await results.save(await tool({}));
   */
  save(value: unknown): Promise<CodeModeResultReference>;
  /** Read a detached JSON copy. Inspect the saved preview before using unknown fields. */
  load(id: string): Promise<unknown>;
  /** Free capacity. Missing or expired references reject. */
  delete(id: string): Promise<boolean>;
};
/** Keep a small JSON value across cells and turns in this session, including restarts.
 * Keys must be non-empty strings of at most 256 characters (otherwise TypeError).
 * Values use normal bridge JSON normalization. undefined deletes the key.
 * Encoded JSON limits: 256 KiB per value, 1 MiB total; RangeError leaves the store unchanged.
 * Writes are visible within this cell, including wait, but persist only on completed.
 * Failed, timed-out, aborted, expired, or disposed cells discard their writes.
 * A persistence failure leaves the cell completed with a warning and the run projection unchanged;
 * verify the transcript before relying on the write, since its durable outcome may be uncertain.
 * Available only in interactive cells bound to a session, never headless or restartSafe cells.
 */
declare function store(key: string, value: unknown): Promise<void>;
/** Read a detached JSON copy, or undefined when missing, including this cell's pending writes.
 * Uses the same key and availability rules as store. Network-content provenance is preserved.
 */
declare function load(key: string): Promise<unknown>;`;

export const CODE_MODE_RESULTS_API_FILE = {
  path: "results.d.ts",
  description: "Temporary results for this reply and small JSON values persisted in this session.",
  bytes: Buffer.byteLength(content, "utf8"),
  content,
};
