import type { FeatureHandlers, FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { Static } from "typebox";
import type { ChronicleOutput, LastSeenOutput } from "./chronicle-contract.js";
import type { contract, FullOutputContract } from "./contract.js";
import type { EvidenceReadOutput } from "./evidence-read-contract.js";
import type { ReconcileEvidenceOutput } from "./evidence-reconciliation-contract.js";
import { hashPrefix } from "./hash-fence.js";
import type { SourceCheckOutput, VerifyOutput } from "./ingestion-contract.js";
import type { OntologyOutput, RecordInput, RecordOutput } from "./inspection-contract.js";
import type { Receipt } from "./mutation-contract.js";
import type { RememberOutput } from "./remember-contract.js";
import type { FullHit, LookupOutput, SearchOutput } from "./retrieval-contract.js";
import type { StoreState } from "./stores-contract.js";
import { splitsPair } from "./text-window.js";
import {
  COMPACT_SNIPPET_CHARS,
  type Detail,
  type LeanChronicleItem,
  type LeanChronicleOutput,
  type LeanEvidence,
  type LeanEvidenceReadOutput,
  type LeanHit,
  type LeanLastSeenOutput,
  type LeanLookupOutput,
  type LeanOntologyOutput,
  type LeanReceipt,
  type LeanRecordOutput,
  type LeanRecordsOutput,
  type LeanRememberOutput,
  type LeanSearchOutput,
  type LeanSourceCheckOutput,
  type LeanStatusOutput,
  type LeanVerifyOutput,
} from "./tool-result-contract.js";
import {
  inactive,
  pageRow,
  stripComments,
  summaryRow,
  type PageRow as PageRowValue,
  type Ref,
} from "./tool-rows.js";

// Agent tools return what an agent needs most of the time. Complete shapes stay
// one explicit option away (detail/view/metadataView/includeEvidence/
// includeReferences) or behind targeted tools (knowledge_mutation, knowledge_history).
// Control UI, operator and command callers always receive the complete shape.

/** Default page size for agent search/lookup calls that omit limit. */
export const AGENT_HIT_LIMIT = 10;
/** Default whole-response bound for an agent knowledge_record read. */
export const AGENT_RECORD_MAX_CHARS = 12000;
// Full snippets open 100 characters before the match; keep a little lead-in.
const MATCH_OFFSET = 100,
  LEAD_IN = 40;
// A bounded record read always advances through a long body by at least this much.
const MIN_BODY_PROGRESS = 256;

const nextOffset = (value: number | null) => (value === null ? {} : { nextOffset: value });
// Snapshots exist to compare pages; a single page has nothing to compare.
const paging = (next: number | null, snapshot?: string | null) =>
  next === null ? {} : { nextOffset: next, ...(snapshot ? { snapshot } : {}) };
const coverage = (c: { complete: boolean; message: string }) =>
  c.complete ? {} : { coverage: { complete: false as const, message: c.message } };
// knowledge_record
type InspectedEvidence = NonNullable<RecordOutput["evidence"]>[number];
// A citation as an agent needs it to read the passage: locator, quote and excerpt.
// Attribution appears only where it differs from the record's own.
const leanEvidence = (e: InspectedEvidence, attribution?: string): Static<typeof LeanEvidence> => ({
  path: e.path,
  sha256: e.sha256,
  ...(e.filename ? { filename: e.filename } : {}),
  ...(e.start_line === undefined ? {} : { start_line: e.start_line }),
  ...(e.end_line === undefined ? {} : { end_line: e.end_line }),
  ...(e.quote ? { quote: e.quote } : {}),
  ...(e.attribution && e.attribution !== attribution ? { attribution: e.attribution } : {}),
  ...(e.excerpt ? { excerpt: e.excerpt } : {}),
  ...(e.verified ? {} : { verified: false as const }),
  ...(e.excerptTruncated ? { excerptTruncated: true as const } : {}),
});
const ref = (r: { id: string; title?: string }): Static<typeof Ref> => ({
  id: r.id,
  ...(r.title ? { title: r.title } : {}),
});
const present = <K extends string, V>(key: K, value: V | undefined | null) =>
  (value === undefined || value === null || (Array.isArray(value) && !value.length)
    ? {}
    : { [key]: value }) as Partial<Record<K, V>>;

export function leanRecord(output: RecordOutput, input: RecordInput): LeanRecordOutput {
  const r = output.record;
  const extras = {
    ...present("issues", output.issues),
    ...(output.mergedInto ? { mergedInto: ref(output.mergedInto) } : {}),
    ...(output.mergedFrom?.length ? { mergedFrom: output.mergedFrom.map(ref) } : {}),
    ...present("redirects", output.redirects),
  };
  if (!r) {
    return { record: null, ...extras };
  }
  const m = r.metadata ?? {};
  const claim = r.kind === "claim";
  // Linked pages the read summarized come first; further entity IDs follow without titles.
  const about = [
    ...(r.about ?? []).map(ref),
    ...(m.entities ?? [])
      .filter((id) => !(r.about ?? []).some((a) => a.id === id))
      .map((id) => ({ id })),
  ];
  const fields = m.fields && Object.keys(m.fields).length ? m.fields : undefined;
  const date = claim ? (m.occurred_at ?? r.occurredAt ?? r.recordedAt) : undefined;
  const fullMetadata = input.metadataView === "full" || input.includeMetadata === true;
  const lean: LeanRecordOutput = {
    record: {
      id: r.id,
      revision: r.revision,
      hash: r.hash,
      ...inactive(r.lifecycle),
      ...(claim ? { claimKind: r.claimKind ?? r.type } : { title: r.title, type: r.type }),
      ...(date ? { date } : {}),
      ...(m.due_at ? { dueAt: m.due_at } : {}),
      ...(r.owner ? { owner: ref(r.owner) } : {}),
      ...(r.kind === "relationship" && r.from && r.to ? { from: r.from, to: r.to } : {}),
      ...(m.aliases?.length ? { aliases: m.aliases } : {}),
      ...(fields ? { fields } : {}),
      ...(m.identity?.status === "partial"
        ? { identity: { status: "partial" as const, context: m.identity.context } }
        : {}),
      ...(about.length ? { about } : {}),
      ...(r.source ? { source: ref(r.source) } : {}),
      ...(r.attribution ? { attribution: r.attribution } : {}),
      ...(r.assertionOrigin && r.assertionOrigin !== "source"
        ? { assertionOrigin: r.assertionOrigin }
        : {}),
      ...(m.superseded_by ? { supersededBy: m.superseded_by } : {}),
      ...(r.raw !== undefined
        ? { raw: r.raw }
        : r.body === undefined
          ? {}
          : claim
            ? { text: stripComments(r.body) }
            : { body: r.body }),
    },
    ...(output.content.nextOffset === null
      ? {}
      : { nextOffset: output.content.nextOffset, totalChars: output.content.totalChars }),
    ...extras,
    ...(fullMetadata ? { metadata: r.metadata } : {}),
    ...(input.includeEvidence
      ? {
          ...present(
            "evidence",
            output.evidence?.map((e) => leanEvidence(e, r.attribution)),
          ),
          ...present("evidenceTotal", output.evidenceTotal),
          ...present("evidenceSourceTotal", output.evidenceSourceTotal),
          ...present("nextEvidenceOffset", output.nextEvidenceOffset),
          ...present(
            "sourceFiles",
            output.sourceFiles?.map(({ evidence: e, citations }) => ({
              path: e.path,
              sha256: e.sha256,
              ...(e.filename ? { filename: e.filename } : {}),
              citations,
            })),
          ),
          ...present("sourceFilesTotal", output.sourceFilesTotal),
          ...present(
            "identityEvidence",
            output.identityEvidence
              ?.filter((i) => i.evidence.length)
              .map((i) => ({ id: i.id, evidence: i.evidence.map((e) => leanEvidence(e)) })),
          ),
          ...present(
            "relatedStatements",
            output.relatedStatements?.map((s) => ({
              id: s.record.id,
              revision: s.record.revision,
              ...(s.record.hash ? { hash: hashPrefix(s.record.hash) } : {}),
              relation: s.relation,
              incoming: s.incoming,
              basis: s.basis,
              ...(s.text ? { text: stripComments(s.text) } : {}),
              ...(s.source ? { source: ref(s.source) } : {}),
              ...(s.assertionOrigin && s.assertionOrigin !== "source"
                ? { assertionOrigin: s.assertionOrigin }
                : {}),
            })),
          ),
        }
      : {}),
    ...(input.includeReferences
      ? {
          ...present(
            "references",
            output.references?.map((s) => summaryRow(s)),
          ),
          ...present("referenceTotal", output.referenceTotal),
          ...present("nextReferenceOffset", output.nextReferenceOffset),
          ...present("links", output.links),
          ...(output.linksTruncated ? { linksTruncated: true } : {}),
        }
      : {}),
    ...present("omitted", output.omitted),
  };
  return boundLeanRecord(lean, output, input.maxChars ?? AGENT_RECORD_MAX_CHARS);
}

// maxChars bounds the complete serialized response, not just the text window.
// Claim text is shown without comments, so only page bodies and raw text are
// continued by offset; requested evidence and references keep their own limits.
function boundLeanRecord(
  lean: LeanRecordOutput,
  output: RecordOutput,
  maxChars: number,
): LeanRecordOutput {
  const record = lean.record,
    key = record?.raw !== undefined ? "raw" : "body",
    value = record?.[key];
  const size = () => JSON.stringify(lean).length;
  if (!record || value === undefined || size() <= maxChars) {
    return lean;
  }
  let keep = value.length;
  while (keep > 0 && size() > maxChars) {
    keep = Math.max(0, keep - (size() - maxChars));
    if (splitsPair(value, keep)) {
      keep--;
    }
    record[key] = value.slice(0, keep);
  }
  // A response that cannot hold any text still advances: identity wins over the bound.
  if (keep === 0 && value.length) {
    keep = Math.min(value.length, MIN_BODY_PROGRESS);
    if (splitsPair(value, keep)) {
      keep--;
    }
    record[key] = value.slice(0, keep);
  }
  if (keep < value.length) {
    lean.nextOffset = output.content.offset + keep;
    lean.totalChars = output.content.totalChars;
  }
  return lean;
}

// knowledge_grep / knowledge_lookup
function snippet(hit: FullHit) {
  const value = hit.snippet.text;
  // A snippet that does not start at the field start has the match at MATCH_OFFSET.
  const from = hit.snippet.start > 0 ? Math.max(0, MATCH_OFFSET - LEAD_IN) : 0;
  let to = Math.min(value.length, from + COMPACT_SNIPPET_CHARS);
  if (splitsPair(value, to)) {
    to--;
  }
  return stripComments(value.slice(from, to));
}

function leanHit(hit: FullHit, withSnippet: boolean): LeanHit {
  const r = hit.record;
  return {
    id: r.id,
    // A claim's title repeats its text; the snippet shows the text.
    ...(r.kind === "claim" && withSnippet ? {} : { title: r.title }),
    ...(r.kind === "page" ? {} : { kind: r.kind }),
    type: r.type,
    revision: hit.citation.revision,
    hash: hashPrefix(hit.citation.hash),
    ...inactive(r.lifecycle),
    ...(withSnippet ? { snippet: snippet(hit) } : {}),
    ...(hit.via ? { via: { id: hit.via.id, revision: hit.via.revision } } : {}),
  };
}

export const leanSearch = (o: SearchOutput): Static<typeof LeanSearchOutput> => ({
  hits: o.hits.map((h) => leanHit(h, true)),
  resultCount: o.resultCount,
  total: o.total,
  ...paging(o.nextOffset, o.index.snapshot),
  ...coverage(o.coverage),
  ...(o.index.state === "ready"
    ? {}
    : { index: { state: "unavailable" as const, message: o.index.message } }),
});

export const leanLookup = (o: LookupOutput): Static<typeof LeanLookupOutput> => ({
  outcome: o.outcome,
  hits: o.hits.map((h) => leanHit(h, false)),
  resultCount: o.resultCount,
  total: o.total,
  ...nextOffset(o.nextOffset),
  ...coverage(o.coverage),
  ...(o.redirectedFrom ? { redirectedFrom: o.redirectedFrom } : {}),
});

// knowledge_timeline / knowledge_chronicle_*
type Item = ChronicleOutput["items"][number];
const temporalRow = (r: Item["record"]): PageRowValue =>
  pageRow({ ...r, valid: true, hash: r.hash });

function leanItem(item: Item): Static<typeof LeanChronicleItem> {
  const r = item.record,
    summary = stripComments(item.summary);
  return {
    date: item.date.slice(0, 10),
    id: r.id,
    // A claim's title repeats its text, which the summary carries.
    ...(r.kind === "claim" ? {} : { title: r.title }),
    type: r.type,
    revision: r.revision,
    hash: hashPrefix(r.hash),
    ...(summary ? { summary } : {}),
    ...(item.claims === undefined ? {} : { claims: item.claims }),
    ...(item.noteRecord ? { noteRecord: item.noteRecord } : {}),
    ...inactive(r.lifecycle),
    ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
  };
}

export const leanChronicle = (o: ChronicleOutput): Static<typeof LeanChronicleOutput> => ({
  items: o.items.map(leanItem),
  total: o.total,
  ...paging(o.nextOffset, o.snapshot),
  ...coverage(o.coverage),
  ...(o.sources ? { sources: o.sources.map(temporalRow) } : {}),
});

export const leanLastSeen = (
  o: Static<typeof LastSeenOutput>,
): Static<typeof LeanLastSeenOutput> => ({
  entity: o.entity,
  last: o.last ? leanItem(o.last) : null,
  // The message explains an empty answer; a found item speaks for itself.
  ...(o.last ? {} : { message: o.message }),
  ...(o.sources ? { sources: o.sources.map(temporalRow) } : {}),
});

// knowledge_records
type RecordsFull = {
  records: Parameters<typeof summaryRow>[0][];
  endpoints?: Parameters<typeof pageRow>[0][];
  total: number;
  nextOffset: number | null;
  facets?: { kinds: Record<string, number>; origins: Record<string, number> };
};
export const leanRecords = (o: RecordsFull): Static<typeof LeanRecordsOutput> => ({
  records: o.records.map((r) => summaryRow(r)),
  ...(o.endpoints ? { endpoints: o.endpoints.map(pageRow) } : {}),
  total: o.total,
  ...nextOffset(o.nextOffset),
  ...(o.facets && Object.keys(o.facets.kinds).length ? { facets: o.facets } : {}),
});

// knowledge_ontology
const nonEmpty = <K extends string, T>(key: K, value: T[] | undefined) =>
  (value?.length ? { [key]: value } : {}) as Partial<Record<K, T[]>>;

export function leanOntology(o: OntologyOutput): Static<typeof LeanOntologyOutput> {
  const definitions = o.view === "definitions";
  return {
    fingerprint: o.fingerprint,
    ...(o.available ? {} : { available: false as const }),
    ...(o.definitions
      ? {
          definitions: o.definitions.map((d) => ({
            name: d.name,
            kind: d.kind,
            description: d.description,
            // Type aliases matter when authoring against one definition, not in the catalog.
            ...(definitions ? nonEmpty("aliases", d.aliases) : {}),
            ...(d.directory ? { directory: d.directory } : {}),
            ...nonEmpty("fields", d.fields),
            ...nonEmpty("fromTypes", d.fromTypes),
            ...nonEmpty("toTypes", d.toTypes),
            ...nonEmpty("pathPrefixes", d.pathPrefixes),
            ...(d.behaviors ? { behaviors: d.behaviors } : {}),
            ...(d.records ? { records: d.records.map(pageRow) } : {}),
            ...(d.recordsTruncated ? { recordsTruncated: true } : {}),
          })),
        }
      : {}),
    ...(o.sources
      ? { sources: o.sources.map((s) => ({ path: s.path, valid: s.valid, name: s.name })) }
      : {}),
    ...(o.source ? { source: o.source } : {}),
    ...(o.issues ? { issues: o.issues, chain: o.chain ?? [] } : {}),
    ...(o.totalIssues ? { totalIssues: o.totalIssues } : {}),
    total: o.total,
    ...nextOffset(o.nextOffset),
  };
}

// knowledge_status
type StatusFull = {
  vault: string;
  agent: string;
  store: Static<typeof StoreState>;
  scope: string;
  writesEnabled: boolean;
  records: number;
  ontologyFingerprint: string;
  issues: number;
  message?: string;
};
export const leanStatus = (o: StatusFull): Static<typeof LeanStatusOutput> => ({
  vault: o.vault,
  agent: o.agent,
  store: o.store,
  // Private is the default scope; only a conversation scope is called out.
  ...(o.scope === "private" ? {} : { scope: o.scope }),
  writesEnabled: o.writesEnabled,
  records: o.records,
  ontologyFingerprint: o.ontologyFingerprint,
  ...(o.issues ? { issues: o.issues } : {}),
  ...(o.message ? { message: o.message } : {}),
});

// knowledge_verify
export const leanVerify = (o: VerifyOutput): Static<typeof LeanVerifyOutput> => ({
  checked: o.checked,
  passed: o.passed,
  failed: o.failed,
  ...(o.problems.length ? { problems: o.problems } : {}),
  ...(o.totalProblems > o.problems.length ? { totalProblems: o.totalProblems } : {}),
  ...paging(o.nextOffset, o.snapshot),
  ...(o.index === "ready" ? {} : { index: "unavailable" as const }),
});

// knowledge_evidence_read
// Verification is always true on success (failures throw); the request names the record and file.
export const leanEvidenceRead = (o: EvidenceReadOutput): Static<typeof LeanEvidenceReadOutput> => ({
  text: o.text,
  range: o.range,
  ...(o.nextCursor === null ? {} : { nextCursor: o.nextCursor }),
});

// Write receipts

/**
 * The new revision and hash of what changed, the state only when not published,
 * and the ontology fingerprint the next write needs.
 */
export function leanReceipt(r: Receipt, keepRequestId = false): LeanReceipt {
  const items = r.items;
  return {
    ...(keepRequestId ? { requestId: r.requestId } : {}),
    id: r.id,
    revision: r.revision,
    hash: r.hash,
    ...(r.state === "published" ? {} : { state: r.state, message: r.message }),
    ...(items?.length
      ? {
          items: items.map(({ key, id, revision, hash }) => ({ key, id, revision, hash })),
        }
      : {}),
    ...(r.impact?.total ? { impact: { items: r.impact.items, total: r.impact.total } } : {}),
    ...(r.merge ? { merge: r.merge } : {}),
    ...(r.budget ? { budget: r.budget } : {}),
    ...(r.ontologyFingerprint ? { ontologyFingerprint: r.ontologyFingerprint } : {}),
    // A recorded local Git checkpoint is the normal case; anything else needs attention.
    ...(r.git && r.git.state !== "committed" ? { git: r.git } : {}),
  };
}

export const leanRemember = (o: RememberOutput): Static<typeof LeanRememberOutput> => ({
  items: o.items,
  receipt: o.receipt ? leanReceipt(o.receipt) : null,
});

// A changed source is reconciled against the prior batch's requestId, so it stays.
export const leanSourceCheck = (
  o: Static<typeof SourceCheckOutput>,
): Static<typeof LeanSourceCheckOutput> => ({
  state: o.state,
  receipt: o.receipt ? leanReceipt(o.receipt, true) : null,
  message: o.message,
});

export const leanReconcileEvidence = (o: Static<typeof ReconcileEvidenceOutput>) =>
  o.state === "preview" ? o : leanReceipt(o);

type Handler<I, O> = (input: I, context: FeatureInvocationContext) => O | Promise<O>;

/** Project one handler's output for agent tool calls unless the input asks for full detail. */
function project<I, O, L>(
  handler: Handler<I, O>,
  lean: (output: O, input: I) => L,
  full: (input: I) => boolean = (input) => (input as { detail?: Detail }).detail === "full",
): Handler<I, O | L> {
  return async (input, context) => {
    // The response-only selector belongs to this adapter; the service never sees it.
    const { detail: _detail, ...payload } = input as I & { detail?: Detail };
    // SAFETY: payload is the handler's input minus the adapter-only detail key.
    const output = await handler(payload as I, context);
    return context.source === "tool" && !full(input) ? lean(output, input) : output;
  };
}

/** Agent search and lookup default to a short page. */
function agentLimit<I extends { limit?: number }, O>(handler: Handler<I, O>): Handler<I, O> {
  return (input, context) =>
    handler(
      context.source === "tool" && input.limit === undefined
        ? { ...input, limit: AGENT_HIT_LIMIT }
        : input,
      context,
    );
}

// Receipts and passages have no detail selector: knowledge_mutation and
// knowledge_history return complete receipts.
const never = () => false;

/**
 * Wrap the service handlers for agent tools. Every other caller, and any agent
 * call that asks for full detail, receives the service's complete output.
 */
export function leanToolResults(
  h: FeatureHandlers<FullOutputContract>,
): FeatureHandlers<typeof contract> {
  const receipt = <I>(handler: Handler<I, Receipt>) =>
    project(handler, (o: Receipt) => leanReceipt(o), never);
  return {
    ...h,
    record: project(h.record, leanRecord),
    grep: agentLimit(project(h.grep, leanSearch)),
    lookup: agentLimit(project(h.lookup, leanLookup)),
    timeline: project(h.timeline, leanChronicle),
    chronicle_day: project(h.chronicle_day, leanChronicle),
    chronicle_since: project(h.chronicle_since, leanChronicle),
    chronicle_last_seen: project(h.chronicle_last_seen, leanLastSeen),
    records: project(h.records, leanRecords),
    ontology: project(h.ontology, leanOntology),
    status: project(h.status, leanStatus),
    verify: project(h.verify, leanVerify),
    evidence_read: project(h.evidence_read, leanEvidenceRead, never),
    source_check: project(h.source_check, leanSourceCheck, never),
    remember: project(h.remember, leanRemember, never),
    reconcile_evidence: project(h.reconcile_evidence, leanReconcileEvidence, never),
    publish_batch: receipt(h.publish_batch),
    annotate: receipt(h.annotate),
    edit_body: receipt(h.edit_body),
    extract_section: receipt(h.extract_section),
    save_page: receipt(h.save_page),
    create_claim: receipt(h.create_claim),
    create_relationship: receipt(h.create_relationship),
    correct: receipt(h.correct),
    withdraw: receipt(h.withdraw),
    supersede: receipt(h.supersede),
    merge: receipt(h.merge),
    unmerge: receipt(h.unmerge),
    recall: receipt(h.recall),
    resume: receipt(h.resume),
  };
}
