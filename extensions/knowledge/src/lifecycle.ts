import type { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import { parseDocument } from "yaml";
import { RECORD_MAX_BYTES } from "./limits.js";
import { mergeRedirects, referenceIds } from "./merge.js";
import { Envelope, type LoadedRecord } from "./model.js";
import type { WithdrawInput } from "./mutation-contract.js";
import { digest } from "./scan-primitives.js";

export function assertLifecycleTarget(
  records: LoadedRecord[],
  input: WithdrawInput,
  correcting: boolean,
): LoadedRecord {
  const matches = records.filter((r) => r.id === input.id),
    r = matches.length === 1 ? matches[0] : undefined;
  if (
    !r ||
    (correcting && !r.valid) ||
    r.hash !== input.expectedHash ||
    r.revision !== input.expectedRevision ||
    r.lifecycle === "withdrawn" ||
    (correcting && (r.lifecycle !== "active" || r.kind === "page"))
  ) {
    throw new Error(
      "Lifecycle conflict: target unavailable, changed, invalid, or already inactive. Inspect the exact record and retry with a new request; no publication accepted.",
    );
  }
  return r;
}

/** Preserve authored YAML and content; lifecycle metadata is the only original-record edit.
 * `active` restores a superseded record and drops its `superseded_by`. */
export function lifecycleRecord(
  previous: LoadedRecord,
  lifecycle: "superseded" | "withdrawn" | "active",
  input: Pick<WithdrawInput, "reason" | "requestId">,
  actor: string,
  replacement?: string,
): LoadedRecord {
  const metadata = {
    ...previous.metadata,
    revision: previous.revision + 1,
    updated_at: new Date().toISOString(),
    lifecycle,
    lifecycle_change: {
      reason: input.reason,
      at: new Date().toISOString(),
      actor,
      request_id: input.requestId,
    },
    ...(replacement ? { superseded_by: replacement } : {}),
  };
  if (lifecycle === "active") {
    delete metadata.superseded_by;
  }
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
  const doc = parseDocument(match[1]!);
  for (const key of [
    "revision",
    "updated_at",
    "lifecycle",
    "lifecycle_change",
    ...(metadata.superseded_by ? ["superseded_by"] : []),
  ]) {
    // SAFETY: record metadata is parsed frontmatter, a plain object keyed by field name.
    doc.set(key, (metadata as Record<string, unknown>)[key]);
  }
  if (lifecycle === "active") {
    doc.delete("superseded_by");
  }
  const raw = `---\n${doc.toString()}---\n${previous.body}`;
  if (!Check(Envelope, metadata) || Buffer.byteLength(raw) > RECORD_MAX_BYTES) {
    throw new Error("Lifecycle record exceeds limits or has invalid metadata.");
  }
  return { ...previous, revision: metadata.revision, lifecycle, metadata, raw, hash: digest(raw) };
}

export function lifecycleImpact(records: LoadedRecord[], target: string) {
  const affected = new Set([target]);
  // References to pages merged into the target depend on it as well.
  const redirects = mergeRedirects(records);
  const references = (r: LoadedRecord) =>
    referenceIds(r.metadata).map((id) => redirects.get(id) ?? id);
  // Only deterministic dependencies; never pretend to discover all prose copies.
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of records) {
      if (
        r.valid &&
        r.lifecycle === "active" &&
        !affected.has(r.id) &&
        references(r).some((id) => affected.has(id))
      ) {
        affected.add(r.id);
        changed = true;
      }
    }
  }
  const items = records
    .filter((r) => r.id !== target && affected.has(r.id))
    .map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      direct: references(r).includes(target),
    }));
  return {
    items,
    total: items.length,
    message:
      "Known scoped dependencies need inspection; they were not rewritten or redirected. Current retrieval excludes dependencies on inactive records. Prose copies without explicit dependencies are not exhaustively detected.",
  };
}

/** Durable operational state: unlike indexes, these guards must survive rebuilds/backups. */
export function observeLifecycleGuards(db: DatabaseSync, records: LoadedRecord[], binding: string) {
  for (const r of records) {
    if (r.lifecycle === "withdrawn" || r.lifecycle === "superseded") {
      // Withdrawal dominates supersession, and stale restores cannot replace the first guard.
      db.prepare(
        `INSERT INTO lifecycle_guards_v1 VALUES (?,?,?,?) ON CONFLICT(binding,id) DO UPDATE SET lifecycle=excluded.lifecycle, metadata=excluded.metadata WHERE lifecycle_guards_v1.lifecycle='superseded' AND excluded.lifecycle='withdrawn'`,
      ).run(
        binding,
        r.id,
        r.lifecycle,
        JSON.stringify({
          lifecycle_change: r.metadata.lifecycle_change,
          superseded_by: r.metadata.superseded_by,
        }),
      );
    }
  }
}
/** A journaled restore is the one write that may lift a supersession guard; withdrawal guards stay. */
export function releaseSupersessionGuards(db: DatabaseSync, ids: string[], binding: string) {
  for (const id of ids) {
    db.prepare(
      "DELETE FROM lifecycle_guards_v1 WHERE binding=? AND id=? AND lifecycle='superseded'",
    ).run(binding, id);
  }
}
export function applyLifecycleGuards(db: DatabaseSync, records: LoadedRecord[], binding: string) {
  const guards = new Map(
    db
      .prepare("SELECT id,lifecycle,metadata FROM lifecycle_guards_v1 WHERE binding=?")
      .all(binding)
      .map((r) => [String(r.id), r]),
  );
  const withdrawn = new Set(
    db
      .prepare("SELECT id FROM keyword_withdrawals_v1 WHERE binding=?")
      .all(binding)
      .map((r) => String(r.id)),
  );
  for (const r of records) {
    const guard = guards.get(r.id);
    if (guard) {
      r.lifecycle = String(guard.lifecycle);
      r.metadata = {
        ...r.metadata,
        ...JSON.parse(String(guard.metadata)),
        // SAFETY: lifecycle guards store only the withdrawn and superseded Envelope lifecycles.
        lifecycle: r.lifecycle as Envelope["lifecycle"],
      };
    }
    if (withdrawn.has(r.id)) {
      r.lifecycle = "withdrawn";
      r.metadata = { ...r.metadata, lifecycle: "withdrawn" };
    }
  }
}
