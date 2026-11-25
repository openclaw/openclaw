import { Check } from "typebox/value";
import { parseDocument } from "yaml";
import { parseYaml } from "./files.js";
import { RECORD_MAX_BYTES } from "./limits.js";
import { Envelope, type Evidence, type LoadedRecord, type MergedFrom } from "./model.js";
import { digest } from "./vault.js";

/** What a merge or unmerge changed on the surviving page, reported in its receipt. */
export type MergeReport = {
  survivorId: string;
  absorbedId: string;
  aliases: string[];
  fieldConflicts: string[];
  redirectedRecords: number;
};
type Change = { reason: string; requestId: string; actor: string; at: string };

const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
const evidenceKey = (e: Pick<Evidence, "path" | "sha256" | "start_line" | "end_line">) =>
  JSON.stringify([e.path, e.sha256, e.start_line ?? null, e.end_line ?? null]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Apply frontmatter changes, preserving authored YAML order, comments and unrelated keys. */
function rewriteRecord(
  previous: LoadedRecord,
  set: Partial<Envelope>,
  remove: (keyof Envelope)[] = [],
  body = previous.body,
): LoadedRecord {
  const metadata: Envelope = { ...previous.metadata, ...set };
  for (const key of remove) {
    delete metadata[key];
  }
  const doc = parseDocument(/^(?:﻿)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)![1]!);
  for (const [key, value] of Object.entries(set)) {
    doc.set(key, doc.createNode(value, { aliasDuplicateObjects: false }));
  }
  for (const key of remove) {
    doc.delete(key);
  }
  parseYaml(doc.toString());
  const raw = `---\n${doc.toString()}---\n${body}`;
  if (!Check(Envelope, metadata) || Buffer.byteLength(raw) > RECORD_MAX_BYTES) {
    throw new Error(
      "Merged page exceeds record limits or has invalid metadata. No publication accepted.",
    );
  }
  return {
    ...previous,
    title: metadata.title,
    lifecycle: metadata.lifecycle,
    revision: metadata.revision,
    metadata,
    body,
    raw,
    hash: digest(raw),
  };
}

/** Plan a merge: the survivor gains the absorbed page's names, tags, missing fields and evidence;
 * the absorbed page becomes `merged` and points at the survivor. Bodies are never combined. */
export function planMerge(
  survivor: LoadedRecord,
  absorbed: LoadedRecord,
  input: { title?: string; body?: string; evidence?: Evidence[] },
  change: Change,
) {
  const s = survivor.metadata,
    a = absorbed.metadata,
    title = input.title ?? survivor.title;
  // Names: the absorbed title and aliases, and the survivor's old title when the merge renames it.
  const existing = (s.aliases ?? []).filter((alias) => normalize(alias) !== normalize(title));
  const known = new Set([normalize(title), ...existing.map(normalize)]);
  const aliases: string[] = [];
  for (const name of [
    absorbed.title,
    ...(a.aliases ?? []),
    ...(title !== survivor.title ? [survivor.title] : []),
  ]) {
    if (!known.has(normalize(name))) {
      known.add(normalize(name));
      aliases.push(name);
    }
  }
  if (existing.length + aliases.length > 100) {
    throw new Error(
      "The merged page would have more than 100 aliases. Remove some aliases from one page first. No publication accepted.",
    );
  }
  const tags = (a.tags ?? []).filter((tag) => !(s.tags ?? []).includes(tag));
  // Fields: the survivor's values win; keys only the absorbed page has are copied.
  const fields = Object.keys(a.fields ?? {}).filter((key) => !Object.hasOwn(s.fields ?? {}, key));
  const fieldConflicts = Object.keys(a.fields ?? {}).filter(
    (key) => Object.hasOwn(s.fields ?? {}, key) && !same(s.fields![key], a.fields![key]),
  );
  const seen = new Set((s.evidence ?? []).map(evidenceKey)),
    evidence: Evidence[] = [];
  for (const e of [...(a.evidence ?? []), ...(input.evidence ?? [])]) {
    if (!seen.has(evidenceKey(e))) {
      seen.add(evidenceKey(e));
      evidence.push(e);
    }
  }
  const entry: MergedFrom = {
    id: absorbed.id,
    request_id: change.requestId,
    at: change.at,
    added: {
      aliases,
      tags,
      fields,
      evidence: evidence.map(({ path, sha256, start_line, end_line }) => ({
        path,
        sha256,
        ...(start_line ? { start_line } : {}),
        ...(end_line ? { end_line } : {}),
      })),
    },
  };
  const survivorSet: Partial<Envelope> = {
    revision: survivor.revision + 1,
    updated_at: change.at,
    merged_from: [...(s.merged_from ?? []), entry],
    ...(title !== survivor.title ? { title } : {}),
    ...(aliases.length || existing.length !== (s.aliases ?? []).length
      ? { aliases: [...existing, ...aliases] }
      : {}),
    ...(tags.length ? { tags: [...(s.tags ?? []), ...tags] } : {}),
    ...(fields.length
      ? {
          fields: {
            ...s.fields,
            ...Object.fromEntries(fields.map((key) => [key, a.fields![key]])),
          },
        }
      : {}),
    ...(evidence.length ? { evidence: [...(s.evidence ?? []), ...evidence] } : {}),
  };
  return {
    survivor: rewriteRecord(survivor, survivorSet, [], input.body ?? survivor.body),
    absorbed: rewriteRecord(absorbed, {
      revision: absorbed.revision + 1,
      updated_at: change.at,
      lifecycle: "merged",
      merged_into: survivor.id,
      lifecycle_change: {
        reason: change.reason,
        at: change.at,
        actor: change.actor,
        request_id: change.requestId,
      },
    }),
    aliases,
    fieldConflicts,
  };
}

/** Plan an unmerge: remove what the merge added to the survivor (unless since edited) and make
 * the merged page active again. The survivor's title and body are left as they are now. */
export function planUnmerge(survivor: LoadedRecord, merged: LoadedRecord, change: Change) {
  const s = survivor.metadata,
    entry = s.merged_from?.find((e) => e.id === merged.id);
  if (!entry) {
    throw new Error(
      `${survivor.title} has no merge record for ${merged.id}. No publication accepted.`,
    );
  }
  const aliases = (s.aliases ?? []).filter((alias) => !entry.added.aliases.includes(alias));
  const tags = (s.tags ?? []).filter((tag) => !entry.added.tags.includes(tag));
  // A copied field the survivor has since changed now belongs to the survivor.
  const fields = Object.fromEntries(
    Object.entries(s.fields ?? {}).filter(
      ([key, value]) =>
        !entry.added.fields.includes(key) || !same(value, merged.metadata.fields?.[key]),
    ),
  );
  const added = new Set(entry.added.evidence.map(evidenceKey));
  const evidence = (s.evidence ?? []).filter((e) => !added.has(evidenceKey(e)));
  const rest = (s.merged_from ?? []).filter((e) => e.id !== merged.id);
  const survivorSet: Partial<Envelope> = {
    revision: survivor.revision + 1,
    updated_at: change.at,
    ...(s.aliases ? { aliases } : {}),
    ...(s.tags ? { tags } : {}),
    ...(s.fields ? { fields } : {}),
    ...(s.evidence ? { evidence } : {}),
    ...(rest.length ? { merged_from: rest } : {}),
  };
  return {
    survivor: rewriteRecord(survivor, survivorSet, rest.length ? [] : ["merged_from"]),
    absorbed: rewriteRecord(
      merged,
      {
        revision: merged.revision + 1,
        updated_at: change.at,
        lifecycle: "active",
        lifecycle_change: {
          reason: change.reason,
          at: change.at,
          actor: change.actor,
          request_id: change.requestId,
        },
      },
      ["merged_into"],
    ),
    aliases: (s.aliases ?? []).filter((alias) => entry.added.aliases.includes(alias)),
  };
}
