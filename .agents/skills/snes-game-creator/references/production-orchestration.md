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
```

PCC v1 is deterministic scaffolding. It writes task packets and validates receipts. It does not automatically spend model calls.

## Repair loop

On failure, classify the blocker as `invalid-patch`, `build-failure`, `runtime-failure`, `visual-failure`, `budget-failure`, or `external-blocker`. Retry once with the same role, once with a fallback local model, then require GPT 5.5 high-reasoning diagnosis. On the fourth failure, block unless the user approves deeper work.
