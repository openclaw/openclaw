# SNES Studio Production Orchestration

Use the Project Command Center (PCC) for long-running SNES game work. The PCC owns state; agents are replaceable workers.

## PCC responsibilities

- Persist project intent, milestone ledger, dependency DAG, worker locks, decisions, memory cards, repairs, model use, and build history.
- Select the next milestone from receipts, not chat memory.
- Assign only one owner per write surface.
- Keep source, conversion, runtime, ROM, emulator, FXPAK, hardware, and human approval proof separate.
- Stop at external blockers instead of pretending completion.

## Completion runner

Use:

```bash
pnpm snes:team -- --mode init --project <id> --prompt <prompt-file> --json
pnpm snes:team -- --mode status --project <id> --json
pnpm snes:team -- --mode next --project <id> --json
pnpm snes:team -- --mode validate --project <id> --json
pnpm snes:team -- --mode repair-plan --project <id> --milestone <id> --json
pnpm snes:team -- --mode approvals --project <id> --json
pnpm snes:team -- --mode run --project <id> --max-milestones 10 --max-minutes 480 --json
pnpm snes:team -- --mode pause --project <id> --json
pnpm snes:team -- --mode resume --project <id> --json
pnpm snes:team -- --mode cancel --project <id> --json
pnpm snes:team -- --mode worker-packet --project <id> --milestone <id> --json
```

PCC v2 adds deterministic overnight runner scaffolding, approval queues, pause/resume/cancel, run history, summaries, and worker packets. It still does not automatically spend model calls.

## Repair loop

On failure, classify the blocker as `invalid-patch`, `build-failure`, `runtime-failure`, `visual-failure`, `budget-failure`, or `external-blocker`. Retry once with the same role, once with a fallback local model, then require GPT 5.5 high-reasoning diagnosis. On the fourth failure, block unless the user approves deeper work.

## Approval queue

PCC queues approvals for hosted GLM, paid tools or assets, FXPAK/removable writes, push/PR, original hardware proof, human production visual approval, and live model-spending automation. The runner stops instead of assuming approval.

## PCC v3 Multi-Agent Coordination

PCC v3 adds dispatch dry-runs, worker sandbox contracts, write-surface guards, patch application gates, local-only live worker dispatch, parallel scheduling metadata, model health routing, artifact cache metadata, reviewer receipts, conflict detection, compact memory cards, telemetry, dashboard snapshots, and legal clean-room prompt-to-ROM benchmark scaffolding. Hosted GLM, paid tools, commercial SNES material, FXPAK writes, push/PR, and human production visual approval remain approval-gated.

PCC v3 commands:

```bash
pnpm snes:team -- --mode dispatch-worker --project <id> --milestone <id> --dry-run --json
pnpm snes:team -- --mode dispatch-worker --project <id> --milestone <id> --local-only --json
pnpm snes:team -- --mode apply-worker-output --project <id> --worker-output <file> --json
pnpm snes:team -- --mode telemetry --project <id> --json
pnpm snes:team -- --mode dashboard-snapshot --project <id> --json
pnpm snes:team -- --mode regression-benchmark --project <id> --json
pnpm snes:team -- --mode run-live --project <id> --local-only --max-workers 4 --max-minutes 480 --json
```

## Live local model run commands

Preflight with `pnpm snes:team -- --mode model-health --project <id> --json`. Execute bounded live work with `pnpm snes:team -- --mode run-live --project <id> --local-only --invoke-local-models --max-minutes 480 --max-workers 4 --json`. Resume with `--mode resume-live` using the same local-only flags.
