---
summary: "SNES Studio Project Command Center prompt-to-ROM workflow"
read_when:
  - You are implementing or operating the SNES Studio PCC workflow
  - You need to understand how one prompt becomes a verified SNES project
  - You are separating PCC scaffolding from finished game proof
title: "SNES Studio Workflow"
---

SNES Studio uses a Project Command Center (PCC) to keep long-running game work durable. The PCC owns state, milestones, locks, receipts, repairs, and pass/fail decisions. Agents produce bounded proposals; deterministic scripts validate, apply, build, test, and record receipts.

## Prompt To PCC

1. The user prompt is saved as project intent.
2. The PCC creates a milestone ledger and dependency DAG.
3. Legal and hardware constraints are recorded before creative work starts.
4. The next safe milestone is selected with `pnpm snes:team -- --mode next --project <id> --json`.

## PCC Commands

```bash
pnpm snes:team -- --mode init --project <id> --prompt <prompt-file> --json
pnpm snes:team -- --mode status --project <id> --json
pnpm snes:team -- --mode next --project <id> --json
pnpm snes:team -- --mode validate --project <id> --json
pnpm snes:team -- --mode repair-plan --project <id> --milestone <id> --json
pnpm snes:team -- --mode approvals --project <id> --json
pnpm snes:team -- --mode request-approval --project <id> --approval-type <type> --milestone <id> --json
pnpm snes:team -- --mode run --project <id> --max-milestones 10 --max-minutes 480 --json
pnpm snes:team -- --mode pause --project <id> --json
pnpm snes:team -- --mode resume --project <id> --json
pnpm snes:team -- --mode cancel --project <id> --json
pnpm snes:team -- --mode worker-packet --project <id> --milestone <id> --json
```

PCC v2 adds an overnight runner, approval queue, pause/resume/cancel, durable run summaries, and worker-packet export. It still does not automatically spend model calls or run live worker agents.

## Completion Rule

A game is complete only when all required project milestones pass and no required proof surface is blocked. A complete generic PCC state does not prove a specific game has production art, emulator proof, FXPAK copy proof, or hardware proof.

See also [agent routing](/reference/snes-studio-agent-routing), [proof gates](/reference/snes-studio-proof-gates), and [art pipeline](/reference/snes-studio-art-pipeline).

## Overnight Operation

The runner stops at completion, validation failure, retry blocker, pause/cancel, time limit, or a pending approval. Approval-gated actions include hosted GLM, paid tools/assets, FXPAK/removable writes, push/PR, original hardware proof, human production visual approval, and live model-spending automation.

## PCC v3 Multi-Agent Coordination

PCC v3 adds dispatch dry-runs, worker sandbox contracts, write-surface guards, patch application gates, local-only live worker dispatch, parallel scheduling metadata, model health routing, artifact cache metadata, reviewer receipts, conflict detection, compact memory cards, telemetry, dashboard snapshots, and legal clean-room prompt-to-ROM benchmark scaffolding. Hosted GLM, paid tools, commercial SNES material, FXPAK writes, push/PR, and human production visual approval remain approval-gated.

## Running local model workers

Use `pnpm snes:team -- --mode model-health --project <id> --json` before live work. Then use `pnpm snes:team -- --mode run-live --project <id> --local-only --invoke-local-models --max-minutes 480 --max-workers 4 --json` for bounded local model execution. PCC stops at approval gates, malformed outputs, repeated failures, human visual approval requirements, or unsafe write attempts.
