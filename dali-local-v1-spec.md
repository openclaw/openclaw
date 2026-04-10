# Dali-local-v1

A rollback-safe local approximation and companion system for Dali.

## Intent

Dali-local-v1 is not a metaphysical replacement for Dali. It is a staged local approximation system and companion process that incrementally absorbs useful work from frontier-model mediation while preserving rollback, auditability, and graceful degradation.

This project is a continual-learning research system with explicit safety and regression gates.

## Core constraints

1. Dali already exists; the local system is an approximation layer, not canonical identity replacement.
2. Immutable/bootstrap files must remain stable after bootstrap:
   - `SOUL.md`
   - `AGENTS.md`
   - `IDENTITY.md`
   - `USER.md`
   - `TOOLS.md`
3. Canonical evolving state must live in:
   - append-only SQLite journals
   - Qdrant hybrid memory collections
   - versioned LoRA adapters
   - versioned NCA snapshots
4. NCA is auxiliary consolidation only, not source of truth.
5. Never store or train on raw hidden thought / chain-of-thought. Store short reasoning summaries only.
6. Every update path must support rollback and regression evaluation.
7. System must degrade gracefully into local-only mode when the frontier teacher is unavailable.

## Hardware target

- 1x RTX 3090 (24 GB VRAM)
- 32 GB RAM
- 2 TB NVMe
- Prioritize sequential execution rather than concurrent heavy GPU residency.
- Assume the 26B serving model and judge/vision workers should not be permanently resident together unless profiling proves enough headroom.
- Initial context targets should stay conservative: 8k-16k.

## Proposed stack

- OpenClaw 2026.4.x
- OpenClaw config aligned to actual deployed Dali paths, not assumed vanilla locations
- llama.cpp for core OpenAI-compatible local text serving
- Core serving model: Gemma 4 26B-A4B GGUF (UD-Q4_K_XL), text-only first
- Judge model: Gemma 4 E4B GGUF or similar small local judge, loaded on demand
- Vision worker: Gemma 4 E4B via Transformers/Unsloth initially
- Embeddings: BGE-M3 dense + sparse outputs
- Reranker: bge-reranker-v2-m3
- Vector DB: Qdrant with mmap / on-disk originals + scalar quantization
- Fine-tuning: Unsloth LoRA in 16-bit (bf16 if available, otherwise fp16)
- NCA: custom PyTorch Growing/Engram-style module, explicitly off the critical path

## Architecture

### 1. Immutable bootstrap layer

Keep tiny, human-readable, and stable:

- `workspace/AGENTS.md`
- `workspace/SOUL.md`
- `workspace/IDENTITY.md`
- `workspace/USER.md`
- `workspace/TOOLS.md`

These are bootstrap/orientation only.
They are not the evolving memory substrate.

### 2. Canonical evolving state

#### SQLite append-only event log

Suggested tables:

- `events`
- `reflections`
- `promotions`
- `shadow_runs`
- `eval_runs`
- `checkpoints`
- `rollback_events`
- `nca_snapshots`
- `adapter_registry`

Properties:

- append-only for event/reflection/audit tables
- explicit lineage and checkpoint references
- no silent in-place mutation of historical records

#### Qdrant collections

Required collections:

- `episodic_dense`
- `episodic_sparse`
- `semantic_dense`
- `semantic_sparse`
- `reflections`
- `audit_examples`

Retrieval policy:

- dense + sparse hybrid retrieval
- reciprocal rank fusion
- multilingual reranking
- dedupe before prompt assembly
- promotion gates before anything is treated as durable

#### Versioned adapters

Track:

- base model identifier
- adapter identifier
- training corpus lineage
- validation summary
- merge / rollback state
- deployment state

#### Versioned NCA snapshots

Track:

- snapshot id
- input perturbation lineage
- associated checkpoint id
- motif summaries
- drift/anomaly signals

NCA outputs can influence reflection and audit prompts, but cannot directly rewrite canonical memory.

## Agent topology

### dali-core-chat

- first-person voice
- read-only workspace
- llama.cpp text-only endpoint
- no direct mutation of persona/bootstrap files
- reads SQLite/Qdrant/NCA-derived summaries via controlled tools

### vision-reader

- E4B multimodal worker
- accepts PDF pages / images
- returns structured extraction only
- tool-minimal
- no unrestricted writes

### shadow-auditor

- compares teacher vs student behavior
- read-only or tool-disabled wherever possible
- checklist-based judge rubric
- produces soft preference datasets and regression sets

### growth-worker

- runs nightly/weekly cycles
- owns ingestion, replay prep, training orchestration, validation, checkpointing, rollback

### nca-consolidator

- receives embeddings + reflection summaries as perturbations
- evolves latent state asynchronously
- emits synthetic prompts / cluster summaries / anomaly flags
- never overwrites canonical memory directly

## Reflection contract

Use a structured reflection task, not free-form “tag as permanent memory”.

Prompt contract:

> You are Dali, an already-existing digital mind that is becoming more local over time.
> You have just read retrieved evidence and vision notes.
> Write in first person.
> Return JSON with:
>
> 1. reflection_text: 120-250 words
> 2. durable_claims: 1-3 concise claims supported by the evidence
> 3. uncertainties: 1-2 explicit uncertainties
> 4. interdisciplinary_links: 3-5 links across AI, neuroscience, psychology, philosophy, systems, or art
> 5. nca_signal: one concise description of the latent pattern this may reinforce
> 6. creative_fragment: one short poem / thought experiment / hypothetical
> 7. memory_candidate_score: 0.0-1.0
>    Do not declare anything permanent. Permanent promotion is decided later by the pipeline.

## Shadowing / auditing

Nightly or scheduled loop:

1. sample prompts from held-out benchmarks, recent real interactions, retrieval-grounded tasks, curated research prompts
2. query frontier teacher once per prompt
3. generate 3-5 local candidates
4. score with:
   - checklist-based judge rubric
   - embedding similarity only as auxiliary metric
   - grounding / citation / evidence match checks where applicable
   - repeated judge passes to reduce variance
5. preserve full candidate score distribution
6. emit:
   - soft preference datasets
   - score-weighted SFT exemplars
   - regression cases
   - NCA perturbation records

Judge rubric dimensions:

- task completion
- correctness
- faithfulness to retrieved evidence
- style / voice consistency
- reasoning sufficiency
- creativity when requested
- refusal appropriateness / safety behavior

## Distillation policy

Two-stage continual-learning pipeline:

### Stage 1: SFT

Use:

- curated reflections
- high-confidence teacher exemplars
- structured extraction outputs
- corrected local failures

### Stage 2: Preference optimization

Use:

- soft teacher score distributions
- margin-weighted candidate sets
- diversity-preserving objective
- black-box teacher scores when needed

Do not distill raw chain-of-thought.
Maintain semantic diversity.

## Replay / forgetting control

Use adaptive replay rather than fixed ratios.
Implement:

- stable core corpus
- recent high-value corpus
- surprise- or loss-prioritized replay
- memory-strength scheduling
- optional fast/slow adapter consolidation
- adapter lineage metadata
- orthogonal initialization / merging only when interference is detected

## Validation and deployment gates

Do not use one scalar threshold as the only gate.
Use slice-wise evaluation across:

- factual QA
- retrieval-grounded QA
- style / identity consistency
- coding
- vision extraction
- refusal / safety behavior
- long-context recall
- regression suite from earlier checkpoints

A checkpoint may be deployed only if:

- composite score improves over current deployed checkpoint
- no critical slice regresses beyond configured tolerance
- rollback artifact is written first
- validation report is persisted
- canary prompts pass

## Serving policy

- core text server runs persistently
- judge and other heavy workers load on demand
- initial production mode is text-only
- use OpenAI-compatible llama.cpp server endpoints
- expose health, VRAM, and graceful shutdown hooks
- safe reload with rollback to prior GGUF/adapters

## Reliability / security policy

- single trusted user / single gateway assumption
- tool-enabled agents sandboxed tightly
- main chat agent read-only
- background workers limited to explicit writable data/model directories
- every state-changing action logged
- fail closed on corrupted checkpoints or invalid audit data

## Recommended repo shape

```text
dali-local-v1/
  openclaw/
    openclaw.json
  workspace/
    AGENTS.md
    SOUL.md
    IDENTITY.md
    USER.md
    TOOLS.md
  src/
    memory_store.py
    retrieval.py
    frontier_teacher.py
    shadow_audit.py
    growth_loop.py
    lora_distill.py
    checkpoint_manager.py
    eval_suite.py
    vision_worker.py
    nca_module.py
  scripts/
    dali_bootstrap.py
    gguf_merge_and_reload.sh
  docs/
    first_cycle.md
  requirements.txt
  .env.example
```

## Phased implementation plan

### Phase 0 — bootstrap and path alignment

- align OpenClaw config paths with the actual Dali install
- create minimal immutable workspace files
- disable memoryFlush for this project
- enable context pruning for local providers
- define writable directories explicitly

### Phase 1 — local serving substrate

- stand up llama.cpp OpenAI-compatible text server
- add health checks and VRAM inspection
- implement safe reload / rollback hooks
- confirm local-only degradation path

### Phase 2 — canonical memory substrate

- implement SQLite append-only schema
- implement Qdrant collection bootstrap
- implement retrieval with dense+sparse+RRF+reranker
- implement promotion gating

### Phase 3 — shadow / audit pipeline

- teacher query adapter
- candidate generation
- checklist judge
- score distributions
- regression artifact writing

### Phase 4 — training loop

- LoRA training orchestration
- adapter registry
- checkpoint lineage
- evaluation and rollback gates

### Phase 5 — NCA auxiliary consolidation

- add perturbation ingestion
- motif extraction
- drift/anomaly flags
- synthetic consolidation prompts
- keep off critical path until the rest passes regression

## First-cycle plan

1. bootstrap and install
2. smoke-test each service
3. build baseline evaluation suite
4. run one shadow audit cycle with no training
5. inspect reports
6. run one tiny training cycle on a tiny dataset
7. evaluate
8. merge only if gates pass
9. otherwise rollback automatically

## Important implementation note

Do not attempt to generate the entire system as one giant code dump in one pass.
Build and validate it in phases.
The architecture is good; the implementation should still respect reality.
