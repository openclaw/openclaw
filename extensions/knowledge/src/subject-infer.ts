import type { LoadedRecord } from "./model.js";
// Adapted from gbrain src/core/facts/subject-infer.ts and the strict arms of
// src/core/entities/resolve.ts; see THIRD_PARTY_NOTICES.md.
import { exactLookup } from "./retrieval.js";
import { isCommonCapitalizedWord, nameCandidates } from "./subject-candidates.js";
import type { SampleVault } from "./vault.js";

type Snapshot = Awaited<ReturnType<SampleVault["scan"]>>;
type StrictMiss = "ambiguous" | "unverified" | "not_entity" | "no_page";
type Strict = { id: string } | { id: null; miss: StrictMiss };
/** The page a claim's text names, or why none was inferred. */
export type InferResult =
  | { id: string }
  | { id: null; reason: "ambiguous" | "unverified_match" | "no_mention" | "no_page" };

/** Page types a claim may be inferred to be about: named entities, never meetings, notes or documents. */
const FACT_ENTITY_TYPES = new Set(["concept", "project", "deal"]);
/** Types whose title a bare first-name-shaped token could be a prefix of. */
const PREFIX_TYPES = new Set(["person", "company", "project"]);

/** Capitalized role and business terms that are not names, so they never veto ("Atlas hired a CFO"). */
const ROLE_AND_TERM_TOKENS = new Set([
  "ceo",
  "cfo",
  "cto",
  "coo",
  "cmo",
  "cpo",
  "cro",
  "vp",
  "svp",
  "evp",
  "gm",
  "pm",
  "hr",
  "qa",
  "ops",
  "api",
  "sdk",
  "ai",
  "ml",
  "mvp",
  "kpi",
  "okr",
  "okrs",
  "arr",
  "mrr",
  "ipo",
  "loi",
  "nda",
  "saas",
  "b2b",
  "b2c",
  "pr",
  "ui",
  "ux",
  "q1",
  "q2",
  "q3",
  "q4",
  "h1",
  "h2",
  "fy",
  "eod",
  "eow",
  "asap",
  "faq",
  "tbd",
  "n/a",
]);

/** Words that open a note without naming anyone; only these are ignored at a sentence start. */
const SENTENCE_OPENERS = new Set([
  "met",
  "meeting",
  "talked",
  "spoke",
  "called",
  "emailed",
  "texted",
  "messaged",
  "asked",
  "told",
  "said",
  "says",
  "heard",
  "raised",
  "closed",
  "signed",
  "hired",
  "fired",
  "lost",
  "won",
  "launched",
  "shipped",
  "released",
  "announced",
  "opened",
  "moved",
  "booked",
  "bought",
  "sold",
  "sent",
  "paid",
  "got",
  "had",
  "has",
  "have",
  "went",
  "came",
  "saw",
  "ate",
  "ran",
  "slept",
  "started",
  "finished",
  "stopped",
  "decided",
  "agreed",
  "declined",
  "approved",
  "rejected",
  "scheduled",
  "cancelled",
  "canceled",
  "need",
  "needs",
  "want",
  "wants",
  "prefer",
  "prefers",
  "likes",
  "loves",
  "hates",
  "dislikes",
  "thinks",
  "believes",
  "plans",
  "remember",
  "remind",
  "reminder",
  "note",
  "todo",
  "follow",
  "followup",
  "introduced",
  "intro",
  "invested",
  "joined",
  "left",
  "currently",
  "recently",
  "previously",
  "usually",
  "always",
  "never",
  "often",
  "sometimes",
  "probably",
  "apparently",
  "not",
  "no",
  "yes",
  "after",
  "before",
  "during",
  "since",
  "until",
  "while",
  "per",
  "via",
  "re",
  "fyi",
  "update",
  "updated",
  "lunch",
  "dinner",
  "breakfast",
  "coffee",
  "drinks",
  "call",
  "sync",
  "standup",
  "interview",
  "demo",
  "pitch",
  "board",
  "favorite",
  "favourite",
  "birthday",
  "anniversary",
  "allergic",
  "vegetarian",
  "vegan",
  "lives",
  "lived",
  "works",
  "worked",
]);

/** Record-ID-shaped tokens; only those naming a current record are candidates. */
const ID_TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9][A-Za-z0-9_-]{7,95}(?![A-Za-z0-9_-])/gu;

const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** True for a page type that names a person, company, concept, project or deal. */
export function isFactEntity(data: Snapshot, record: Pick<LoadedRecord, "type">): boolean {
  const definition = data.ontology?.definitions.find(
    (d) => d.definition.name === record.type,
  )?.definition;
  return definition?.primitive === "entity" || FACT_ENTITY_TYPES.has(record.type ?? "");
}

/** True when a single token with no page could be the first name of a person, company or project. */
function isBareName(query: string): boolean {
  return !/[\s/]/u.test(query.trim()) && /[\p{L}\p{N}]/u.test(query);
}

/**
 * Resolve one name with identity evidence only: an exact page ID, title or
 * alias. Two current pages answering to it are ambiguous; a page that is not
 * an entity (a meeting) is not_entity; a bare name that only prefixes an
 * entity's title ("Alice" for "Alice Example") is unverified, never a match.
 */
function resolveStrict(data: Snapshot, query: string, withdrawn: Set<string>): Strict {
  const found = exactLookup(data, { query, kind: "page", limit: 10 }, withdrawn);
  if (found.outcome === "ambiguous") {
    return { id: null, miss: "ambiguous" };
  }
  if (found.outcome === "found") {
    const record = found.hits[0]!.record;
    const page = data.records.find((r) => r.id === record.id) ?? record;
    return isFactEntity(data, page) ? { id: page.id } : { id: null, miss: "not_entity" };
  }
  if (isBareName(query)) {
    const prefix = `${normalize(query)} `;
    const pages = data.records.filter(
      (r) =>
        r.kind === "page" &&
        r.lifecycle === "active" &&
        r.valid &&
        !withdrawn.has(r.id) &&
        PREFIX_TYPES.has(r.type ?? ""),
    );
    if (pages.some((r) => normalize(r.title).startsWith(prefix))) {
      return { id: null, miss: "unverified" };
    }
  }
  return { id: null, miss: "no_page" };
}

/** "Joined Atlas Labs" glues the opener into the name run; resolve the name without it. */
function shedOpener(query: string): string {
  const [first, ...rest] = query.split(/\s+/u);
  return rest.length && SENTENCE_OPENERS.has(first!.toLowerCase()) ? rest.join(" ") : query;
}

function isNonName(query: string): boolean {
  return (
    !/\s/u.test(query) &&
    (isCommonCapitalizedWord(query) || ROLE_AND_TERM_TOKENS.has(query.toLowerCase()))
  );
}

/**
 * Resolve a saver's free-text subject hint ("bundled plugin hot reload, PR #180466").
 * The whole hint, then each comma- or semicolon-separated part, is tried as an
 * exact page name; it links only when those parts name exactly one entity page
 * and none is ambiguous. Otherwise the hint is read like claim text.
 */
export function resolveHint(data: Snapshot, hint: string, withdrawn: Set<string>): InferResult {
  const parts = [hint, ...hint.split(/[,;]/u)].map((p) => p.trim()).filter(Boolean);
  const found = new Set<string>();
  for (const part of new Set(parts)) {
    const r = resolveStrict(data, part, withdrawn);
    if (r.id !== null) {
      found.add(r.id);
    } else if (r.miss === "ambiguous") {
      return { id: null, reason: "ambiguous" };
    }
  }
  if (found.size === 1) {
    return { id: [...found][0]! };
  }
  return found.size > 1 ? { id: null, reason: "ambiguous" } : inferSubject(data, hint, withdrawn);
}

/**
 * Name the page a claim is about from its own text: exactly one current
 * entity page must be named (by ID, title or alias) and no other real name may
 * compete, even one with no page ("Nimbus copied Atlas's pricing" names two
 * companies, so the subject is unknown, not Atlas). Bare first names are never
 * guessed, and a capitalized sentence opener or role term is no name evidence.
 */
export function inferSubject(data: Snapshot, text: string, withdrawn: Set<string>): InferResult {
  const pageIds = new Set(data.records.filter((r) => r.kind === "page").map((r) => r.id));
  const candidates = [
    ...[...new Set(text.match(ID_TOKEN_RE) ?? [])]
      .filter((token) => pageIds.has(token))
      .map((query) => ({ query, sentenceStart: undefined })),
    ...nameCandidates(text).map((c) => Object.assign(c, { query: shedOpener(c.query) })),
  ];
  const resolved = new Set<string>(),
    misses: StrictMiss[] = [];
  let vetoed = false;
  for (const candidate of candidates) {
    const r = resolveStrict(data, candidate.query, withdrawn);
    if (r.id !== null) {
      resolved.add(r.id);
      // Two distinct entities already make the subject unknown.
      if (resolved.size >= 2) {
        return { id: null, reason: "ambiguous" };
      }
      continue;
    }
    misses.push(r.miss);
    // A name that is not an entity page does not compete; neither does a
    // role term or a capitalized opener with no page. Anything else does.
    if (r.miss === "not_entity") {
      continue;
    }
    if (
      r.miss === "no_page" &&
      (isNonName(candidate.query) ||
        (candidate.sentenceStart && SENTENCE_OPENERS.has(candidate.query.toLowerCase())))
    ) {
      continue;
    }
    vetoed = true;
  }
  if (resolved.size === 1 && !vetoed) {
    return { id: [...resolved][0]! };
  }
  if (resolved.size > 0 || misses.includes("ambiguous")) {
    return { id: null, reason: "ambiguous" };
  }
  if (misses.includes("unverified")) {
    return { id: null, reason: "unverified_match" };
  }
  return { id: null, reason: vetoed ? "no_page" : "no_mention" };
}
