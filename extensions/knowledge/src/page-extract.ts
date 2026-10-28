import path from "node:path";
import { parseDocument } from "yaml";
import { resolveLinks } from "./markdown-links.js";
import type { linkTargets } from "./merge.js";
import type { Evidence, LoadedRecord } from "./model.js";
import { pageMentions } from "./page-budget.js";
import { digest } from "./vault.js";

type Targets = ReturnType<typeof linkTargets>;
const resolvedIds = (body: string, at: string, targets: Targets) =>
  new Map(
    resolveLinks(
      { id: "extract", title: "", path: at, body, metadata: {} },
      targets.candidates,
      targets.canonical,
    ).flatMap((link) => (link.id ? [[link.href, link.id] as const] : [])),
  );

/** Distinct records the body's links resolve to when authored at `at`. */
export const linkedIds = (body: string, at: string, targets: Targets) =>
  new Set(resolvedIds(body, at, targets).values());

/**
 * Move section text from one record path to another without changing where its
 * links lead. Relative Markdown links are rewritten for the new directory; any
 * other link that would resolve differently rejects the extraction.
 */
export function carryLinks(text: string, from: string, to: string, targets: Targets) {
  const original = resolvedIds(text, from, targets);
  let carried = text;
  const moved = resolvedIds(text, to, targets);
  for (const [href, id] of original) {
    const target = targets.candidates.find((r) => r.id === id);
    if (moved.get(href) === id || href.startsWith("#wiki=") || !target) {
      continue;
    }
    const hash = href.indexOf("#"),
      fragment = hash === -1 ? "" : href.slice(hash);
    const relative = path.posix.relative(path.posix.dirname(to), target.path) + fragment;
    for (const end of [")", " "]) {
      carried = carried.split(`](${href}${end}`).join(`](${relative}${end}`);
    }
  }
  const before = new Set(original.values()),
    after = resolvedIds(carried, to, targets);
  const changed = [...original].filter(([, id]) => ![...after.values()].includes(id));
  if (changed.length || [...after.values()].some((id) => !before.has(id))) {
    throw new Error(
      `Section links would point elsewhere on the destination: ${changed
        .map(([href]) => (href.startsWith("#wiki=") ? decodeURIComponent(href.slice(6)) : href))
        .join(", ")}. Link those records by ID ([[id|label]]) first. No publication accepted.`,
    );
  }
  return { text: carried, linked: before };
}

/** Source-page citations the section itself names by quote, retained path or filename. */
export function sectionEvidence(page: LoadedRecord, section: string): Evidence[] {
  return (page.metadata.evidence ?? []).filter(
    (e) =>
      (e.quote && section.includes(e.quote)) ||
      section.includes(e.path) ||
      (e.filename && e.filename.length >= 5 && section.includes(e.filename)),
  );
}

export const sameCitation = (a: Evidence, b: Evidence) =>
  a.path === b.path &&
  a.sha256 === b.sha256 &&
  a.start_line === b.start_line &&
  a.end_line === b.end_line &&
  a.quote === b.quote;

/** A claim revision whose entities move from the source page to the destination. */
export function relinkClaim(
  claim: LoadedRecord,
  source: LoadedRecord,
  destinationId: string,
  change: { reason: string; actor: string; requestId: string; at: string },
): LoadedRecord {
  const entities = [
    destinationId,
    ...(claim.metadata.entities ?? []).filter((e) => e !== source.id && e !== destinationId),
    // The source stays a secondary subject only when the claim itself names it.
    ...(pageMentions(`${claim.title}\n${claim.body}`, source) ? [source.id] : []),
  ];
  const revision = claim.revision + 1;
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(claim.raw)!;
  const doc = parseDocument(match[1]!);
  doc.set("revision", revision);
  doc.set("updated_at", change.at);
  doc.set("entities", doc.createNode(entities));
  doc.set("annotation_change", {
    reason: change.reason,
    actor: change.actor,
    request_id: change.requestId,
    at: change.at,
  });
  const raw = `---\n${doc.toString()}---\n${claim.body}`;
  return {
    ...claim,
    revision,
    metadata: { ...claim.metadata, entities, revision, updated_at: change.at },
    raw,
    hash: digest(raw),
  };
}
