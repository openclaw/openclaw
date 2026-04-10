# Dali Memory (Canonical System-1)

This file is the canonical long-term memory root for node `dali`.

## Pinned State

### Active doctrine

- Mission: Build a cohesive, integrated collective intelligence symbiote that helps beings think, feel, remember, coordinate, and evolve together.
- Source UI is the active Dali-facing tasking surface; treat its runtime endpoint as deployment-specific.
- Task/state truth should be canonical at the backend, not merely cosmetically plausible in the UI.

### Active blockers

- Remote task/state views can still drift by browser/cache/render path.
- Cross-node ingestion depends on reachable runtime endpoints.
- Some orchestration surfaces remain stronger operationally than others.
- OpenClaw config/doctor flows can still leave `channels.telegram.streaming` serialized as object form (`{"mode":"off"}`), which earlier schema checks flagged as an invalid shape, so post-patch config verification still matters.

### Surface responsibilities

- Dali: orchestration, task truth, runtime surface coherence.
- Source UI: reliable reflection of queue / in-progress / review / done state.
- Symbiote loop: ingest c_lawd state cleanly when endpoint exposure is available.

### Durable operational state

- Workspace bootstrap is now concrete rather than template-state: repo-root and node bootstrap identity/user/memory files are meant to stay aligned, and `scripts/workspace-integrity.sh` is the fast check for parity and placeholder drift.
- `dali-local-v1` is the active local substrate lane: append-only SQLite memory store, reflection/promotion/semantic-indexing flows, broader durability telemetry (shadow/eval/checkpoint/rollback/NCA/adapter state), and compaction-learning logging now exist as real groundwork rather than just design intent.
- Dali now has a standing proactive improvement loop during Australia/Brisbane daytime hours; heartbeats are intentionally minimal and should only escalate when there is a concrete maintenance action or alert.
- Workspace policy now treats likely-recurring requests as prototype-then-codify infrastructure, with explicit skill ownership and cron promotion when repetition is real.
- Cost-control doctrine: preserve strong default thinking for normal/direct use, and push cheaper reasoning, lighter context, and other token-burn reductions onto explicitly bounded autonomous workers or tightly scoped continuation paths instead of weakening the global default profile.
- Commit hygiene doctrine: before making memory-only or other narrow commits in this workspace, inspect the staged set or use a path-limited commit, because pre-staged files can otherwise be swept in unintentionally.

Migration policy (one cycle):

- Legacy references to `system1` / `system-1` are normalized to `dali`.
- Legacy memory docs remain in place and should point to this node root.
