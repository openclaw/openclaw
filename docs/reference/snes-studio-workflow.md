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
```

PCC v1 is deterministic scaffolding. It does not automatically spend model calls or run live worker agents.

## Completion Rule

A game is complete only when all required project milestones pass and no required proof surface is blocked. A complete generic PCC state does not prove a specific game has production art, emulator proof, FXPAK copy proof, or hardware proof.

See also [agent routing](/reference/snes-studio-agent-routing), [proof gates](/reference/snes-studio-proof-gates), and [art pipeline](/reference/snes-studio-art-pipeline).
