# Validation — Anthropic managed memory tool

## Automated tests

- `src/agents/tools/managed-memory-tool.test.ts` — every command (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) round-trips against a tmp root.
- `src/agents/tools/managed-memory-tool.path-traversal.test.ts` — paths with `..`, absolute paths, and symlink escapes all reject with a typed error.
- `src/agents/pi-embedded-runner/managed-memory.test.ts` — extra-params payload contains the `memory` tool only when the capability flag is true.
- `src/agents/model-catalog.test.ts` — `supportsManagedMemoryTool` true for Opus 4.7 ids, false for Sonnet 4.6 / Haiku 4.5.
- Live test (gated on `OPENCLAW_LIVE_TEST=1`): run a multi-turn session on Opus 4.7 that asks the model to remember a fact, ends the session, starts a new one, and asks for recall — assert the scratchpad file exists with the expected content.

## Smoke checks

- `openclaw agent --message "remember that my preferred timezone is America/Lima"` on an Opus 4.7 session → file appears under `~/.openclaw/agents/<agentId>/memories/`.
- Restart the agent, ask "what's my timezone?" → reply includes Lima without re-prompting.
- `cat ~/.openclaw/agents/<agentId>/memories/.audit.jsonl` shows the write event.

## Manual criteria

- Audit JSONL is readable and useful for a human auditing what the model has written.
- Operator can purge the scratchpad easily (`rm -rf ~/.openclaw/agents/<agentId>/memories/`); the agent recovers without crashing.

## AI eval plan

- Success criteria: on a 20-prompt recall set ("remember X" → new session → "what's X?"), recall accuracy ≥ 95% with the managed tool enabled; ≤ 5% file-write churn for prompts that should NOT trigger memory (e.g. ephemeral chitchat).
- Eval dataset: `tests/evals/managed-memory-recall.jsonl` — paired remember/recall prompts + a control set of no-op prompts.
- Regression set: 5 prompts covering create, str_replace, delete, rename, and view-of-deleted-path-after-restart.
- Cadence: run on every PR touching `src/agents/tools/managed-memory-tool.ts` or `pi-embedded-runner/`. Nightly on the live-models matrix.

## Risks & rollback

- **Risks:**
  - Model writes secrets to memory files (API keys it saw during a session). *Detect via* a secret-scanner hook on memory writes (reuse `.secrets.baseline`).
  - Path-traversal regression hands the model the operator's home dir. *Detect via* the dedicated traversal test; defense in depth from `node:fs/promises` realpath check.
  - Audit log grows unbounded over long sessions. *Mitigate* with a daily rotation (handled by the existing logging subsystem).
- **Rollback:** set `memory.managed.enabled=false` in config; the tool stops being advertised to the model. PR revert is safe — the file root is additive.

## Open questions

- Default for `memory.managed.enabled`: `auto` (capability-based) or `off` (opt-in)? Lean `auto` but confirm before merging.
- Should the audit JSONL be queryable via `memory_search`? (Probably yes — adds reflection signal.)
