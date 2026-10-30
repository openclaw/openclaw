import { Marked, type Token } from "marked";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const wikiHref = (target: string) => `#wiki=${encodeURIComponent(target)}`;
/** One parser for navigation and rendering: code, escapes, HTML and images are not links. */
export const markdown = new Marked({
  gfm: true,
  async: false,
  renderer: {
    // Comment tokens are metadata, while other raw HTML remains inert visible text.
    html: ({ text }) => (/^\s*<!--/.test(text) ? "" : escapeHtml(text)),
    image: ({ text }) => escapeHtml(text),
  },
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src) => src.indexOf("[["),
      tokenizer(src) {
        const match = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
        if (match) {
          return {
            type: "wikilink",
            raw: match[0],
            target: match[1]!.trim(),
            label: (match[2] ?? match[1]!).trim(),
          };
        }
        return undefined;
      },
      renderer: (token) =>
        `<a href="${escapeHtml(wikiHref(token.target))}">${escapeHtml(token.label)}</a>`,
    },
  ],
});
// Scans share parsed metadata across record copies. Retiring that parse must
// also release its body; a string-keyed cache retains obsolete document versions.
const extracted = new WeakMap<LinkRecord["metadata"], { body: string; hrefs: string[] }>();
const extractionOwner = Symbol("knowledge.linkExtractionOwner");
/** Merged-reference projections keep the source document's link parse. */
export function carryLinkExtraction(source: LinkRecord, projection: LinkRecord) {
  projection[extractionOwner] = source[extractionOwner] ?? source.metadata;
}
// JavaScriptCore (Bun, Safari) caps regexp backtracking memory and reports an
// over-cap match as no match, without an error. marked's paragraph rule exceeds
// that cap after about 49,000 lines in one block. marked then lexes the rest line
// by line and reruns every block rule each time, so a large record takes hours.
// Breaking long runs of non-blank lines keeps every block under the cap. Only
// blocks already thousands of lines long are split, and their links stay the
// same. A multi-line link label that crosses a break is the accepted loss.
const LEX_RUN_MAX_LINES = 10_000;
function boundBlockRuns(body: string): string {
  const parts: string[] = [];
  let run = 0,
    kept = 0;
  for (let start = 0; start < body.length;) {
    const newline = body.indexOf("\n", start),
      end = newline === -1 ? body.length : newline;
    if (!body.slice(start, end).trim()) {
      run = 0;
    } else if (++run > LEX_RUN_MAX_LINES) {
      parts.push(body.slice(kept, start), "\n");
      kept = start;
      run = 1;
    }
    start = end + 1;
  }
  return parts.length ? parts.join("") + body.slice(kept) : body;
}
const BACKLINKS_START = /^\s*<!--\s*(?:knowledge:)?backlinks:start\s*-->\s*$/i;
const BACKLINKS_END = /^\s*<!--\s*(?:knowledge:)?backlinks:end\s*-->\s*$/i;
function extractLinks(body: string): string[] {
  // Generated backlinks must not recursively create their own backlinks.
  const tokens = markdown.lexer(boundBlockRuns(body)).filter(
    (() => {
      let generated = false;
      return (token: { type: string; raw: string }) => {
        if (token.type === "html" && BACKLINKS_START.test(token.raw)) {
          generated = true;
          return false;
        }
        if (token.type === "html" && BACKLINKS_END.test(token.raw)) {
          generated = false;
          return false;
        }
        return !generated;
      };
    })(),
  );
  const links = new Set<string>();
  void markdown.walkTokens(tokens, (token) => {
    if (token.type === "wikilink") {
      links.add(wikiHref(token.target));
    }
    if (token.type === "link") {
      links.add(token.href);
    }
  });
  return [...links];
}
export type LinkSpan = {
  href: string;
  raw: string;
  label: string;
  /** UTF-16 offset in the body. When `verbatim` is false the link's raw text is reshaped by
   * its container (a quote marker or list indent inside it) and only its first line was found. */
  start: number;
  verbatim: boolean;
  /** Written `[label](destination)`, not as a reference, shortcut, autolink or wikilink. */
  inline: boolean;
};
/**
 * The links extractLinks reads, in document order with their offsets, so a caller can edit
 * exactly a parsed link and no other bytes. marked tokens carry no positions: each leaf
 * token is located after the previous one, so text that only looks like a link (in code,
 * after an escape) is passed over rather than matched.
 */
export function linkSpans(body: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  let at = 0;
  const locate = (raw: string) => {
    const line = raw.split("\n", 1)[0]!,
      found = body.indexOf(line, at),
      start = found === -1 ? at : found,
      verbatim = found !== -1 && body.startsWith(raw, start);
    at = start + (verbatim ? raw.length : line.length);
    return { start, verbatim };
  };
  const visit = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "link") {
        const inline = token.raw.startsWith(`[${token.text}](`) && token.raw.endsWith(")");
        spans.push({
          href: token.href,
          raw: token.raw,
          label: token.text,
          inline,
          ...locate(token.raw),
        });
      } else if (token.type === "wikilink") {
        spans.push({
          href: wikiHref(String(token.target)),
          raw: token.raw,
          label: String(token.label),
          inline: false,
          ...locate(token.raw),
        });
      } else if (token.type === "list") {
        visit(token.items);
      } else if (token.type === "table") {
        for (const cell of [...token.header, ...token.rows.flat()]) {
          visit(cell.tokens);
        }
      } else if ("tokens" in token && token.tokens && token.type !== "image") {
        visit(token.tokens);
      } else {
        locate(token.raw);
      }
    }
  };
  let generated = false;
  for (const token of markdown.lexer(boundBlockRuns(body))) {
    if (token.type === "html" && BACKLINKS_START.test(token.raw)) {
      generated = true;
    } else if (token.type === "html" && BACKLINKS_END.test(token.raw)) {
      generated = false;
      locate(token.raw);
      continue;
    }
    if (generated) {
      locate(token.raw);
    } else {
      visit([token]);
    }
  }
  return spans;
}
export type LinkResolution = {
  href: string;
  status: "resolved" | "missing" | "ambiguous";
  id?: string;
};
type LinkRecord = {
  id: string;
  title: string;
  path: string;
  body: string;
  metadata: { aliases?: string[] };
  [extractionOwner]?: LinkRecord["metadata"];
};
// Backslash or any C0 control character.
const UNSAFE_TARGET_CHARACTER = new RegExp(String.raw`[\\\u0000-\u001f]`);
const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
function cleanPath(value: string): string | undefined {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") {
      if (!parts.length) {
        return undefined;
      }
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}
type LinkIndex = {
  byPath: Map<string, Set<LinkRecord>>;
  byId: Map<string, Set<LinkRecord>>;
  byName: Map<string, Set<LinkRecord>>;
};
// Normalized lookup tables for one candidate list, built once instead of
// normalizing every candidate for every link.
const indexes = new WeakMap<LinkRecord[], LinkIndex>();
function linkIndex(records: LinkRecord[]): LinkIndex {
  let index = indexes.get(records);
  if (index) {
    return index;
  }
  index = { byPath: new Map(), byId: new Map(), byName: new Map() };
  const add = (map: Map<string, Set<LinkRecord>>, key: string, r: LinkRecord) => {
    let set = map.get(key);
    if (!set) {
      map.set(key, (set = new Set()));
    }
    set.add(r);
  };
  for (const r of records) {
    add(index.byPath, normalize(r.path.replace(/\.md$/i, "")), r);
    add(index.byId, r.id, r);
    for (const name of [
      r.title,
      r.path.split("/").at(-1)!.replace(/\.md$/i, ""),
      ...(r.metadata.aliases ?? []),
    ]) {
      add(index.byName, normalize(name), r);
    }
  }
  indexes.set(records, index);
  return index;
}
/** Where one href leads from a record in directory `parent`; undefined when it is not a record link. */
function resolveHref(
  href: string,
  parent: string,
  index: LinkIndex,
  canonical?: (id: string) => string,
): LinkResolution | undefined {
  const wiki = href.startsWith("#wiki=");
  if (!wiki && (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href) || !/\.md(?:#.*)?$/i.test(href))) {
    return undefined;
  }
  let target: string;
  try {
    target = decodeURIComponent(wiki ? href.slice(6) : href).split("#")[0]!;
  } catch {
    target = "";
  }
  if (
    !target ||
    UNSAFE_TARGET_CHARACTER.test(target) ||
    /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)
  ) {
    return { href, status: "missing" };
  }
  const bare = target.replace(/\.md$/i, "");
  const paths =
    wiki && !target.startsWith(".")
      ? [cleanPath(target), cleanPath(`${parent}/${target}`)]
      : [cleanPath(`${parent}/${target}`)];
  let matches = new Set<LinkRecord>();
  for (const p of paths) {
    if (p) {
      for (const r of index.byPath.get(normalize(p.replace(/\.md$/i, ""))) ?? []) {
        matches.add(r);
      }
    }
  }
  // Old UUID paths survive renames. IDs remain authoritative, not inferred from filenames.
  if (!matches.size) {
    matches = new Set(index.byId.get(bare.split("/").at(-1)!) ?? []);
  }
  if (!matches.size && wiki && !target.includes("/")) {
    matches = new Set(index.byName.get(normalize(bare)) ?? []);
  }
  const ids = new Set(
    [...matches]
      .map((r) => (canonical ? canonical(r.id) : r.id))
      .filter((id) => !canonical || (index.byId.has(id) && canonical(id) === id)),
  );
  const [only] = ids;
  return {
    href,
    status: ids.size === 1 ? "resolved" : ids.size ? "ambiguous" : "missing",
    ...(ids.size === 1 ? { id: only } : {}),
  };
}
/** Input records must already be authorized and lifecycle-filtered. Never guess ambiguous names.
 * `canonical` maps a merged page among `records` to the page it was merged into; a name matching
 * both counts once, and a link whose final page is not among `records` is missing. */
export function resolveLinks(
  record: LinkRecord,
  records: LinkRecord[],
  canonical?: (id: string) => string,
): LinkResolution[] {
  const index = linkIndex(records),
    parent = record.path.split("/").slice(0, -1).join("/");
  const owner = record[extractionOwner] ?? record.metadata;
  let parsed = extracted.get(owner);
  if (!parsed || parsed.body !== record.body) {
    parsed = { body: record.body, hrefs: extractLinks(record.body) };
    extracted.set(owner, parsed);
  }
  return parsed.hrefs.flatMap((href) => resolveHref(href, parent, index, canonical) ?? []);
}
/** Where one href leads from a record at path `from`, under the same rules as resolveLinks. */
export const resolveLinkHref = (
  href: string,
  from: string,
  records: LinkRecord[],
  canonical?: (id: string) => string,
) => resolveHref(href, from.split("/").slice(0, -1).join("/"), linkIndex(records), canonical);
