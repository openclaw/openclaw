---
summary: "Where the Gateway keeps session rows and transcripts, and the on-disk paths per agent"
read_when:
  - "Debugging which store or transcript file a Gateway is actually using"
  - "Locating an agent session database or legacy artifacts on the Gateway host"
title: "Session state on disk"
---

## Two persistence layers

1. **Session rows (per-agent SQLite)** - key/value map `sessionKey -> SessionEntry`. Mutable runtime state owned by the Gateway. Tracks metadata: current session id, last activity, toggles, token counters.
2. **Transcript events (per-agent SQLite)** - append-only, tree-structured (entries have `id` + `parentId`). Stores the conversation, tool calls, and compaction summaries; rebuilds model context for future turns. Compaction checkpoints are metadata over the compacted successor transcript - a new compaction does not write a second `.checkpoint.*.jsonl` copy.

Older installs may still have `sessions.json` files under the agent `sessions/`
directory. Treat those files as legacy session-row migration inputs or explicit
offline-maintenance targets. Gateway startup does not import them. Stop the
Gateway, back up its state, and use `openclaw doctor --fix` to import legacy rows
and transcript history into the per-agent SQLite store. Run
`openclaw doctor --session-sqlite inspect --session-sqlite-all-agents`, then
follow the [Doctor migration sequence](/cli/doctor#session-sqlite-migration)
for inspection and validation. If a migration fails after legacy transcript
artifacts were archived, use the Doctor recovery mode from that sequence.
Recovery uses migration manifests, restores only the affected archived support
artifacts, prepares a sanitized GitHub issue report when requested, and does not
make active runtime read JSONL files again.

Gateway history readers avoid materializing the whole transcript unless the surface needs arbitrary historical access. First-page history, embedded chat history, restart recovery, and token/usage checks use bounded tail reads from SQLite. Full transcript scans go through the async transcript index and are shared across concurrent readers.

## On-disk locations

Per agent, on the Gateway host (resolved via `src/config/sessions.ts`):

- Runtime session row store: `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
- Runtime transcript rows: `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
- Legacy/archive transcript artifacts: `~/.openclaw/agents/<agentId>/sessions/`
- Legacy row migration input: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
