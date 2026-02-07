# Meridia V2: Refined Implementation Plan

## Evaluation of Original Proposal

The original V2 proposal correctly identifies the central problem: **the architecture docs describe a rich 14-component system, but the implementation only covers a fraction of it.** The schema defines emotional signatures, engagement quality, anchors, uncertainties, and reconstitution hints—all unused in practice.

However, the proposal has several issues that this refined plan addresses:

### What the proposal gets right

1. **Problem diagnosis.** The gap between `experiential-record.schema.json` and what `evaluate.ts` actually extracts is real and significant.
2. **Phased approach.** Activating existing schema fields before adding new infrastructure is the correct order.
3. **Reconstitution upgrade.** Moving from bullet lists to state-restoration prose is valuable.
4. **Multi-store persistence.** SQLite primary, graph/vector as optional indices aligns with the existing ARCH.md design.

### What the proposal gets wrong or misses

**1. It reinvents the existing architecture docs.**
ARCH.md and COMPONENT-MAP.md already describe the target system in detail—14 components, typed contracts (`MeridiaEvent`, `CaptureDecision`, `Phenomenology`, `ArtifactRef`, `ExperienceKit`), a proposed directory structure, and deep-dive docs for each component. The V2 proposal restates much of this without referencing it.

**Refined approach:** Build on the existing component map. Don't redesign—implement what's already designed.

**2. Real-time Graphiti push per tool result is wrong.**
The proposal suggests pushing every experience to Graphiti immediately. This is problematic:
- Adds latency to every capture (Graphiti ingestion is not fast)
- Individual tool results are noisy; synthesized episodes are higher quality
- The compaction hook already does episode synthesis + entity extraction + Graphiti ingest
- Neo4j write load scales with capture volume

**Refined approach:** Keep compaction-based graph sync but make it more frequent and incremental. Add a "mini-compaction" that runs on session-end (or every N captures) instead of only on scheduled compaction events.

**3. The proposed LLM extraction prompt is too expensive for every tool result.**
Full phenomenological extraction (emotions, anchors, uncertainties, engagement quality, reconstitution hints) via LLM on every tool result is:
- Slow (the current LLM eval already has a 3.5s timeout)
- Expensive (doubles or triples token usage per evaluation)
- Unnecessary for low-significance events

**Refined approach:** Two-pass evaluation.
- Pass 1 (every event): Heuristic + optional lightweight LLM scoring (existing). Decides capture/skip and produces score + reason.
- Pass 2 (captured events only, score >= threshold): Full phenomenological extraction via LLM. Only runs on events that pass the capture gate, amortizing cost over ~10 events/hour max.

**4. pgvector adds a hard infrastructure dependency.**
PostgreSQL + pgvector changes the deployment story from "SQLite file, works anywhere" to "needs a running Postgres instance." The proposal acknowledges this as an open question but doesn't resolve it.

**Refined approach:** Use an embedding adapter interface. Start with the existing Graphiti service (which already has vector search via Neo4j's vector index). Add pgvector as an optional backend behind the adapter when Postgres is configured. This means vector search works with what's already running (Graphiti) while allowing pgvector as an upgrade path.

**5. Missing components the proposal ignores.**
The COMPONENT-MAP defines 14 components. The proposal covers 4 (evaluation, persistence, graph, reconstitution) but doesn't mention:
- Component 1: Event Normalizer (currently duplicated parsing in hooks)
- Component 2: Gates and Budget Manager (currently inline in capture hook)
- Component 5: Artifact and Reference Collector (media, files, links)
- Component 8: Trace and Audit Stream (partially implemented)
- Component 12: Sanitization and Redaction Guard
- Component 14: Observability

**Refined approach:** Include the normalizer and gates extraction in Phase 1 as prerequisite refactoring. They're small and unblock clean integration of the new components.

**6. The `ExperienceKit` type exists but isn't used.**
COMPONENT-MAP defines `ExperienceKit` as the canonical record type (with `phenomenology`, `artifacts`, `links`, `version`). The actual code still uses `MeridiaExperienceRecord` which has a flatter structure with `content.facets` instead of proper `Phenomenology`.

**Refined approach:** Migrate from `MeridiaExperienceRecord` to `ExperienceKit` as the canonical type. This is the designed target; implement it.

---

## Refined Architecture

### Design Principles

1. **Implement the designed architecture, don't redesign it.** ARCH.md and COMPONENT-MAP.md are the source of truth.
2. **Two-pass evaluation.** Cheap gate decision, expensive phenomenology extraction only for captured events.
3. **Compaction-based graph sync.** No per-event Graphiti writes. Session-end and periodic mini-compaction instead.
4. **Optional infrastructure.** Vector search uses whatever's available (Graphiti vector, pgvector, or nothing).
5. **Evolutionary migration.** `MeridiaExperienceRecord` → `ExperienceKit` with backward compatibility in the SQLite schema.

### Component Implementation Status

| ID | Component                        | Status                | This Plan          |
|----|----------------------------------|-----------------------|--------------------|
|  1 | Event Normalizer                 | Inline in hooks       | Phase 1: Extract   |
|  2 | Gates and Budget Manager         | Inline in hooks       | Phase 1: Extract   |
|  3 | Capture Decision Engine          | Partial (score only)  | Phase 2: Expand    |
|  4 | Phenomenology Extractor          | Not implemented       | Phase 2: Build     |
|  5 | Artifact & Reference Collector   | Not implemented       | Phase 4: Build     |
|  6 | Experience Kit Builder           | Not implemented       | Phase 2: Build     |
|  7 | Canonical Store                  | SQLite working        | Phase 2: Evolve    |
|  8 | Trace and Audit Stream           | Partial               | Phase 1: Complete  |
|  9 | Fanout Dispatcher                | Inline in compaction  | Phase 3: Extract   |
| 10 | Hybrid Retriever and Ranker      | SQLite FTS only       | Phase 3: Build     |
| 11 | Reconstitution Engine            | Bullet list only      | Phase 3: Rebuild   |
| 12 | Sanitization Guard               | Not implemented       | Phase 1: Build     |
| 13 | Schemas and Migrations           | Schema v1 only        | Phase 2: Migrate   |
| 14 | Observability                    | Partial (trace JSONL) | Ongoing            |

---

## Implementation Phases

### Phase 1: Foundation Extraction

**Goal:** Extract inline logic into proper component boundaries without changing behavior. This is pure refactoring—no new features, no schema changes.

#### 1a. Event Normalizer (`src/meridia/event/`)

Extract the event parsing logic currently duplicated in `hooks/experiential-capture/handler.ts` into a typed normalizer.

```ts
// src/meridia/event/normalizer.ts
export function normalizeToolResult(hookEvent: HookToolResultEvent): MeridiaEvent {
  return {
    id: uuid(),
    kind: "tool_result",
    ts: new Date().toISOString(),
    session: { key: hookEvent.sessionKey, id: hookEvent.sessionId },
    tool: {
      name: hookEvent.toolName,
      callId: hookEvent.toolCallId,
      isError: hookEvent.isError,
      meta: hookEvent.meta,
    },
    payload: { args: hookEvent.args, result: hookEvent.result },
    provenance: { source: "hook", traceId: hookEvent.traceId },
  };
}
```

#### 1b. Gates and Budget Manager (`src/meridia/gates/`)

Extract rate limiting from the capture hook into a standalone module.

```ts
// src/meridia/gates/budget.ts
export class BudgetManager {
  check(event: MeridiaEvent, buffer: SessionBuffer, config: GatesConfig): GateResult;
  recordCapture(buffer: SessionBuffer, recordId: string): void;
}

export type GateResult = {
  allowed: boolean;
  reason?: "min_interval" | "max_per_hour" | "budget";
  detail?: string;
};
```

#### 1c. Sanitization Guard (`src/meridia/sanitize/`)

Build the redaction layer before adding richer data extraction.

```ts
// src/meridia/sanitize/redact.ts
export function sanitizeForPersistence(payload: unknown, config: SanitizeConfig): unknown;
export function sanitizeForFanout(kit: ExperienceKit, target: "graph" | "vector"): ExperienceKit;
```

- Strip environment variables, tokens, API keys from tool args/results
- Enforce size limits on stored payloads
- Redact file paths matching configurable patterns

#### 1d. Complete Trace Stream

Ensure every decision (capture, skip, gate-deny, error) produces a trace event. Currently some paths skip tracing.

**Files created:**
- `src/meridia/event/normalizer.ts`
- `src/meridia/event/index.ts`
- `src/meridia/gates/budget.ts`
- `src/meridia/gates/index.ts`
- `src/meridia/sanitize/redact.ts`
- `src/meridia/sanitize/index.ts`

**Files modified:**
- `hooks/experiential-capture/handler.ts` (delegate to normalizer + gates)
- `hooks/session-end/handler.ts` (delegate to normalizer)

**Validation:** All existing tests pass. Behavior is identical. `pnpm test` green.

---

### Phase 2: Phenomenology Activation

**Goal:** Activate the experiential schema fields that are defined but unused. This is where the V2 proposal's core value lives.

#### 2a. Two-Pass Evaluation Architecture

Modify the capture flow to separate gate decisions from phenomenology extraction:

```
Event → Normalize → Gates → Decision (Pass 1: score + reason)
                                ↓ capture?
                           Phenomenology Extraction (Pass 2: full facets)
                                ↓
                           Kit Builder → Persist
```

**Pass 1** (runs on every event, cheap):
- Existing heuristic scorer (multi-factor: novelty, impact, relational, temporal, userIntent)
- Optional lightweight LLM scorer (existing 3.5s timeout, score + reason only)
- Produces `CaptureDecision { shouldCapture, significance, mode, reason }`

**Pass 2** (runs only on captured events, ~10/hour max):
- Full LLM phenomenology extraction
- Timeout: 8s (separate from the gate timeout)
- Fallback: heuristic phenomenology if LLM fails or times out
- Produces `Phenomenology { emotionalSignature, engagementQuality, anchors, uncertainties, reconstitutionHints }`

```ts
// src/meridia/phenomenology/extractor.ts
export async function extractPhenomenology(
  event: MeridiaEvent,
  decision: CaptureDecision,
  config: PhenomenologyConfig,
): Promise<Phenomenology> {
  if (decision.mode === "light" || !config.llmEnabled) {
    return extractHeuristicPhenomenology(event, decision);
  }
  try {
    return await extractLlmPhenomenology(event, decision, config);
  } catch {
    return extractHeuristicPhenomenology(event, decision);
  }
}
```

#### 2b. LLM Phenomenology Prompt

The prompt should be tighter than the original proposal suggests. Avoid open-ended generation; demand structured JSON:

```
Extract experiential facets from this tool interaction.

Tool: {name} | Error: {isError} | Score: {score}
Context: {summarized args + result, max 3000 chars}

Return JSON only:
{
  "emotionalSignature": {
    "primary": ["emotion1"],         // 1-3 from: curious, focused, uncertain, frustrated, satisfied, surprised, concerned, relieved, excited, cautious
    "intensity": 0.0-1.0,
    "valence": -1.0 to 1.0,
    "texture": "word"                // spacious, dense, flowing, turbulent, crystalline, heavy, sharp, warm
  },
  "engagementQuality": "engaged",   // deep-flow|engaged|routine|distracted|struggling
  "anchors": [                      // 1-2 reconstitution anchors
    {"phrase": "concrete phrase from the interaction", "significance": "why this matters", "sensoryChannel": "conceptual"}
  ],
  "uncertainties": [],               // 0-2 open questions
  "reconstitutionHints": []          // 0-2 hints for future self
}
```

#### 2c. Heuristic Phenomenology Fallback

When LLM extraction is unavailable or times out, derive basic phenomenology from event characteristics:

```ts
function extractHeuristicPhenomenology(event: MeridiaEvent, decision: CaptureDecision): Phenomenology {
  const isError = event.tool?.isError ?? false;
  const toolName = event.tool?.name ?? "unknown";

  return {
    emotionalSignature: {
      primary: isError ? ["concerned"] : ["focused"],
      intensity: decision.significance,
      valence: isError ? -0.3 : 0.3,
    },
    engagementQuality: decision.significance > 0.8 ? "engaged" : "routine",
    // No anchors, uncertainties, or hints from heuristics—those require LLM
  };
}
```

#### 2d. ExperienceKit Type Migration

Introduce `ExperienceKit` as the canonical record type per COMPONENT-MAP.md. The SQLite backend stores it as JSON in `data_json` (no schema migration needed for Phase 2—the column already stores arbitrary JSON).

Add new indexed columns for query-able phenomenology fields:

```sql
-- Schema migration v1 → v2
ALTER TABLE meridia_records ADD COLUMN emotional_primary TEXT;    -- JSON array
ALTER TABLE meridia_records ADD COLUMN emotional_intensity REAL;
ALTER TABLE meridia_records ADD COLUMN emotional_valence REAL;
ALTER TABLE meridia_records ADD COLUMN engagement_quality TEXT;

CREATE INDEX idx_meridia_engagement ON meridia_records(engagement_quality);
CREATE INDEX idx_meridia_emotional_intensity ON meridia_records(emotional_intensity);
```

Note: `anchors`, `uncertainties`, and `reconstitutionHints` live in `data_json` (not separate columns) because they're queried via FTS, not via SQL filters.

#### 2e. Kit Builder (`src/meridia/kit/`)

```ts
// src/meridia/kit/builder.ts
export function buildExperienceKit(
  event: MeridiaEvent,
  decision: CaptureDecision,
  phenomenology: Phenomenology | undefined,
  options?: { artifacts?: ArtifactRef[]; sanitize?: boolean },
): ExperienceKit;
```

Assembles the canonical record from decision + phenomenology + optional artifacts.

**Files created:**
- `src/meridia/phenomenology/extractor.ts`
- `src/meridia/phenomenology/heuristic.ts`
- `src/meridia/phenomenology/prompt.ts`
- `src/meridia/phenomenology/index.ts`
- `src/meridia/kit/builder.ts`
- `src/meridia/kit/index.ts`

**Files modified:**
- `src/meridia/types.ts` (add `ExperienceKit`, `Phenomenology`, `CaptureDecision` types from COMPONENT-MAP)
- `src/meridia/evaluate.ts` (refactor to produce `CaptureDecision`)
- `src/meridia/db/backends/sqlite.ts` (schema v2 migration, new columns)
- `hooks/experiential-capture/handler.ts` (integrate two-pass flow)
- `src/tools/experience-capture-tool.ts` (accept phenomenology inputs)

**Validation:** Existing tests pass. New tests for phenomenology extraction (both LLM and heuristic paths). Schema migration tested.

---

### Phase 3: Retrieval and Reconstitution

**Goal:** Enable multi-source retrieval and replace bullet-list reconstitution with state-restoration context packs.

#### 3a. Hybrid Retriever (`src/meridia/retrieve/`)

Blend results from available sources:

```ts
// src/meridia/retrieve/hybrid.ts
export async function hybridRetrieve(
  intent: RetrievalIntent,
  sources: AvailableSources,
): Promise<RankedResult[]> {
  const results: ScoredResult[] = [];

  // Always available: canonical store (SQLite FTS)
  results.push(...await canonicalSearch(intent, sources.canonical));

  // Optional: graph traversal (Graphiti)
  if (sources.graph) {
    results.push(...await graphSearch(intent, sources.graph));
  }

  // Optional: vector similarity (Graphiti vector or pgvector)
  if (sources.vector) {
    results.push(...await vectorSearch(intent, sources.vector));
  }

  return rank(results, intent);
}
```

**Ranking factors** (weighted blend):
- Significance score (from capture decision)
- Semantic similarity (from vector, when available)
- Graph proximity (from Graphiti, when available)
- Recency decay (exponential, configurable half-life)
- Diversity penalty (avoid clustering on same topic/tool)

#### 3b. Vector Search Adapter

Use whatever vector search is available:

```ts
// src/meridia/retrieve/vector-adapter.ts
export interface VectorSearchAdapter {
  search(query: string, options: VectorSearchOptions): Promise<VectorMatch[]>;
  isAvailable(): Promise<boolean>;
}

// Graphiti's built-in vector search (available when Graphiti is running)
export class GraphitiVectorAdapter implements VectorSearchAdapter { ... }

// pgvector (available when Postgres is configured)
export class PgVectorAdapter implements VectorSearchAdapter { ... }
```

Start with `GraphitiVectorAdapter` (zero new infrastructure). Add `PgVectorAdapter` later when Postgres support matures.

#### 3c. Reconstitution Engine Rebuild (`src/meridia/reconstitution/`)

Replace `reconstitute.ts` with the structured context pack approach from `docs/components/reconstitution-engine.md`:

```ts
// src/meridia/reconstitution/engine.ts
export interface ReconstitutionPack {
  summary: string;               // 1-3 paragraph narrative
  approachGuidance: string[];    // How to engage, priorities
  anchors: Array<{
    phrase: string;
    instruction: string;
    citation?: string;           // meridia://<id>
  }>;
  openUncertainties: string[];   // Carried forward
  nextActions: string[];         // Concrete next steps
  citations: Array<{
    id: string;
    kind: string;
    uri?: string;
  }>;
  meta: {
    recordCount: number;
    sessionCount: number;
    timeRange: { from: string; to: string } | null;
    sources: { canonical: number; graph: number; vector: number };
    estimatedTokens: number;
    truncated: boolean;
  };
}
```

**Two rendering modes:**

1. **Structured pack** (default for bootstrap injection): Markdown with sections for narrative, anchors, uncertainties, and next actions. Machine-parseable sections.

2. **Prose mode** (optional, for richer contexts): LLM-generated "I remember..." narrative that weaves experiences into a state-restoration prompt. More expensive but better for deep reconstitution.

```ts
export async function generateReconstitution(
  options: ReconstitutionOptions,
): Promise<ReconstitutionPack | null> {
  // 1. Retrieve from available sources
  const intent = buildRetrievalIntent(options);
  const results = await hybridRetrieve(intent, options.sources);

  if (results.length === 0) return null;

  // 2. Build structured pack
  const pack = buildStructuredPack(results, options);

  // 3. Optionally generate prose narrative
  if (options.renderMode === "prose" && options.llmAvailable) {
    pack.summary = await generateProseNarrative(results, options);
  }

  return pack;
}
```

#### 3d. Fanout Dispatcher (`src/meridia/fanout/`)

Extract the async side-effect dispatch from compaction into a reusable dispatcher:

```ts
// src/meridia/fanout/dispatcher.ts
export class FanoutDispatcher {
  async dispatch(kit: ExperienceKit, targets: FanoutTarget[]): Promise<FanoutResult[]>;
}

export type FanoutTarget = "graph" | "vector" | "compaction";
```

- Fire-and-forget with error isolation (failures don't block capture)
- Configurable retry policy per target
- Backpressure: skip fanout if queue depth exceeds threshold

#### 3e. Session-End Mini-Compaction

Add incremental graph sync on session end (not just scheduled compaction):

```ts
// In session-end hook: after sealing the session
if (graphitiEnabled && capturedRecords.length >= 3) {
  const episode = synthesizeSessionEpisode(capturedRecords);
  await fanout.dispatch(episode, ["graph"]);
}
```

This replaces the proposed "real-time per-event Graphiti push" with batched session-level graph updates—better signal-to-noise ratio, lower write volume.

**Files created:**
- `src/meridia/retrieve/hybrid.ts`
- `src/meridia/retrieve/vector-adapter.ts`
- `src/meridia/retrieve/ranker.ts`
- `src/meridia/retrieve/intent.ts`
- `src/meridia/retrieve/index.ts`
- `src/meridia/reconstitution/engine.ts`
- `src/meridia/reconstitution/pack-builder.ts`
- `src/meridia/reconstitution/prose.ts`
- `src/meridia/reconstitution/index.ts`
- `src/meridia/fanout/dispatcher.ts`
- `src/meridia/fanout/index.ts`

**Files modified:**
- `hooks/meridia-reconstitution/handler.ts` (use new engine)
- `hooks/compaction/handler.ts` (delegate to fanout dispatcher)
- `hooks/session-end/handler.ts` (add mini-compaction)
- `src/tools/experience-search-tool.ts` (use hybrid retriever)

**Validation:** Reconstitution produces richer output. Graph sync verified via Graphiti API. Search returns blended results when graph/vector are available, gracefully degrades to FTS-only when not.

---

### Phase 4: Artifact Collection and Vector Index

**Goal:** Capture non-text references and enable semantic similarity search.

#### 4a. Artifact and Reference Collector (`src/meridia/artifacts/`)

Implement Component 5 from COMPONENT-MAP:

```ts
// src/meridia/artifacts/collector.ts
export function collectArtifacts(event: MeridiaEvent): ArtifactRef[] {
  const refs: ArtifactRef[] = [];

  // Extract from tool-specific patterns
  if (event.tool?.name === "write" || event.tool?.name === "edit") {
    refs.push(fileArtifact(event.payload));
  }
  if (event.tool?.name === "browser") {
    refs.push(linkArtifact(event.payload));
  }
  // ... media tokens, screenshots, etc.

  return refs;
}
```

- File references (path, size, hash) for write/edit operations
- URL references for browser/web operations
- Media references (images, audio, video) from tool output
- No raw binary storage in records—references only

#### 4b. pgvector Backend (Optional)

When PostgreSQL is configured, add vector indexing:

```ts
// src/meridia/retrieve/pg-vector-adapter.ts
export class PgVectorAdapter implements VectorSearchAdapter {
  async upsert(id: string, embedding: number[], metadata: VectorMetadata): Promise<void>;
  async search(query: string, options: VectorSearchOptions): Promise<VectorMatch[]>;
}
```

- Use the embedding model configured in the system (not hardcoded to ada-002)
- Store embeddings with metadata (session_key, significance, engagement_quality, emotional_valence) for efficient filtered search
- Build embedding text from: topic + summary + anchor phrases + uncertainties + emotional texture
- IVFFlat index for approximate nearest neighbor search

**Files created:**
- `src/meridia/artifacts/collector.ts`
- `src/meridia/artifacts/index.ts`
- `src/meridia/retrieve/pg-vector-adapter.ts` (optional)
- `src/meridia/db/backends/postgresql.ts` (optional, canonical store alternative)

**Files modified:**
- `hooks/experiential-capture/handler.ts` (collect artifacts during capture)
- `src/meridia/kit/builder.ts` (include artifacts in kit)
- `src/meridia/retrieve/hybrid.ts` (register pgvector adapter when available)

---

### Phase 5: Polish and Integration

**Goal:** End-to-end integration, `meridia://` URI resolution, and quality metrics.

#### 5a. `meridia://<id>` URI Resolution

Make experience kits inspectable via URI:

```ts
// src/meridia/kit/resolver.ts
export function resolveKitUri(uri: string): ExperienceKit | null;
```

Wire into `MeridiaSearchAdapter.readFile()` which is currently empty.

#### 5b. Reconstitution Quality Metrics

Track reconstitution effectiveness:
- Pack token budget utilization
- Source diversity (how many of canonical/graph/vector contributed)
- Anchor coverage (what fraction of packs include anchors)
- Phenomenology coverage (what fraction of captured kits have full phenomenology)

#### 5c. Experience Reflect Tool Enhancement

Update `experience_reflect` to surface phenomenological patterns:
- Emotional signature distribution over time
- Engagement quality trends
- Recurring uncertainties across sessions
- Anchor effectiveness (do anchored experiences get recalled more?)

---

## Open Questions (Resolved)

From the original proposal, with answers:

| Question | Resolution |
|----------|-----------|
| Scope of feelings/thoughts? | Use the schema as designed. `emotionalSignature` with controlled vocabulary (10 primary emotions, 8 texture words). Don't go further into somatic language—keep it grounded and structured. |
| Graph vs Local as source of truth? | SQLite canonical, Graphiti secondary index. Per ARCH.md: "Never rely on best-effort side effects (graph/vector) for correctness." |
| PostgreSQL commitment? | Optional. Start with Graphiti vector search (already running). pgvector when Postgres is configured. SQLite-only works fine without either. |
| LLM extraction cost? | Two-pass: cheap gate decision on every event, expensive phenomenology only on captured events (max ~10/hour). |
| Reconstitution format? | Both. Structured pack (default, cheaper, scannable) and prose mode (optional, richer, LLM-generated). |
| Privacy boundaries? | Component 12 (Sanitization Guard) handles this. Redaction before persistence, additional redaction before fanout. Configurable patterns. |

## Dependency and Risk Summary

| Dependency | Required? | Risk | Mitigation |
|-----------|-----------|------|-----------|
| SQLite | Yes | Low (already working) | N/A |
| LLM for phenomenology | No (heuristic fallback) | Medium (cost, latency) | Two-pass, timeout, fallback |
| Graphiti/Neo4j | No (optional) | Low (already integrated in compaction) | Graceful degradation |
| pgvector/PostgreSQL | No (optional) | Low (behind adapter interface) | Graphiti vector or FTS-only |
| Embedding model | No (needed for vector search) | Medium (model availability) | Config-driven, adapter pattern |

## Phase Ordering Rationale

```
Phase 1 (Foundation) → Phase 2 (Phenomenology) → Phase 3 (Retrieval) → Phase 4 (Artifacts) → Phase 5 (Polish)
         │                      │                        │
         │                      │                        └─ Requires: hybrid retriever for blended results
         │                      └─ Requires: normalizer, gates, sanitizer extracted
         └─ Pure refactoring, no behavior change, unblocks everything
```

Phases 1 and 2 are sequential (2 depends on 1). Phases 3 and 4 can be parallelized. Phase 5 is integration work that benefits from everything else being in place.
