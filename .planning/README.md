# .planning/

This directory holds Getting-Shit-Done (GSD) workflow artifacts for non-trivial work on openclaw. It is committed (team-visible, multi-agent useful) unless the repo owner says otherwise.

## Layout

```
.planning/
  codebase/          # from /gsd:map-codebase — tech / arch / quality / concerns snapshots
  phases/<slug>/     # per-phase artifacts: PLAN.md, STATE.md, VERIFICATION.md, RESEARCH.md
  research/          # optional ad-hoc research notes not tied to a phase
```

## Workflow

1. Run `/gsd:map-codebase` once (and refresh when the repo shape meaningfully changes) to populate `codebase/`.
2. For new non-trivial work, start a phase: `/gsd:plan-phase <slug>` writes `phases/<slug>/PLAN.md`.
3. Execute with `/gsd:execute-phase <slug>` — updates `phases/<slug>/STATE.md`.
4. Verify with `/gsd:verify-work <slug>` — writes `phases/<slug>/VERIFICATION.md`.

## Scope

- This workflow is opt-in. Simple bug fixes and one-file changes do not need a phase.
- `.planning/` is NOT a substitute for CLAUDE.md, `AGENTS.md`, `docs/`, or changelog entries; it's scratch space for multi-step work.
- Do not commit `codebase/` regeneration output without review — map-codebase snapshots can be noisy.

## Not doing

- No retroactive roadmap for existing features (explicit decision 2026-04-18).
- No Obsidian↔`.planning/` sync automation until both surfaces stabilize.
