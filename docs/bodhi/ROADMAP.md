# OpenBodhi Roadmap

> Building in public. Follow on GitHub Discussions or watch the repo for updates.

---

## Phase 0: Foundation (current)

**Status:** In progress

- [x] Fork OpenClaw
- [x] Documentation, architecture, and ontology specs
- [x] GitHub repo setup
- [ ] Public landing page (self-host your own)
- [ ] Community: GitHub Discussions, contribution guidelines

---

## Phase 1: Local Gateway

**Goal:** Get OpenClaw running on a home desktop, connected to Signal.

- [ ] Run OpenClaw Gateway on dedicated machine (localhost only)
- [ ] Connect Telegram bridge via OpenClaw
- [ ] Configure Anthropic API key
- [ ] Set up Ollama with nomic-embed-text embedding model
- [ ] Docker Compose for isolated development
- [ ] Verify end-to-end: Telegram message → Gateway → Claude response

**Outcome:** A working local AI gateway that responds to Telegram messages.

---

## Phase 2: Curator Worker

**Goal:** First custom skill. Raw message becomes a typed vault node.

- [ ] Scaffold `skills/bodhi-curator` as OpenClaw skill
- [ ] Capture pipeline: incoming message → Claude parse → classify complexity
- [ ] Simple path: straight to vault with tags + node type
- [ ] Complex path: 2-3 clarifying questions → then file
- [ ] Energy level prompt (1-5 scale) after classification
- [ ] Node type classification (6 types: Idea, Pattern, Practice, Decision, Synthesis, Integration)
- [ ] Local ChromaDB for vector storage
- [ ] JSON file persistence for graph nodes

**Outcome:** Every Telegram message becomes a structured vault node with type, tags, and energy level.

---

## Phase 3: Vault + Ontology

**Goal:** The vault becomes queryable. Relationships form.

- [ ] Implement typed node schema (see `vault/schema/nodes.json`)
- [ ] Relationship graph with 6 edge types (see `vault/schema/edges.json`)
- [ ] Local storage: JSON files (graph) + ChromaDB (vectors)
- [ ] Query interface: "show me all Decisions from last week"
- [ ] Node deduplication on write (cosine similarity check)
- [ ] Basic relationship inference (Curator adds LEADS_TO edges on clarification paths)

**Outcome:** A navigable knowledge graph of your captured ideas.

---

## Phase 4: Distiller Worker

**Goal:** Morning digest. Weekly synthesis. Patterns surface.

- [ ] Scaffold `skills/bodhi-distiller` as cron skill
- [ ] Daily 6am synthesis job
- [ ] 7-day rolling window analysis
- [ ] Recurring pattern detection (same tag appearing 3+ times)
- [ ] Morning digest generation via Claude
- [ ] Telegram delivery of digest
- [ ] Pattern flagging: recurring ideas highlighted with frequency count

**Outcome:** Every morning, Bodhi sends a short synthesis of what your mind has been working on.

---

## Phase 5: Janitor + Surveyor Workers

**Goal:** Vault hygiene. Structural insight through clustering.

**Janitor:**
- [ ] Scaffold `skills/bodhi-janitor` as weekly cron skill
- [ ] Orphan detection (nodes with no edges)
- [ ] Duplicate detection (cosine similarity > 0.92 threshold)
- [ ] Broken edge detection and repair suggestions
- [ ] Generate hygiene report → send for human approval before any changes

**Surveyor:**
- [ ] Scaffold `skills/bodhi-surveyor` as weekly cron skill
- [ ] Embed all vault nodes into vector space
- [ ] HDBSCAN clustering
- [ ] Cluster labeling via Claude
- [ ] Bridge node discovery: ideas that connect otherwise separate clusters
- [ ] Auto-generate Synthesis nodes with SURFACES_FROM edges
- [ ] SOC analysis: power law distribution of energy levels

**Outcome:** The vault self-organizes. Bridges between idea clusters appear. Orphans get cleaned up.

---

## Phase 6: Nudge System

**Goal:** Bodhi notices when you are ready to act.

- [ ] Track idea recurrence over time (same node accessed or related to 3 days in a row)
- [ ] Energy threshold detection (energy level 4-5 appearing consistently)
- [ ] Nudge trigger: "Ready to act?" sent via Signal
- [ ] Priority surfacing based on SOC dynamics (avalanche threshold)
- [ ] Configurable nudge frequency to prevent notification fatigue

**Outcome:** One message, at the right time: "Ready to act?"

---

## Future

- Client-facing publish capabilities (share a synthesis note publicly)
- SiYuan integration for long-form structured notes
- WhatsApp and Signal bridge support (inherited from OpenClaw)
- Advanced SOC modeling (Per Bak's sandpile applied to cognitive load)
- Network isolation: Docker Compose with whitelist-only egress (api.anthropic.com)

---

*Roadmap is a living document. Each phase ships when it works, not on a calendar.*
