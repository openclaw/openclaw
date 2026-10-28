import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { Type } from "typebox";
import {
  AttachInput,
  AttachFileInput,
  AttachOutput,
  AttachmentInput,
  AttachmentOutput,
} from "./attachment-contract.js";
import { EditBodyInput } from "./body-edit-contract.js";
import {
  TimelineInput,
  DayInput,
  SinceInput,
  LastSeenInput,
  ChronicleOutput,
  LastSeenOutput,
  TemporalFilters,
} from "./chronicle-contract.js";
import { ConnectionsInput, ConnectionsOutput } from "./connections-contract.js";
import { EvidenceReadInput, EvidenceReadOutput } from "./evidence-read-contract.js";
import {
  ReconcileEvidenceInput,
  ReconcileEvidenceOutput,
} from "./evidence-reconciliation-contract.js";
import {
  BatchInput,
  SourceCheckInput,
  SourceCheckOutput,
  VerifyInput,
  VerifyOutput,
} from "./ingestion-contract.js";
import {
  RecordInput,
  RecordOutput,
  OntologyInput,
  OntologyOutput,
  CardSummary,
  Summary,
} from "./inspection-contract.js";
import { MaintenanceStatus } from "./maintenance-contract.js";
import { text } from "./model.js";
import {
  AnnotateInput,
  ExtractSectionInput,
  SavePage,
  ClaimInput,
  RelationshipInput,
  CorrectInput,
  WithdrawInput,
  MergeInput,
  UnmergeInput,
  SupersedeInput,
  RecallInput,
  Receipt,
  HistoryEntry,
  GitStatus,
  requestId,
} from "./mutation-contract.js";
import { HUB_PAGE_BUDGET_CHARS, PAGE_BUDGET_CHARS } from "./page-budget.js";
import { QueryFreshness } from "./query-freshness.js";
import { RecentInput, RecentOutput } from "./recent.js";
import { RelinkInput, RelinkOutput } from "./relink-contract.js";
import { RememberInput, RememberOutput } from "./remember-contract.js";
import {
  SearchInput,
  ToolSearchOutput,
  LookupInput,
  ToolLookupOutput,
} from "./retrieval-contract.js";
import { withSearchDetail } from "./search-detail.js";
import { SessionActivityInput, SessionActivityOutput } from "./session-activity.js";
import {
  AgentProxyInput,
  StoreState,
  StoresChangeInput,
  StoresChangeOutput,
  StoresSnapshot,
} from "./stores-contract.js";
import { TextWindowInput, TextWindowContent, RecoveryContent } from "./text-window-contract.js";

const empty = Type.Object({}, { additionalProperties: false });
const issue = Type.Object({ path: text(500), code: text(80), message: text(1000) });
const record = CardSummary;
const chars = (n: number) => n.toLocaleString("en-US");
const BUDGET_NOTE = ` Page bodies have a size budget: ${chars(HUB_PAGE_BUDGET_CHARS)} characters for hub pages (the most-linked pages), ${chars(PAGE_BUDGET_CHARS)} otherwise. Growth past it returns a receipt with state=rejected and budget (sizes, hub degree, largest sections, connected candidates) and saves nothing; same-size and shrinking edits always succeed. Extract sections with knowledge_extract_section; claims are never limited.`;
const issues = Type.Array(issue, { maxItems: 1000 });
const MergeCandidate = Type.Object(
  {
    type: text(64),
    key: text(200),
    strength: Type.Union([Type.Literal("identity-key"), Type.Literal("title")]),
    pages: Type.Array(
      Type.Object({ id: text(96), title: text(200) }, { additionalProperties: false }),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
export const contract = defineFeatureContract({
  pluginId: "knowledge",
  operations: {
    timeline: {
      kind: "query",
      description:
        "Chronological structured records, optionally scoped to an entity page ID and date range. Defaults to occurrence time; choose recorded_at/updated_at for when Knowledge changed or due_at for commitments. No dates inferred from prose or ingestion. Explicit source-event claims fold matching meeting pages. Unknown dates excluded. Follow nextOffset with the same filters and returned snapshot; restart on change.",
      input: TimelineInput,
      output: ChronicleOutput,
      tool: { name: "knowledge_timeline", label: "Read knowledge timeline" },
    },
    chronicle_day: {
      kind: "query",
      description:
        "Events and dated assertions on a YYYY-MM-DD day, or its Monday–Sunday week. Timestamp days use timezone (IANA, default UTC); date-only records stay on their authored calendar day. Optional entity ID/kind filters. Structured dates only. Page using nextOffset and snapshot.",
      input: DayInput,
      output: ChronicleOutput,
      tool: { name: "knowledge_chronicle_day", label: "What happened on this day" },
    },
    chronicle_since: {
      kind: "query",
      description:
        "Structured events and dated assertions occurring on/after since, optionally through until, oldest first. This is world time, not newly imported content; use timeline timeField=recorded_at/updated_at for storage time. Dates use UTC query boundaries. Page with nextOffset and snapshot.",
      input: SinceInput,
      output: ChronicleOutput,
      tool: { name: "knowledge_chronicle_since", label: "What happened since" },
    },
    chronicle_last_seen: {
      kind: "query",
      description:
        "Find the latest dated context for an entity before an occurrence cutoff, at or before occurredOnOrBefore (default now). A dated mention is not proof of a meeting or physical interaction. Null means no eligible dated record, not proof of no contact. Undated prose is not inferred.",
      input: LastSeenInput,
      output: LastSeenOutput,
      tool: { name: "knowledge_chronicle_last_seen", label: "Latest dated entity context" },
    },

    session_activity: {
      kind: "query",
      description:
        "Operator-only session activity inspection. Current eligible records only; reads are best effort, writes retain original host session provenance.",
      input: SessionActivityInput,
      output: SessionActivityOutput,
    },
    verify: {
      kind: "query",
      description:
        "Verify up to 100 published records in one bounded structural check: current eligibility, retained evidence, references, reconciled indexing and supplied expectations. Expected revision/hash and owner/dates/source_page/from/to/label compare exactly; null asserts absence, omitted skips. expectedEntities/expectedDependencies require membership, allowing extras. expectedLinks requires authored links resolving to supplied IDs, optionally at an exact resolver href; automatic backlinks do not count. Derive expectations from intended work, not saved output. Returns counts and exceptions only (20/page, max 50); follow nextOffset with unchanged records and snapshot. Does not evaluate meaning, speaker attribution, chronology, quote wording or source completeness.",
      input: VerifyInput,
      output: VerifyOutput,
      tool: { name: "knowledge_verify", label: "Verify knowledge publication" },
    },
    source_check: {
      kind: "query",
      description:
        "Check a provider/source key plus exact retained-byte SHA-256 before repeat ingestion. Returns missing, unchanged or changed and the latest scoped batch receipt, even if publication needs recovery. Does not search legacy individual publications, infer semantic equivalence, or prove outputs remain current. Verify returned IDs; never resurrect inactive records. Changed bytes require explicit reconciliation against the prior requestId.",
      input: SourceCheckInput,
      output: SourceCheckOutput,
      tool: { name: "knowledge_source_check", label: "Check ingested source" },
    },
    publish_batch: {
      kind: "action",
      description:
        "Publish 1–25 items; max 1 MiB. Unique item keys: 1–40 characters, start with lowercase a-z, then only a-z, 0-9, _ or - (e.g. morgan_hale, not MorganHale). Refs must match keys exactly. Batch-level UUID, vault ID, ontology hash. Refs: @key; body links: [[@key|label]]. Upload evidence first; no inline source. Page edit: existing id + revision + hash. Arrays/fields replace; omitted preserves. Validate all, then journal. Retry: same UUID + payload, or knowledge_resume. Source unchanged: old receipt; new payload ignored. Source changed: reconcile, set expectedPreviousRequestId. Receipt state/Git applies to all items. No dedup, correction or rollback." +
        BUDGET_NOTE,
      input: BatchInput,
      output: Receipt,
      tool: { name: "knowledge_publish_batch", label: "Publish knowledge batch" },
    },
    reconcile_evidence: {
      kind: "action",
      description:
        "Explicit revision/hash/vault/ontology-fenced source representation migration or reviewed current-page evidence reconciliation. Run dryRun=true first, inspect byte counts, then dryRun=false with current fences. Omit evidence to preserve associations; supplied evidence replaces only an active page current set, retaining annotation support. Preserve Timeline support after reading it; no removal inferred from prose. Originals, descriptors and historical revisions are never deleted. expanded restores full descriptors as a new revision, not a binary downgrade. Body and unrelated metadata are unchanged. Retry identical mutation UUID/payload after uncertainty.",
      input: ReconcileEvidenceInput,
      output: ReconcileEvidenceOutput,
      tool: { name: "knowledge_reconcile_evidence", label: "Reconcile knowledge evidence" },
    },
    annotate: {
      kind: "action",
      description:
        "Revision-fenced, evidence-backed metadata annotation without changing assertion text or lifecycle. Set source-page association, identity uncertainty/candidates, speaker-attribution confidence, continuity links, or explicit fixture classification; replace a claim's linked entity pages (entities); append retained evidence to an unchanged assertion. Omitted fields are preserved; supplied arrays replace. Only fixture classification may change historical records. Similarity is not supersession, candidate identity is not a merge, and source grouping is not an ingestion batch. Inspect the target and evidence first; a reason and exact revision/hash are required.",
      input: AnnotateInput,
      output: Receipt,
      tool: { name: "knowledge_annotate", label: "Annotate knowledge context" },
    },
    recent: {
      kind: "query",
      description:
        "Read scoped activity with one item per published correction/withdrawal. Cursor paging pins an upper history sequence; current eligibility is rechecked on every read. Inactive assertion content stays in explicit history. Imports are observations, not inferred creations.",
      input: RecentInput,
      output: RecentOutput,
    },
    attach: {
      kind: "action",
      description:
        "Programmatic byte upload: prefer knowledge_attach_file for host-workspace originals. Otherwise chain authorized file-reading/encoding results directly into knowledge_attach; never regenerate, print or copy base64 through a model or child agent. This is upload, not knowledge_attachment (read). Retain an original source file in the authorized vault scope. Generate a distinct lowercase UUID requestId per file, never a filename/source ID and never shared by different files. Send base64 chunks of up to 48 KiB decoded, sequential byte offsets, the same requestId/filename/attribution for all chunks, and final=true on the last chunk. Retry identical chunks after interruption. No total file-size or evidence-count cap. A complete receipt returns evidence to append via save_page.attachments. Uploading alone does not create a page. No local filesystem path is accepted.",
      input: AttachInput,
      output: AttachOutput,
      tool: { name: "knowledge_attach", label: "Attach knowledge source file" },
    },
    attach_file: {
      kind: "action",
      description:
        "Retain a host-workspace original without copying bytes through the model. Supply filePath within the host-selected workspace, observed sha256, fresh lowercase UUID requestId, filename and attribution; retain expectedVaultId from status. Streams bounded chunks internally and returns only the normal attachment receipt. Reuse identical arguments to resume/replay. Rejects aliases, workspace escapes and sandbox paths. For remote bytes use programmatic knowledge_attach, never model-generated base64. Upload alone does not publish a page; append returned evidence to save_page.attachments.",
      input: AttachFileInput,
      output: AttachOutput,
      tool: { name: "knowledge_attach_file", label: "Attach workspace source file" },
    },
    evidence_read: {
      kind: "query",
      description:
        "Read a retained source passage as UTF-8 text using a locator from search or record inspection. Supply record id/path/sha256; optional inclusive line bounds. Continue with nextCursor and the same id/path/hash until null: that completes the passage, not just the citation list. Reauthorizes and verifies source bytes each call. CRLF is normalized to LF. Binary sources use knowledge_attachment. Verification checks bytes/ranges, not interpretation.",
      input: EvidenceReadInput,
      output: EvidenceReadOutput,
      tool: { name: "knowledge_evidence_read", label: "Read source passage" },
    },
    attachment: {
      kind: "query",
      description:
        "DOWNLOAD retained bytes: use knowledge_attachment, not knowledge_attach (upload). Read the original bytes of a file referenced by an authorized record. Supply the evidence path and sha256 from knowledge_record. Returns a base64 chunk; follow nextOffset until null. Binary files are preserved without text conversion. No arbitrary filesystem paths or unreferenced files are exposed.",
      input: AttachmentInput,
      output: AttachmentOutput,
      tool: { name: "knowledge_attachment", label: "Read knowledge source file" },
    },
    edit_body: {
      kind: "action",
      description:
        "Edit one exact active-page body range without resending the record. Read knowledge_record view=content first; start inclusive/end exclusive are UTF-16 offsets in the full body (not raw Markdown/frontmatter). start=end inserts, empty replacement deletes. Maximum replacement 48,000 characters; complete request remains bounded. Mandatory observed vault/revision/hash/ontology fences reject stale edits. Preserves unrelated metadata/evidence; publishes a normal revision/history/receipt. The complete UTF-8 record including frontmatter must fit 5,000,000 bytes. Reuse identical requestId/payload after uncertainty; no implicit rebasing or fuzzy matching." +
        BUDGET_NOTE,
      input: EditBodyInput,
      output: Receipt,
      tool: { name: "knowledge_edit_body", label: "Edit knowledge body" },
    },
    extract_section: {
      kind: "action",
      description:
        "Move one heading section of an active page to a new page or an existing connected page (linked either way or by a typed relationship) in one fenced publication. Use it to shrink a page over its body budget instead of truncating. The section moves verbatim, links still resolve, and source evidence it quotes or names is carried. The source keeps the heading plus your one-line summary and a link to the destination. Claims the section links to that name the source as a subject get the destination as primary subject and keep their existing subjects; remove the source with knowledge_annotate entities when it no longer applies. Supply sectionStart (heading offset) from a budget rejection or fresh read and fresh source/destination fences. Nothing changes unless every record validates. Reuse identical requestId/payload after uncertainty.",
      input: ExtractSectionInput,
      output: Receipt,
      tool: { name: "knowledge_extract_section", label: "Extract knowledge section" },
    },
    save_page: {
      kind: "action",
      description:
        "Create or edit a page in the authorized scope. requestId must be a generated lowercase UUID, never a source ID or slug; it may be omitted only during a host pre-compaction memory flush, when Knowledge derives it from the flush ID and normalized title. Creates omit id/expectedRevision/expectedHash; edits require all three from knowledge_record. Reuse requestId and identical payload for retries; inspect knowledge_mutation after an uncertain result. Calls share a serialized service lane, not a multi-record transaction. Aliases, tags, dependencies and fields replace their collections when supplied (empty clears); omission preserves on edit. Optional expectedOntologyFingerprint fences the observed schema. Append file evidence returned by knowledge_attach using attachments (no count cap). Legacy source text remains supported; saved pages are immediately available with no approval step. A published receipt is a completed save; accepted publication conflicts retain recovery material and block publication. Requests rejected before acceptance are not saved." +
        BUDGET_NOTE,
      input: SavePage,
      output: Receipt,
      tool: { name: "knowledge_save_page", label: "Save knowledge page" },
    },
    remember: {
      kind: "action",
      description:
        "Cheapest durable save: 1–20 claims (decision, preference, commitment, fact, event, belief) in one call, no search or readback needed. Give short attribution and the supporting conversation excerpt; it is retained as their evidence. Optional subject (exact page ID, title or alias) links each claim to a uniquely matching page; otherwise it is saved unlinked and reported. Never creates pages. Exact repeats return duplicate with the saved claim. One claim per item; never agent inference. Commitments are not scheduled. Use knowledge-capture to revise page prose.",
      input: RememberInput,
      output: RememberOutput,
      tool: { name: "knowledge_remember", label: "Remember knowledge" },
    },
    relink: {
      kind: "action",
      description:
        "Link remembered claims saved without a subject to the one entity page each names, in this store partition only. Zero-LLM: the claim's recorded source page if it is an entity, else exactly one entity page named by ID, title or alias with no competing name; ambiguous and unnamed claims stay unlinked. Run dryRun=true first to review counts and examples; follow nextCursor. Each link is an entities annotation; claim text, evidence and lifecycle are unchanged.",
      input: RelinkInput,
      output: RelinkOutput,
      tool: { name: "knowledge_relink", label: "Relink remembered claims" },
    },
    create_claim: {
      kind: "action",
      description:
        "Publish one evidence-backed claim (fact, preference, decision, commitment, event or belief). Agent chooses what the source supports; no automatic extraction or semantic deduplication. Required current ontology fingerprint comes from knowledge_ontology. Explicit attribution and assertion_origin distinguish source statements, user beliefs and agent inference. Unknown owner/dates remain absent. occurred_at and due_at preserve date-only or offset timestamp precision; validity/expiry are UTC instants. No task is scheduled. Reuse the exact request and payload for retries; no claim overwrite or lifecycle mutation.",
      input: ClaimInput,
      output: Receipt,
      tool: { name: "knowledge_create_claim", label: "Create knowledge claim" },
    },
    create_relationship: {
      kind: "action",
      description:
        "Publish one directed, evidenced relationship between existing active pages. Inspect knowledge_ontology for label, fields, endpoint constraints and required current fingerprint. Attribution and nonempty retained evidence are mandatory. Same endpoint pair is not automatically merged. Exact retries reuse the receipt. Markdown links are not asserted relationships.",
      input: RelationshipInput,
      output: Receipt,
      tool: { name: "knowledge_create_relationship", label: "Create knowledge relationship" },
    },
    correct: {
      kind: "action",
      description:
        "Agent-only explicit correction of an exact claim or typed relationship. Inspect the target's revision/hash and current ontology first. Publish a complete evidence-backed replacement of the same kind and supersede the original in one recoverable logical mutation. User correction evidence may be retained with knowledge_attach. Reason is required; contradiction alone is not authorization. Same request/payload returns the same receipt; pending/conflicted publication blocks reads. Receipt includes original/replacement IDs and known unresolved dependencies; no automatic propagation rewrite or erasure.",
      input: CorrectInput,
      output: Receipt,
      tool: { name: "knowledge_correct", label: "Correct knowledge" },
    },
    withdraw: {
      kind: "action",
      description:
        "Agent-only withdrawal of one exact page, claim, or explicit relationship by ID, observed revision/hash, and reason. Preserves original/evidence/history; not physical erasure. A durable tombstone prevents stale restores from resurrecting the record. Active retrieval excludes known dependents without rewriting them. Withdraw an edge by its record ID, never by endpoint pair. Reuse identical request/payload for retries.",
      input: WithdrawInput,
      output: Receipt,
      tool: { name: "knowledge_withdraw", label: "Withdraw knowledge" },
    },
    supersede: {
      kind: "action",
      description:
        "Agent-only: mark 1–25 earlier active claims superseded by one existing current claim, such as status snapshots replaced by their outcome or a claim a later one explicitly corrects, without writing a new copy (knowledge_correct publishes a new replacement). Each earlier claim keeps its text, evidence and history and gets superseded_by plus the reason; the superseding claim is not rewritten. Every claim must share a linked page with the superseding one; link them first. No self-supersession; already superseded or withdrawn claims are rejected. Default reads exclude superseded claims; historical reads and knowledge_history keep them. undo=true restores claims this tool superseded by the same claim. Supply current revision/hash fences and a reason. Reuse identical request/payload for retries.",
      input: SupersedeInput,
      output: Receipt,
      tool: { name: "knowledge_supersede", label: "Supersede claims" },
    },
    merge: {
      kind: "action",
      description:
        "Agent-only identity merge of two pages of the same type confirmed to be one entity (the user said so, or a source states it). The absorbed page becomes merged and its ID resolves to the survivor everywhere: claims, relationships, links, Timeline and lookups that name it count toward the survivor, and nothing is rewritten. The survivor gains the absorbed title and aliases, tags, missing fields and evidence; its own field values win (conflicts are reported). Supply both pages' current revision/hash from knowledge_record, a reason, optional retained identity evidence, and optionally a new title or a combined body (bodies are never merged automatically). Never merge on name similarity alone; see knowledge_diagnostics mergeCandidates. Undo with knowledge_unmerge. Reuse identical request/payload for retries. A combined body is subject to the page budget.",
      input: MergeInput,
      output: Receipt,
      tool: { name: "knowledge_merge", label: "Merge duplicate pages" },
    },
    unmerge: {
      kind: "action",
      description:
        "Agent-only undo of one knowledge_merge. The merged page becomes active again with its own ID, and the survivor loses the aliases, tags, fields and evidence that merge added (fields edited since are kept). A body or title written during the merge is not reverted. Supply both pages' current revision/hash and a reason. Reuse identical request/payload for retries.",
      input: UnmergeInput,
      output: Receipt,
      tool: { name: "knowledge_unmerge", label: "Undo a page merge" },
    },
    recall: {
      kind: "action",
      description:
        "Owner-private agent tool for explicit automatic-recall approval. Set a short summary plus optional trigger phrases, importance and host project keys on one exact active record; the service supplies approval identity/time. Source and agent-inference claims cannot be approved. Clear removes recall metadata. Revision/hash preconditions and exact request replay use the normal publication receipt and local Git checkpoint path. Corrections do not inherit approval.",
      input: RecallInput,
      output: Receipt,
      tool: { name: "knowledge_recall", label: "Curate automatic recall" },
    },
    connections: {
      kind: "query",
      description:
        "Inspect connections: incoming/outgoing typed relationships, dependents, claims, authored Markdown links and derived backlinks. Default compact view returns identities, directions, endpoints and identity/attribution uncertainty; no evidence or card bodies. Use view=full for metadata and evidence previews, includeCards for claim prose (full only), includeEndpoints for deduplicated endpoint identities. Read knowledge_record for complete provenance. A backlink is derived navigation, not an authored reverse link. Default 20 rows, max 100; complete responses are byte-bounded and may return fewer. Follow nextOffset and compare snapshot, keeping filters/view unchanged. Access and active eligibility precede counts/pagination. historical=true includes inactive/superseded, never withdrawn records.",
      input: ConnectionsInput,
      output: ConnectionsOutput,
      tool: { name: "knowledge_connections", label: "Inspect knowledge connections" },
    },
    resume: {
      kind: "action",
      description:
        "Resume an accepted publication or retry its local Git checkpoint in the authorized scope after interruption. Does not overwrite conflicts. Use the original requestId.",
      input: Type.Object({ requestId }, { additionalProperties: false }),
      output: Receipt,
      tool: { name: "knowledge_resume", label: "Resume knowledge publication" },
    },
    revision: {
      kind: "query",
      description:
        "Read a retained revision snapshot from authorized history by sequence. The snapshot is historical, not current knowledge. Follow content.nextOffset with offset and the same sequence; maxChars is a window, not file capacity.",
      input: Type.Object(
        { sequence: Type.Integer({ minimum: 1 }), ...TextWindowInput },
        { additionalProperties: false },
      ),
      output: Type.Object({
        raw: Type.Union([text(65536), Type.Null()]),
        content: Type.Union([TextWindowContent, Type.Null()]),
      }),
      tool: { name: "knowledge_revision", label: "Inspect knowledge revision" },
    },
    mutation: {
      kind: "query",
      description:
        "Inspect publication recovery, not source uploads or record content. Use includeFiles=false for receipt-only checks; retained before/proposed/displaced files default to 3/page with nextOffset for batches. Each file has bounded before/proposed/displaced windows with content nextOffset/totalChars. Keep the file offset fixed and use contentField (default proposed) plus charOffset to continue one text field. Compare its content hash across pages; restart on change. A null receipt means no accepted page/assertion mutation was found in this scope; it is not an upload receipt. After an uncertain result, replay the original payload/ID, not a replacement request. Does not resolve or overwrite a conflict.",
      input: Type.Object(
        {
          requestId,
          contentField: Type.Optional(
            Type.Union([
              Type.Literal("before"),
              Type.Literal("proposed"),
              Type.Literal("displaced"),
            ]),
          ),
          charOffset: TextWindowInput.offset,
          maxChars: TextWindowInput.maxChars,
          includeFiles: Type.Optional(Type.Boolean()),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
        },
        { additionalProperties: false },
      ),
      output: Type.Object({
        totalFiles: Type.Optional(Type.Integer()),
        nextOffset: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
        receipt: Type.Union([Receipt, Type.Null()]),
        files: Type.Array(
          Type.Object({
            path: text(500),
            before: Type.Union([text(65536), Type.Null()]),
            proposed: text(65536),
            displaced: Type.Union([text(65536), Type.Null()]),
            content: RecoveryContent,
          }),
          { maxItems: 3 },
        ),
      }),
      tool: { name: "knowledge_mutation", label: "Inspect knowledge publication" },
    },
    history: {
      kind: "query",
      description:
        "Inspect authorized mutation receipts and observed revision history, including pending/conflict states. Not keyword search.",
      input: Type.Object(
        {
          id: Type.Optional(text(96)),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        },
        { additionalProperties: false },
      ),
      output: Type.Object({
        git: GitStatus,
        entries: Type.Array(HistoryEntry, { maxItems: 50 }),
        mutations: Type.Array(Receipt, { maxItems: 50 }),
        nextOffset: Type.Union([Type.Integer(), Type.Null()]),
      }),
      tool: { name: "knowledge_history", label: "Knowledge history" },
    },
    status: {
      kind: "query",
      description:
        "Read availability and counts for the authorized scope of this agent's knowledge store.",
      input: empty,
      output: Type.Object(
        {
          service: Type.Literal("knowledge"),
          phase: Type.Union([
            Type.Literal("read-only-explorer"),
            Type.Literal("page-editor"),
            Type.Literal("structured-writes"),
          ]),
          limits: Type.Object({
            recordBytes: Type.Integer(),
            bodyInputChars: Type.Integer(),
            textPageChars: Type.Integer(),
            recordResponseBytes: Type.Integer(),
          }),
          backendRevision: text(80),
          instanceId: text(80),
          startedAt: text(40),
          checkedAt: text(40),
          snapshot: Type.Optional(text(64)),
          vault: text(80),
          agent: text(80),
          store: StoreState,
          message: Type.Optional(text(300)),
          scope: text(80),
          writesEnabled: Type.Boolean(),
          live: Type.Union([
            Type.Literal("stopped"),
            Type.Literal("watching"),
            Type.Literal("unavailable"),
          ]),
          records: Type.Integer(),
          validRecords: Type.Integer(),
          definitions: Type.Integer(),
          ontologyAvailable: Type.Boolean(),
          ontologyFingerprint: text(64),
          issues: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      tool: { name: "knowledge_status", label: "Knowledge status" },
    },
    grep: {
      kind: "query",
      description:
        "Find records by words in titles, aliases and bodies. Use for discovery when the exact identity is unknown. Rank authorized valid knowledge by title/alias/body keywords with SQLite FTS5. Default: all word tokens, active records. Saved pages need no approval. mode=any ORs literal words; mode=phrase matches their order. No raw FTS/regex operators. lifecycle=superseded/all includes history, never withdrawn records. Filters apply before ranking. Agents get compact hits (id, title, type, path, revision, short snippet, matched fields; default limit 10); detail=full adds revision/hash citations, body line locators, score, attribution and evidence. index.state=unavailable and total=null mean failed retrieval, not no matches. Compare index.snapshot across pages; restart on changes. Not exhaustive inventory: use knowledge_records. No embeddings.",
      input: withSearchDetail(SearchInput),
      output: ToolSearchOutput,
      tool: { name: "knowledge_grep", label: "Search knowledge" },
    },
    lookup: {
      kind: "query",
      description:
        "Resolve a known exact ID, full title or alias. This is not keyword search; use knowledge_grep for discovery and after a missing result. No keyword-search fallback. Resolve that exact identity in the trusted scope; returns found, ambiguous or missing without choosing an ambiguous identity. Names/aliases normalize Unicode, case and whitespace; IDs are case-sensitive. Active records by default, with no approval step; historical filters are explicit. Invalid, withdrawn and unavailable dependencies are excluded. Independent of keyword indexing. Use knowledge_record for full inspection and knowledge_records for exhaustive listing.",
      input: withSearchDetail(LookupInput),
      output: ToolLookupOutput,
      tool: { name: "knowledge_lookup", label: "Resolve knowledge identity" },
    },
    records: {
      kind: "query",
      description:
        "List current eligible authorized records exhaustively using pagination, with optional kind, ontology type/alias, or ID/title/alias filtering. lifecycle=all is an explicit historical inventory including inactive/invalid records; originals remain available by exact record/history inspection. includeCards adds bounded claim text and card metadata from the same scan, without evidence excerpts. includeEndpoints adds deduplicated current eligible relationship endpoint summaries for this page from the same authorized scan. Responses are bounded by bytes and nested values and may return fewer rows than requested; follow nextOffset, not offset+limit. Oversized individual cards fall back to clickable summaries; use knowledge_record for full content.",
      input: Type.Object(
        {
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          kind: Type.Optional(
            Type.Union([Type.Literal("page"), Type.Literal("claim"), Type.Literal("relationship")]),
          ),
          includeCards: Type.Optional(Type.Boolean()),
          includeEndpoints: Type.Optional(Type.Boolean()),
          ...TemporalFilters,
          assertionOrigin: Type.Optional(text(30)),
          type: Type.Optional(text(64)),
          query: Type.Optional(text(200)),
          lifecycle: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("all")])),
        },
        { additionalProperties: false },
      ),
      output: Type.Object({
        records: Type.Array(record, { maxItems: 100 }),
        endpoints: Type.Optional(Type.Array(Summary, { maxItems: 200 })),
        total: Type.Integer(),
        offset: Type.Integer(),
        nextOffset: Type.Union([Type.Integer(), Type.Null()]),
        freshness: QueryFreshness,
        facets: Type.Optional(
          Type.Object({
            kinds: Type.Record(Type.String(), Type.Integer()),
            origins: Type.Record(Type.String(), Type.Integer()),
          }),
        ),
      }),
      tool: { name: "knowledge_records", label: "Browse knowledge" },
    },
    record: {
      kind: "query",
      description:
        "Read one saved record by stable ID. Read source passages with knowledge_evidence_read. Default content returns body once (up to 12,000 chars), revision/hash, attribution, uncertainty and compact structured metadata (owner/dates/associations/endpoints); no evidence arrays. Use knowledge_verify for aggregate structural checks. metadataView=full for arbitrary ontology fields and complete frontmatter before replacing fields; none for text only. Legacy includeMetadata true/false means full/none; cannot combine selectors. includeEvidence=true for verified citation locators and excerpts (4,000 chars total); paginate evidenceOffset/evidenceLimit with nextEvidenceOffset. includeReferences=true for paged connected summaries. view=summary omits body; raw returns original Markdown instead. Complete JSON is byte-bounded: follow content.nextOffset, nextReferenceOffset and nextEvidenceOffset; compare record hashes across pages. omitted lists supplemental previews excluded to fit; use connections, attachments or paged raw for complete detail. Oversized metadata/evidence errors explicitly; raw+metadataView=none without evidence/references is the text fallback. Missing/duplicate IDs return null. Never edit from truncated body.",
      input: RecordInput,
      output: RecordOutput,
      tool: { name: "knowledge_record", label: "Inspect knowledge" },
    },
    ontology: {
      kind: "query",
      description:
        "Inspect authorized ontology with progressive detail. Default catalog lists concise types, descriptions, aliases and counts (50/page). Use view=definitions with name for structured authoring fields, endpoint constraints and provenance (10/page); no serialized duplicate. includeRecords adds up to 20 examples/type; use knowledge_records for exhaustive records. view=sources lists source paths; add sourcePath for YAML only when debugging/editing a source, bounded by maxChars (12,000 default). view=diagnostics pages issues. Follow nextOffset using the same view/filters; source offsets are characters, other offsets are items. Behavior flags describe definitions, not implemented workflows.",
      input: OntologyInput,
      output: OntologyOutput,
      tool: { name: "knowledge_ontology", label: "Inspect ontology" },
    },
    diagnostics: {
      kind: "query",
      description:
        "Read current authorized-scope validation findings and merge candidates. mergeCandidates groups current pages of one type that share an identity-key alias such as discord:<id> (strong) or a title (weak); confirm identity before calling knowledge_merge. Not a mutation or ingestion history. Files are never repaired or rewritten.",
      input: empty,
      output: Type.Object({
        issues,
        total: Type.Integer(),
        truncated: Type.Boolean(),
        checkedAt: text(40),
        mergeCandidates: Type.Optional(Type.Array(MergeCandidate, { maxItems: 100 })),
      }),
      tool: { name: "knowledge_diagnostics", label: "Vault diagnostics" },
    },
    maintenance_status: {
      kind: "query",
      description:
        "Operator view of the scheduled maintenance pass: schedule, next run, and the last pass per store.",
      input: empty,
      output: MaintenanceStatus,
    },
    stores_snapshot: {
      kind: "query",
      description:
        "Operator settings: agents, effective store assignments and store inventory. Never creates storage.",
      input: empty,
      output: StoresSnapshot,
    },
    stores_change: {
      kind: "action",
      description:
        "Operator settings: change one agent's store assignment (share its store, use a shared store, or use its own). Requires operator admin access and the current settings revision.",
      input: StoresChangeInput,
      output: StoresChangeOutput,
    },
    stores_change_status: {
      kind: "query",
      description:
        "Operator settings: reconcile and report the outcome of an assignment change by request ID.",
      input: Type.Object({ requestId }, { additionalProperties: false }),
      output: StoresChangeOutput,
    },
    agent_query: {
      kind: "query",
      description:
        "Operator inspection: run one read operation against a selected agent's effective store.",
      input: AgentProxyInput,
      output: Type.Unknown(),
    },
    agent_action: {
      kind: "action",
      description:
        "Operator inspection: run one operator-permitted change against a selected agent's effective store.",
      input: AgentProxyInput,
      output: Type.Unknown(),
    },
  },
  events: { changed: Type.Object({}, { additionalProperties: false }) },
});
