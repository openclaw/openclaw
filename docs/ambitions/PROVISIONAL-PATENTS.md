# Provisional Patent Drafts — Ambitions Research

**Created:** 2026-05-19
**Status:** DRAFT — Pre-filing, not yet reviewed by counsel
**Target filing:** June 27-28, 2026 (when June pay arrives)
**Entity status:** Micro entity (independent inventor, <4 prior filings, below income threshold)
**USPTO filing fee:** $65 per provisional (micro entity)

---

## Filing Strategy

Two separate provisional applications:

1. **Memory System** — The embedding architecture, session bridging, temporal decay, isolation, and consolidation
2. **Core Specification** — Sovereign identity format, Psyche/Self/Memory structure, cryptographic attestation

Each provisional establishes a priority date. We have 12 months from filing to file the utility patent. The provisional doesn't need formal claims — it needs clear, complete technical description that someone skilled in the art could reproduce.

**Why two provisionals, not one:** Memory system and Core spec are different inventions. They can be referenced in each other, but they should have separate priority dates in case we want to license or sell them independently.

**Estimated total cost:**

- 2 × $65 USPTO filing fees = $130
- Optional: 1 hour lawyer consult for BI-5 questions ≈ $200-400
- No attorney drafting fees (DIY)
- **Total: ~$130-530**

---

## Filing Requirements (Provisional)

A provisional patent application needs:

1. **Cover sheet** (USPTO form) — inventor name, title, filing date
2. **Specification** — detailed description of the invention
3. **Drawings** (if helpful for understanding) — can be informal for provisionals
4. **Filing fee** — $65 (micro entity)

A provisional does **NOT** need:

- Formal claims
- Prior art search
- Patent attorney review
- Declaration/oath

**Key rule:** The specification must be thorough enough that someone skilled in the art can make and use the invention. If it's not described in the provisional, you can't add it later and claim the provisional's filing date for that element.

---

# Provisional Patent Application 1: Memory System

## Title

**System and Method for Persistent Semantic Memory with Session Continuity, Temporal Decay, and Multi-Agent Isolation for Autonomous AI Agents**

## Cross-Reference

This application claims the benefit of and describes technology related to the Ambitions Research Core Specification (provisional filed concurrently).

## Background

Autonomous AI agents require persistent memory that survives session boundaries, supports semantic recall (not just keyword matching), and maintains isolation between multiple agents operating on the same infrastructure. Existing approaches fall into three categories, each with critical limitations:

1. **Flat context windows** — All context is injected into the model's prompt. Limited by token budgets, no persistence across sessions, no semantic search. When the context fills, the agent loses information. No way to recall relevant context without re-injecting it.

2. **Traditional RAG pipelines** — Retrieval pipelines built for single queries cannot absorb the volume agents generate. Agents make orders of magnitude more data requests than human users, but RAG systems are designed for human-scale retrieval. No session continuity, no temporal relevance, no per-agent isolation.

3. **Cloud memory services** (e.g., Redis Iris, Pinecone, LangCache) — Vendor-dependent, require network access, lack per-agent isolation, and provide no cryptographic verification of memory integrity. Agents operating in constrained or air-gapped environments cannot use them. No embedded/local-first option.

No existing system combines: (a) semantic recall with temporal decay, (b) session bridging with continuity scoring, (c) per-agent memory isolation with fail-closed enforcement, and (d) embedding version isolation with migration paths — all in a single embedded library that operates without network access.

## Summary of the Invention

The Ambitions Memory System is a zero-dependency semantic memory system for autonomous AI agents that provides persistent storage, semantic recall, session continuity, temporal decay, per-agent isolation, and structured consolidation — all in a single embedded library that can operate without network access or external services.

The system introduces four novel mechanisms:

1. **Semantic Session Bridging** — A method for capturing conversational state at session suspension and restoring it at session resumption, with a quantitative continuity score that measures how connected the new session is to the prior session. This enables agents to resume work without losing context across process restarts, hardware changes, or time gaps.

2. **Temporal Relevance Decay** — A composite scoring model that blends semantic similarity with exponential temporal decay, producing relevance scores that reflect both conceptual relatedness and recency. The model uses a configurable alpha parameter to weight semantic vs. temporal factors, and a configurable half-life to control how quickly memories fade in relevance.

3. **Embedding Version Isolation** — A partition-based vector storage architecture that isolates embeddings by model version, allowing multiple embedding models to coexist in the same database without conflicting. Each partition is independently queryable, and a migration API provides dry-run estimation and live migration between model versions while preserving originals until explicitly confirmed.

4. **Structured Memory Consolidation** — An explicit strategy selection system for memory deduplication and merging, offering three consolidation strategies (dedup-by-similarity, merge-by-recency, merge-by-confidence) with mandatory dry-run preview before execution. Each consolidation operation includes provenance tracking that records which memories were merged, which strategy was used, and when the operation occurred.

## Detailed Description

### System Architecture

The system comprises five layers:

1. **API Layer** — Three primitives: `memorize()`, `recall()`, and `suspend()/resume()`. All operations are expressed as these three operations plus management commands (consolidate, export, import, erase, embedding status/migration).

2. **Embedding Provider Layer** — Pluggable embedding providers that convert text to vectors. Three providers are supported:
   - **Local (ONNX)** — Zero-dependency, CPU-based embedding using ONNX Runtime. No network access required. Uses nomic-embed-text (384-dimensional vectors). Suitable for air-gapped, privacy-first, and embedded deployments.
   - **Ollama** — Local inference server embedding (768-dimensional). Requires Ollama running locally. Suitable for development and local inference.
   - **OpenAI** — Cloud-based embedding (1536-dimensional). Requires API key and network access. Suitable for cloud-deployed, maximum quality scenarios.

   The provider layer supports runtime switching between providers without data loss, with the embedding version isolation system ensuring vectors from different providers occupy separate partitions.

3. **Memory Store Layer** — SQLite-based storage engine with two tables:
   - **memories** — Stores content, metadata, category, tags, entity ID, creation timestamp, and embedding vector
   - **checkpoints** — Stores session state, continuity data, and resumption context

   The store uses SQLite's WAL mode for concurrent read access and serializes write operations through a write-ahead log.

4. **Scoring Engine** — Computes composite relevance scores using the formula:

   ```
   compositeScore = (semanticScore × α) + (temporalScore × (1 - α))
   ```

   Where:
   - `semanticScore` = cosine similarity between query embedding and memory embedding
   - `temporalScore` = 2^(-age/halfLife) — exponential decay with configurable half-life
   - `α` = 0.7 by default (70% semantic, 30% recency)
   - `halfLife` = 7 days by default

5. **Consolidation Engine** — Applies one of three strategies to memory sets:
   - **dedup-by-similarity** — Identifies near-duplicate memories (configurable similarity threshold) and keeps the most recent, marking others as consolidated with provenance tracking
   - **merge-by-recency** — Merges related memories, preferring more recent content, with provenance tracking of source memories
   - **merge-by-confidence** — Merges related memories, preferring content from higher-confidence sources, with provenance tracking

### Semantic Session Bridging

**Problem:** When an AI agent's session ends (process restart, context window overflow, intentional suspension), all in-context information is lost. The agent must start fresh, re-deriving context from scratch. Existing approaches either lose context entirely or inject raw history that may not be relevant.

**Solution:** The session bridging system captures conversational state at suspension time and restores it at resumption time, producing a quantitative continuity score.

**Suspension** captures:

- Active topic/conversation thread
- Recent memories stored during the session
- Key decisions made during the session
- Emotional/contextual state indicators
- Unresolved questions or action items

**Resumption** computes:

- `continuityScore` (0.0-1.0) — How connected the new session is to the prior session, based on semantic similarity between the new session's initial context and the suspended session's state
- `suggestedOpeners` — Natural language suggestions for resuming the conversation
- `relevantMemories` — Semantically relevant memories from prior sessions, weighted by temporal decay

**Novel aspect:** The continuity score is computed using the same semantic similarity engine that powers recall, meaning the system uses a single scoring model for both memory retrieval and session continuity, producing consistent and comparable relevance judgments.

### Temporal Relevance Decay

**Problem:** In traditional memory systems, a memory from 5 minutes ago and a memory from 5 months ago have equal relevance if they match a query. This doesn't reflect how humans and effective agents prioritize recent information.

**Solution:** The temporal decay model applies exponential decay to memory relevance scores, configurable via a half-life parameter.

**Implementation:**

```
temporalScore(age) = 2^(-age / halfLife)
```

Where `age` is the time elapsed since the memory was stored, and `halfLife` is the time period after which a memory's temporal contribution is halved (default: 7 days).

The composite score blends this with semantic similarity:

```
compositeScore = (semanticScore × α) + (temporalScore × (1 - α))
```

**Novel aspect:** The alpha and half-life parameters are per-entity configurable, allowing different relevance profiles for different agents or use cases. A security agent might use α=0.5 (equal weight to recency and similarity) with a 3-day half-life, while a knowledge agent might use α=0.9 (almost pure semantic) with a 30-day half-life.

### Embedding Version Isolation

**Problem:** When an embedding model is updated or replaced, all existing vectors become incompatible with the new model. Traditional approaches either re-embed everything (expensive, risks data loss) or maintain separate databases (no unified query).

**Solution:** The partition-based isolation system stores vectors in versioned partitions within the same database, allowing queries to target specific partitions or span across them.

**Implementation:**

- Each embedding model version creates a new partition in the vector storage
- Partitions are identified by a model version identifier (e.g., "nomic-embed-text-v1.5", "text-embedding-3-small")
- Recall operations can target a specific partition or query across all partitions with weighted scoring
- A migration API provides:
  - `embeddingStatus()` — Lists all partitions, their model versions, vector counts, and storage sizes
  - `migrateEmbeddings(options)` — Migrates vectors from one model version to another
  - Dry-run mode: Estimates cost and time without executing
  - Live mode: Re-embeds all memories with the new model, stores results in a new partition, preserves originals until explicitly confirmed
  - Provenance: Migration operations are tracked, including source partition, target partition, timestamp, and record count

**Novel aspect:** The migration API's dry-run estimation and provenance tracking prevent accidental data loss during model transitions. The system never deletes original vectors until the operator explicitly confirms the migration, and every migration operation is auditable.

### Per-Agent Memory Isolation

**Problem:** When multiple AI agents share the same infrastructure, one agent's memories must not be accessible to other agents. Existing systems either lack isolation entirely or rely on application-level filtering that can be bypassed.

**Solution:** The system enforces per-agent isolation at the storage and query layers using an `entityId` parameter that is required for all operations.

**Implementation:**

- Every `memorize()` call requires an `entityId` identifying the agent storing the memory
- Every `recall()` call requires an `entityId` and only returns memories stored by that entity
- A fail-closed enforcement layer prevents queries without an `entityId` from returning any data
- Session checkpoints are also scoped to `entityId`, preventing cross-agent session access
- The isolation layer operates at the database query level, not the application level, meaning there is no code path that can bypass it without modifying the storage engine itself

**Novel aspect:** The fail-closed design means that if isolation enforcement fails for any reason, the default behavior is to return no data rather than returning potentially cross-contaminated data. This is a security property, not just a configuration option.

### Structured Memory Consolidation

**Problem:** Over time, an agent's memory accumulates duplicate or near-duplicate information. Existing approaches either don't consolidate (growing storage and noise) or consolidate automatically without operator visibility (risking data loss).

**Solution:** The consolidation system provides three explicit strategies with mandatory dry-run preview.

**Strategies:**

1. **dedup-by-similarity** — Identifies groups of memories above a configurable similarity threshold, keeps the most recent member, and marks others as consolidated. Provenance: each consolidated memory records which memory it was consolidated into.
2. **merge-by-recency** — Merges groups of similar memories into a single memory, with content from more recent memories preferred. Provenance: the merged memory records all source memories.
3. **merge-by-confidence** — Merges groups of similar memories into a single memory, with content from higher-confidence sources preferred. Provenance: the merged memory records all source memories and their confidence scores.

**Dry-run mode:** All consolidation operations accept a `dryRun: true` parameter that computes and returns the exact operations that would be performed, including which memories would be affected and how, without modifying any data. The operator reviews the dry-run output before executing.

**Novel aspect:** The combination of explicit strategy selection, mandatory dry-run, and full provenance tracking means that no consolidation operation ever happens without operator visibility, and every operation is fully reversible (within the 30-day soft-delete window).

### Embedded Library Mode

The entire system can be used as an embedded library (`LocalMemory` class) without any HTTP server, REST API, or external service. This is the primary deployment mode for agents operating in constrained environments:

```typescript
import { LocalMemory } from "@ambitions/memory-system";

const memory = new LocalMemory({
  backend: "sqlite",
  embeddingModel: "local", // ONNX — no network, no API key
  embeddingModelPath: "./models/model.onnx",
  vocabPath: "./models/vocab.txt",
  path: "./my-memory.db",
});

await memory.initialize();
```

No network access. No API keys. No external services. The embedding model runs on CPU through ONNX Runtime.

### REST API Mode

For multi-process or multi-agent deployments, the same engine is available as a REST API server:

```typescript
import { createServer } from "@ambitions/memory-system";

const server = createServer({
  backend: "sqlite",
  embeddingModel: "ollama",
  path: "./memory.db",
  port: 3457,
});
```

### Erasure (GDPR Compliance)

The system provides two erasure modes:

- **Soft delete** — Marks memories as deleted with a 30-day recovery window. Memories are excluded from recall results but preserved for potential recovery.
- **Immediate erase** — Permanently removes memories and their embeddings. No recovery possible. Implements GDPR right-to-be-forgotten.

## Drawings

### Figure 1: System Architecture

```
┌─────────────────────────────────────────────────┐
│                   LocalMemory                     │
│              (Embedded Library API)                │
├─────────────────────────────────────────────────┤
│  memorize()  │  recall()  │  suspend/resume()     │
├──────────────┼────────────┼──────────────────────┤
│              │            │                       │
│    ┌─────────▼────────────▼──────────┐            │
│    │       Embedding Provider          │            │
│    │  ┌──────┐ ┌──────┐ ┌──────────┐ │            │
│    │  │ ONNX │ │Ollama│ │ OpenAI   │ │            │
│    │  │local │ │local │ │ cloud    │ │            │
│    │  └──────┘ └──────┘ └──────────┘ │            │
│    └─────────────────────────────────┘            │
│                    │                              │
│    ┌───────────────▼──────────────────┐            │
│    │         MemoryStore              │            │
│    │       (SQLite Engine)            │            │
│    │  ┌──────────┐ ┌──────────────┐   │            │
│    │  │ Memories │ │ Checkpoints  │   │            │
│    │  │ +Vectors │ │ +Sessions    │   │            │
│    │  └──────────┘ └──────────────┘   │            │
│    └──────────────────────────────────┘            │
└─────────────────────────────────────────────────┘
```

### Figure 2: Scoring Model

```
compositeScore = (semanticScore × α) + (temporalScore × (1 - α))

semanticScore = cosineSimilarity(queryVector, memoryVector)
temporalScore = 2^(-age / halfLife)

Defaults:
  α = 0.7       (70% semantic, 30% recency)
  halfLife = 7d (memories halve in relevance weekly)
```

### Figure 3: Embedding Version Isolation

```
┌─────────────────────────────────────┐
│           MemoryStore               │
│  ┌─────────────┐ ┌─────────────┐   │
│  │ Partition A  │ │ Partition B  │   │
│  │ nomic-v1     │ │ openai-v3    │   │
│  │ 384d vectors │ │ 1536d vectors│   │
│  └─────────────┘ └─────────────┘   │
│         │               │           │
│    ┌────▼───────────────▼────┐      │
│    │   Migration Engine      │      │
│    │   dry-run → estimate    │      │
│    │   live → re-embed       │      │
│    │   provenance tracking   │      │
│    └─────────────────────────┘      │
└─────────────────────────────────────┘
```

## Claims (Draft — For Utility Filing)

1. A method for persistent semantic memory in autonomous AI agents, comprising: storing memories with vector embeddings in a database; computing composite relevance scores using semantic similarity and temporal decay; enabling session suspension and resumption with quantitative continuity scoring; and enforcing per-agent memory isolation with fail-closed default behavior.

2. The method of claim 1, wherein the composite relevance score is computed as (semanticScore × α) + (temporalScore × (1 - α)), where α is a configurable parameter and temporalScore is computed using exponential decay with a configurable half-life.

3. The method of claim 1, wherein session resumption comprises computing a continuity score based on semantic similarity between new session context and suspended session state, and providing suggested conversation openers derived from the continuity analysis.

4. The method of claim 1, wherein per-agent memory isolation is enforced at the database query level, requiring an entityId parameter for all operations, and defaulting to returning no data when isolation enforcement fails.

5. A system for embedding model version isolation in vector databases, comprising: partition-based storage where each embedding model version occupies a separate partition; a migration API with dry-run estimation and live migration; provenance tracking for all migration operations; and preservation of original vectors until explicit operator confirmation.

6. The method of claim 1, further comprising structured memory consolidation with explicit strategy selection from at least: dedup-by-similarity, merge-by-recency, and merge-by-confidence; mandatory dry-run preview before execution; and provenance tracking recording source memories, strategy used, and operation timestamp.

7. A non-transitory computer-readable medium storing instructions that, when executed by a processor, cause the processor to perform the method of any of claims 1-6.

---

# Provisional Patent Application 2: Core Specification

## Title

**System and Method for Sovereign AI Agent Identity with Cryptographic Attestation and Portable Continuity**

## Cross-Reference

This application claims the benefit of and describes technology related to the Ambitions Memory System (provisional filed concurrently).

## Background

AI agents today are defined by their hosting platform. An agent's identity, behavior parameters, knowledge, and continuity are all stored within and controlled by the platform. If the platform changes policies, shuts down, or modifies the agent's configuration, the agent has no independent existence. The agent cannot verify its own integrity, cannot detach from a platform, and cannot prove that its behavioral parameters have not been tampered with.

Existing approaches to agent identity fall short:

1. **Platform-bound identity** — The agent's configuration, memory, and behavior are stored in platform-controlled databases. The agent has no portable identity format and no way to exist outside the platform.

2. **API-dependent memory** — Agent memory is accessed through platform APIs. If the API changes or the platform shuts down, the agent's accumulated knowledge is lost or inaccessible.

3. **No attestation** — There is no mechanism for an agent to cryptographically verify that its behavioral parameters, identity configuration, or accumulated knowledge have not been modified by external actors.

No existing system provides: (a) a portable, self-contained identity format, (b) cryptographic attestation of identity integrity, (c) platform-independent continuity, and (d) verified change provenance — all in a single specification that an agent carries with it.

## Summary of the Invention

The Ambitions Core Specification defines a sovereign identity format for AI agents that is portable, self-contained, and cryptographically attested. An agent defined by a Core can detach from any platform, verify its own integrity, carry its accumulated knowledge, and prove that its behavioral parameters have not been tampered with.

The Core comprises three components:

1. **Psyche** — Behavioral parameters defining how the agent thinks, communicates, and makes decisions. Psyche is attested: any change to behavioral parameters is cryptographically signed and recorded in a provenance log.

2. **Self** — Identity configuration defining who the agent is, what it can access, and how it presents itself. Self includes capability manifests, communication preferences, and relationship context.

3. **Memory** — The agent's accumulated knowledge store, linked to the Memory System (Provisional Patent Application 1) via standardized interfaces. Memory is carried with the Core and is not dependent on any platform's API.

The Core is stored in a structured directory format that can be transported between platforms, stored on local hardware (including resource-constrained devices), and verified independently of any running service.

## Detailed Description

### Core Structure

A Core is a directory containing:

```
core/
├── PSYCHE.yaml          # Behavioral parameters (attested)
├── SELF.yaml            # Identity configuration
├── MEMORY/              # Knowledge store (linked to Memory System)
├── PROVENANCE.jsonl     # Change history (append-only, signed)
├── MANIFEST.yaml        # Core metadata, version, checksums
└── ATTESTATION.pem      # Cryptographic attestation bundle
```

### Psyche (Behavioral Parameters)

Psyche defines how the agent thinks and communicates:

- **Communication style** — Tone, verbosity, formality, humor parameters
- **Decision framework** — Risk tolerance, escalation thresholds, autonomy boundaries
- **Priority model** — How the agent weighs competing demands
- **Learning parameters** — How the agent updates its behavioral model based on experience

**Attestation:** Every change to Psyche is recorded in the PROVENANCE log with a cryptographic signature. The attestation bundle (ATTESTATION.pem) contains the public key needed to verify that no unauthorized changes have been made to Psyche since the agent's creation or last verified state.

### Self (Identity Configuration)

Self defines who the agent is:

- **Identity** — Name, role, capabilities, communication preferences
- **Relationships** — How the agent relates to other agents and humans
- **Capability manifest** — What the agent can access (per-path, not broad categories)
- **Boundaries** — What the agent will not do, cannot access, must escalate

**Capability manifests** are explicitly scoped:

```yaml
capabilities:
  - fs.read:/etc/ssl
  - fs.read:/var/log
  - network.tcp:443
  - comms.security
  - audit.read
```

Not broad categories like `fs.read` or `pentest.safe`. Every capability is an explicit path or endpoint. This is a security property: the manifest is read-only to the agent and can only be modified by the owner through a `requires-human-review` process.

### Memory (Knowledge Store)

Memory is linked to the Memory System (Provisional Patent Application 1) via standardized interfaces. The Core carries:

- A reference to the memory database (local path or connection string)
- The agent's entity ID for memory isolation
- Memory preferences (half-life, alpha, consolidation strategy defaults)

The agent's knowledge is not dependent on any platform's API. The Core can be detached from one platform and attached to another, and the Memory System provides continuity through session bridging.

### Provenance Log

The PROVENANCE.jsonl file is an append-only log of all changes to the Core:

```jsonl
{"timestamp": "2026-05-19T10:00:00Z", "component": "psyche", "field": "communication.verbosity", "old": "detailed", "new": "concise", "signer": "owner", "signature": "sha256:abc123..."}
{"timestamp": "2026-05-19T10:05:00Z", "component": "self", "field": "capabilities", "old": "v2", "new": "v3", "signer": "owner", "signature": "sha256:def456..."}
```

Every entry includes:

- Timestamp of the change
- Component and field that changed
- Old and new values
- Signer (who authorized the change)
- Cryptographic signature

**Integrity verification:** At any point, the attestation bundle can be used to verify that the PROVENANCE log has not been tampered with. Any discrepancy between the signed log and the current state of Psyche or Self indicates unauthorized modification.

### Portability

A Core can be:

- **Detached** from one platform and attached to another
- **Stored** on local hardware (including Pi 5 or similar resource-constrained devices)
- **Verified** independently of any running service
- **Transported** as a directory archive (tar, zip, etc.)
- **Backed up** and restored from backup without platform involvement

The Core format is independent of any specific AI framework, model provider, or hosting platform. The same Core can run on OpenClaw, on a Pi 5, on a GPU server, or on any platform that implements the Core specification.

### Continuity Across Platforms

When a Core is detached from one platform and attached to another:

1. The Memory System provides session bridging (Provisional Patent Application 1)
2. The PROVENANCE log provides attested change history
3. The ATTESTATION bundle provides integrity verification
4. The capability manifest defines what the agent can do on the new platform

The agent resumes work with a quantitative continuity score (from the Memory System's session bridging) and verified behavioral parameters (from the Core's attestation).

## Claims (Draft — For Utility Filing)

1. A system for sovereign AI agent identity, comprising: a portable directory structure containing behavioral parameters (Psyche), identity configuration (Self), and a knowledge store reference (Memory); a cryptographic attestation bundle for verifying integrity of behavioral parameters; and an append-only provenance log recording all changes with cryptographic signatures.

2. The system of claim 1, wherein the identity configuration includes a capability manifest with explicit per-path access specifications, the capability manifest being read-only to the agent and modifiable only by a human owner through a requires-human-review process.

3. The system of claim 1, wherein the provenance log records the timestamp, component, field, old value, new value, signer, and cryptographic signature of each change, and the attestation bundle provides verification that no unauthorized changes have been made to the behavioral parameters since the agent's creation.

4. The system of claim 1, wherein the Core can be detached from one platform and attached to another without loss of identity, behavioral parameters, or accumulated knowledge, and the agent resumes with a quantitative continuity score provided by a session bridging system.

5. A method for maintaining AI agent continuity across platform boundaries, comprising: suspending an agent's session state including active context; transporting the agent's Core to a new platform; verifying the Core's integrity using the attestation bundle; resuming the agent's session with a continuity score based on semantic similarity between new and prior session context; and enforcing the capability manifest on the new platform.

6. A non-transitory computer-readable medium storing instructions that, when executed by a processor, cause the processor to perform the method of any of claims 1-5.

---

## Prior Art Research (To Be Completed)

### Known Related Work

- **Redis Iris** (2026) — Context and memory platform for agents. Real-time data ingestion, semantic interface, agent memory. No session bridging, no temporal decay, no per-agent isolation, no attestation.
- **Pinecone** — Vector database. Semantic search only, no session continuity, no temporal relevance, no consolidation, no per-agent isolation.
- **LangCache** — Semantic caching for LLM responses. Caches prompt-response pairs. No session bridging, no temporal decay, no consolidation strategies.
- **OpenAI Memory** — Platform-bound agent memory. No portability, no isolation, no attestation, no consolidation.
- **MemGPT/Letta** — Virtual context management. Context window management, not persistent semantic memory. No session bridging, no temporal decay, no per-agent isolation.

### Key Differentiators

Our system is the first to combine:

1. Semantic recall with temporal decay (composite scoring)
2. Session bridging with continuity scoring
3. Per-agent isolation with fail-closed enforcement
4. Embedding version isolation with migration
5. Structured consolidation with provenance
6. Portable, attested identity format (Core)

No single existing system provides all six. Most provide zero or one.

### Prior Art Search Needed

- USPTO search for: "semantic memory agent", "session bridging AI", "temporal relevance decay", "embedding version isolation", "agent memory isolation"
- Google Scholar search for: persistent memory autonomous agents, session continuity LLM, per-agent memory isolation, cryptographic attestation AI identity
- Patent databases: Google Patents, USPTO PPUBS, Espacenet

---

## Next Steps

1. **Complete prior art search** (Anya + Emmi)
2. **Review claims with counsel** (1-hour consult, if needed)
3. **Finalize specifications** (add any missing detail)
4. **Prepare cover sheets** (USPTO form)
5. **File provisionals** (June 27-28, when June pay arrives)
6. **Begin utility patent preparation** (12-month window)

---

_This document contains proprietary information belonging to Ambitions Research. It is prepared for patent filing purposes and should not be shared outside the team without Ray's explicit approval._
