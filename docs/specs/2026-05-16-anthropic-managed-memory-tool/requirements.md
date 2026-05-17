# Requirements — Anthropic managed memory tool

## Outcome

When an agent runs on Claude Opus 4.7 (or any model that advertises the managed memory tool), it can read and write a per-agent `/memories/*` scratchpad using Anthropic's built-in memory tool primitive — alongside, not replacing, the existing custom `memory_search` / `memory_get` tools that index `MEMORY.md` and `memory/*.md` via BM25 + embeddings.

## Users affected

- Operators who run long-horizon agentic loops (multi-hour coding/agentic sessions) and want the model to keep state across turns.
- The agent runtime — `src/agents/pi-embedded-runner/` and `src/agents/tools/memory-tool.ts`.
- Storage layer: `~/.openclaw/agents/<agentId>/memories/` per-agent scratchpad root.

## In scope

- Wire Anthropic's `memory` tool primitive into the Pi-embedded runner extra-params when the active model + provider supports it.
- Map memory commands (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) to file operations under `~/.openclaw/agents/<agentId>/memories/` with path-traversal guards (must resolve under the per-agent root).
- Coexist with existing custom memory tools: `memory_search` (semantic recall over MEMORY.md + memory/*.md) and `memory_get` (path-scoped read).
- Per-session toggle (`memory.managed.enabled`) and per-agent root override (`memory.managed.root`).
- Surface memory operations in session transcripts so the operator can audit what the model wrote.

## Out of scope

- Rewriting the existing memory_search/get tools (they remain for cross-session structured recall).
- Cross-agent shared memory.
- Cloud-hosted memory (Anthropic's Managed Agents agent memory beta — that runs server-side at Anthropic; we stay client-side).
- Migrating the legacy MEMORY.md format to /memories/.

## Decisions

- Client-side managed memory only, not Managed Agents memory. Reason: openclaw is a single-operator local-first product; data stays on the operator's host.
- Per-agent root, not per-session. Reason: the operator's mental model is "this agent learned X" — `agentId` is the right cardinality.
- Co-exist with current memory tools rather than replace. Reason: `memory_search` indexes operator-curated MEMORY.md; the managed tool is a model-managed scratchpad. They serve different purposes.
- Path-traversal guard is hard-fail, not sanitize. Reason: never silently relocate model-written files; surface a tool error instead.
