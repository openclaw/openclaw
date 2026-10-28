import path from "node:path";
import { parseDocument } from "yaml";
import { linkSpans, resolveLinkHref, type LinkSpan } from "./markdown-links.js";
import type { linkTargets } from "./merge.js";
import type { Evidence, LoadedRecord } from "./model.js";
import { digest } from "./vault.js";

type Targets = ReturnType<typeof linkTargets>;
export type DocumentLink = LinkSpan & { id?: string; key: string };

/** Every link of one complete body, in document order, and where it leads from path `at`. */
const documentLinks = (body: string, at: string, targets: Targets): DocumentLink[] =>
  linkSpans(body).map((link) => {
    const to = resolveLinkHref(link.href, at, targets.candidates, targets.canonical);
    return Object.assign(link, {
      id: to?.id,
      key: to?.id ? `id:${to.id}` : `${to?.status ?? "external"}:${link.href}`,
    });
  });

/** Where each link starting in [start, end) leads, in order. */
const linkKeys = (links: DocumentLink[], start: number, end = Infinity) =>
  links.filter((l) => l.start >= start && l.start < end).map((l) => l.key);

/**
 * Section text for another record path, with the section's links as the complete source
 * reads them. Inline relative links are rewritten for the new directory inside their parsed
 * spans only, so code, escapes and every other byte stay as written. The caller verifies the
 * links in the complete destination; anything else that would lead elsewhere rejects there.
 */
export function carryLinks(
  body: string,
  section: { start: number; end: number },
  from: string,
  to: string,
  targets: Targets,
) {
  const links = documentLinks(body, from, targets).filter(
    (l) => l.start >= section.start && l.start < section.end,
  );
  let text = body.slice(section.start, section.end);
  // Last link first, so earlier offsets stay valid.
  for (const link of links.toReversed()) {
    const target = link.id ? targets.candidates.find((r) => r.id === link.id) : undefined;
    const destination =
      target && link.inline && link.verbatim
        ? /^(\s*)(<[^<>\n]*>|\S+)([\s\S]*)$/.exec(link.raw.slice(link.label.length + 3, -1))
        : undefined;
    if (
      !target ||
      !destination ||
      resolveLinkHref(link.href, to, targets.candidates, targets.canonical)?.id === link.id
    ) {
      continue;
    }
    const authored = destination[2]!,
      hash = authored.indexOf("#");
    let href =
      path.posix.relative(path.posix.dirname(to), target.path) +
      (hash === -1 ? "" : authored.slice(hash).replace(/>$/, ""));
    if (authored.startsWith("<") || /[\s()<>]/.test(href)) {
      href = `<${href}>`;
    }
    const at = link.start - section.start;
    text =
      text.slice(0, at) +
      `[${link.label}](${destination[1]}${href}${destination[3]})` +
      text.slice(at + link.raw.length);
  }
  return { text, links, linked: new Set(links.flatMap((l) => (l.id ? [l.id] : []))) };
}

type Page = { title: string; body: string; path: string };
/**
 * Check an extraction in the complete pages, against the vault as it will be read: the
 * appended section's links lead where they did on the source, and no other link on either
 * page changes. A reference definition left behind, or a destination that ends inside an open
 * code block, changes the section's links even though its text arrives intact.
 */
export function verifyMovedLinks(
  moved: ReturnType<typeof carryLinks>,
  pages: { source: Page; shrunk: Page; target?: Page; landed: Page },
  targets: Targets,
  at: {
    section: { start: number; end: number };
    stubEnd: number;
    appended: number;
    destinationId: string;
  },
) {
  const links = (page: Page) => documentLinks(page.body, page.path, targets);
  const same = (a: string[], b: string[]) => a.join("\n") === b.join("\n");
  const { start, end } = at.section,
    source = links(pages.source),
    shrunk = links(pages.shrunk),
    landed = links(pages.landed);
  if (
    (pages.target && !same(linkKeys(links(pages.target), 0), linkKeys(landed, 0, at.appended))) ||
    !same(
      [...linkKeys(source, 0, start), ...linkKeys(source, end)],
      [...linkKeys(shrunk, 0, start), ...linkKeys(shrunk, at.stubEnd)],
    ) ||
    !linkKeys(shrunk, start, at.stubEnd).includes(`id:${at.destinationId}`)
  ) {
    throw new Error(
      "Extraction verification failed: the move would change other links on either page. Link records by ID ([[id|label]]) and retry. No publication accepted.",
    );
  }
  const keys = linkKeys(landed, at.appended),
    lost = moved.links.filter((l, n) => l.key !== keys[n]);
  if (lost.length || keys.length !== moved.links.length) {
    throw new Error(
      `Section links would not lead to the same records on ${pages.landed.title}: ${(lost.length ? lost : moved.links).map((l) => l.raw).join(", ")}. Write them as inline links or [[id|label]] links (a reference definition elsewhere on ${pages.source.title} does not move), and make sure ${pages.landed.title} does not end inside an open code block. No publication accepted.`,
    );
  }
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

/**
 * A claim revision that adds the destination page as its first entity. Its established
 * subjects stay: whether the source page is still relevant is the agent's call, made
 * explicitly with knowledge_annotate, not inferred from the claim's wording.
 */
export function relinkClaim(
  claim: LoadedRecord,
  destinationId: string,
  change: { reason: string; actor: string; requestId: string; at: string },
): LoadedRecord {
  const entities = [destinationId, ...(claim.metadata.entities ?? [])];
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
