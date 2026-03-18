# OpenClaw Contribution Shortlist

This document turns the audit into proposal-shaped work items.

## Recommended first PR

### Memory diagnostics and backend health

Why this first:

- real operator value
- bounded subsystem
- lower coordination overhead than orchestration refactors
- easy to explain in a PR with before/after screenshots or CLI output

Problem:

- memory search can fail, scope out, or silently degrade in ways that are hard to inspect

First PR slice:

- add a unified status contract for memory managers
- surface provider, backend, last sync, fallback reason, and indexed source counts
- wire that into one operator-facing command or status block

Likely modules:

- `src/memory/manager.ts`
- `src/memory/qmd-manager.ts`
- `src/memory/search-manager.ts`
- `src/commands/*`

What makes this strong:

- it improves trust in a high-value subsystem
- it gives maintainers better bug reports
- it demonstrates product thinking, not just implementation ability

PR-ready spec:

- [Memory diagnostics and backend health PR spec](/design/openclaw-memory-diagnostics-pr-spec)

## High-upside proposal

### Agent run trace and explainability surface

Problem:

- debugging a single run requires correlating too many artifacts by hand

Proposed outcome:

- one structured trace per run with lifecycle checkpoints and final delivery metadata

First PR slice:

- define the trace shape
- record trace events for native agent runs only
- add a minimal CLI inspector

Likely modules:

- `src/agents/agent-command.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-subscribe.ts`
- `src/logging/*`

Why maintainers would care:

- better debugging
- better regression evidence
- foundation for future evals

## Architecture-forward proposal

### Unified execution target contracts

Problem:

- subagents, ACP sessions, and cron isolated jobs all express similar execution concepts differently

Proposed outcome:

- one shared contract for runtime kind, session behavior, delivery behavior, timeout, and thread binding

First PR slice:

- extract shared types and validation helpers
- do not change runtime behavior yet
- add docs that show where the semantics are currently duplicated

Likely modules:

- `src/agents/subagent-*`
- `src/acp/*`
- `src/cron/*`
- `src/gateway/server-methods/*`

Why this is valuable:

- reduces future drift
- makes orchestration work easier to reason about
- creates a clearer mental model for contributors and operators

## If you want the safest path to recognition

Use this sequence:

1. Open a GitHub Discussion summarizing the memory diagnostics problem and your proposed contract.
2. Ship the first PR with diagnostics only.
3. Follow with a second PR that adds one small UI or Gateway surface for the same diagnostics.

That pattern shows:

- systems understanding
- iteration discipline
- respect for maintainer review cost

## If you want the boldest path

Use this sequence:

1. Open a discussion proposing a run trace model.
2. Land a narrow trace foundation PR.
3. Follow with trace consumption in CLI or Control UI.

That path is higher risk, but it is also the kind of work that makes people look like long-term maintainers rather than casual contributors.
