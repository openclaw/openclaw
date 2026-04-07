# Project Brief (OpenClaw Memory Hybrid Plugin)

- **Purpose:** A modular Memory Plugin for OpenClaw that handles hybrid storage (Vector/Semantic + Temporal via LanceDB) and Knowledge Graph representations (JSONL appending).
- **Key Mechanics:** Synthetic sleep states ("Dream Mode") compress/consolidate data, prevent memory growth bloat, and generate user empathy profiles through LLM calls.
- **Goal:** Harden the `memory-hybrid` plugin, addressing data loss mechanisms (Store-Before-Delete issues, race conditions, partial saves) before production merge.
