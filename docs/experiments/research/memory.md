---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Research notes: offline memory system for Clawd workspaces (Markdown source-of-truth + derived index)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Designing workspace memory (~/.openclaw/workspace) beyond daily Markdown logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Deciding: standalone CLI vs deep OpenClaw integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding offline recall + reflection (retain/recall/reflect)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Workspace Memory Research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Workspace Memory v2 (offline): research notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Target: Clawd-style workspace (`agents.defaults.workspace`, default `~/.openclaw/workspace`) where “memory” is stored as one Markdown file per day (`memory/YYYY-MM-DD.md`) plus a small set of stable files (e.g. `memory.md`, `SOUL.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This doc proposes an **offline-first** memory architecture that keeps Markdown as the canonical, reviewable source of truth, but adds **structured recall** (search, entity summaries, confidence updates) via a derived index.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why change?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The current setup (one file per day) is excellent for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “append-only” journaling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- human editing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- git-backed durability + auditability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- low-friction capture (“just write it down”)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It’s weak for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- high-recall retrieval (“what did we decide about X?”, “last time we tried Y?”)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- entity-centric answers (“tell me about Alice / The Castle / warelay”) without rereading many files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- opinion/preference stability (and evidence when it changes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- time constraints (“what was true during Nov 2025?”) and conflict resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Design goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Offline**: works without network; can run on laptop/Castle; no cloud dependency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Explainable**: retrieved items should be attributable (file + location) and separable from inference.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Low ceremony**: daily logging stays Markdown, no heavy schema work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Incremental**: v1 is useful with FTS only; semantic/vector and graphs are optional upgrades.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Agent-friendly**: makes “recall within token budgets” easy (return small bundles of facts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## North star model (Hindsight × Letta)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two pieces to blend:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Letta/MemGPT-style control loop**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- keep a small “core” always in context (persona + key user facts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- everything else is out-of-context and retrieved via tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- memory writes are explicit tool calls (append/replace/insert), persisted, then re-injected next turn（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Hindsight-style memory substrate**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- separate what’s observed vs what’s believed vs what’s summarized（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- support retain/recall/reflect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- confidence-bearing opinions that can evolve with evidence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- entity-aware retrieval + temporal queries (even without full knowledge graphs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Proposed architecture (Markdown source-of-truth + derived index)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Canonical store (git-friendly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep `~/.openclaw/workspace` as canonical human-readable memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Suggested workspace layout:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.openclaw/workspace/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  memory.md                    # small: durable facts + preferences (core-ish)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  memory/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    YYYY-MM-DD.md              # daily log (append; narrative)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bank/                        # “typed” memory pages (stable, reviewable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    world.md                   # objective facts about the world（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    experience.md              # what the agent did (first-person)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entities/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      Peter.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      The-Castle.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      warelay.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Daily log stays daily log**. No need to turn it into JSON.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The `bank/` files are **curated**, produced by reflection jobs, and can still be edited by hand.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory.md` remains “small + core-ish”: the things you want Clawd to see every session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Derived store (machine recall)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add a derived index under the workspace (not necessarily git tracked):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.openclaw/workspace/.memory/index.sqlite（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Back it with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SQLite schema for facts + entity links + opinion metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SQLite **FTS5** for lexical recall (fast, tiny, offline)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- optional embeddings table for semantic recall (still offline)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The index is always **rebuildable from Markdown**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Retain / Recall / Reflect (operational loop)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Retain: normalize daily logs into “facts”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hindsight’s key insight that matters here: store **narrative, self-contained facts**, not tiny snippets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Practical rule for `memory/YYYY-MM-DD.md`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- at end of day (or during), add a `## Retain` section with 2–5 bullets that are:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - narrative (cross-turn context preserved)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - self-contained (standalone makes sense later)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - tagged with type + entity mentions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Retain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal parsing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Type prefix: `W` (world), `B` (experience/biographical), `O` (opinion), `S` (observation/summary; usually generated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Entities: `@Peter`, `@warelay`, etc (slugs map to `bank/entities/*.md`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Opinion confidence: `O(c=0.0..1.0)` optional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you don’t want authors to think about it: the reflect job can infer these bullets from the rest of the log, but having an explicit `## Retain` section is the easiest “quality lever”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Recall: queries over the derived index（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recall should support:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **lexical**: “find exact terms / names / commands” (FTS5)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **entity**: “tell me about X” (entity pages + entity-linked facts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **temporal**: “what happened around Nov 27” / “since last week”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **opinion**: “what does Peter prefer?” (with confidence + evidence)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Return format should be agent-friendly and cite sources:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kind` (`world|experience|opinion|observation`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timestamp` (source day, or extracted time range if present)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `entities` (`["Peter","warelay"]`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `content` (the narrative fact)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `source` (`memory/2025-11-27.md#L12` etc)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reflect: produce stable pages + update beliefs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reflection is a scheduled job (daily or heartbeat `ultrathink`) that:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- updates `bank/entities/*.md` from recent facts (entity summaries)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- updates `bank/opinions.md` confidence based on reinforcement/contradiction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- optionally proposes edits to `memory.md` (“core-ish” durable facts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Opinion evolution (simple, explainable):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- each opinion has:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - confidence `c ∈ [0,1]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - last_updated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - evidence links (supporting + contradicting fact IDs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- when new facts arrive:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - find candidate opinions by entity overlap + similarity (FTS first, embeddings later)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - update confidence by small deltas; big jumps require strong contradiction + repeated evidence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI integration: standalone vs deep integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommendation: **deep integration in OpenClaw**, but keep a separable core library.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why integrate into OpenClaw?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw already knows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - the workspace path (`agents.defaults.workspace`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - the session model + heartbeats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - logging + troubleshooting patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You want the agent itself to call the tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw memory recall "…" --k 25 --since 30d`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw memory reflect --since 7d`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why still split a library?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- keep memory logic testable without gateway/runtime（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- reuse from other contexts (local scripts, future desktop app, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shape:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The memory tooling is intended to be a small CLI + library layer, but this is exploratory only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## “S-Collide” / SuCo: when to use it (research)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If “S-Collide” refers to **SuCo (Subspace Collision)**: it’s an ANN retrieval approach that targets strong recall/latency tradeoffs by using learned/structured collisions in subspaces (paper: arXiv 2411.14754, 2024).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pragmatic take for `~/.openclaw/workspace`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **don’t start** with SuCo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- start with SQLite FTS + (optional) simple embeddings; you’ll get most UX wins immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- consider SuCo/HNSW/ScaNN-class solutions only once:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - corpus is big (tens/hundreds of thousands of chunks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - brute-force embedding search becomes too slow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - recall quality is meaningfully bottlenecked by lexical search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Offline-friendly alternatives (in increasing complexity):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SQLite FTS5 + metadata filters (zero ML)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Embeddings + brute force (works surprisingly far if chunk count is low)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- HNSW index (common, robust; needs a library binding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SuCo (research-grade; attractive if there’s a solid implementation you can embed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open question:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- what’s the **best** offline embedding model for “personal assistant memory” on your machines (laptop + desktop)?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - if you already have Ollama: embed with a local model; otherwise ship a small embedding model in the toolchain.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Smallest useful pilot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a minimal, still-useful version:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `bank/` entity pages and a `## Retain` section in daily logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use SQLite FTS for recall with citations (path + line numbers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add embeddings only if recall quality or scale demands it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## References（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Letta / MemGPT concepts: “core memory blocks” + “archival memory” + tool-driven self-editing memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hindsight Technical Report: “retain / recall / reflect”, four-network memory, narrative fact extraction, opinion confidence evolution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision” approximate nearest neighbor retrieval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
