---
summary: "Run Harness status supervision from safe artifacts only"
read_when:
  - You need to summarize a durable Run Harness run
  - You need to explain OpenClaw execution routing lanes
  - You are checking that gates are surfaced but not auto-approved
title: "Durable Work Supervision"
---

# Durable Work Supervision

OpenClaw's durable work supervision surface summarizes Run Harness state from safe, explicit artifacts only. It does not read Codex private sqlite, logs, auth, cache, prompts, or raw transcript files, and it never approves gates.

## Safe artifact sources

The Node reader accepts:

- root run files: `task-graph.json`, `stage-manifest.json`, `state.json`, `artifacts.json`, `environment.json`, `request.md`, `plan.md`, `PROGRESS.md`, `GOAL.md`, `ENVIRONMENT.md`, `expert-graph.md`, `expert-graph.json`
- markdown evidence under `gates/`, `failures/`, `receipts/`, `reviews/`, and `verification/`

The reader rejects private or raw paths including `logs/`, `prompts/`, `auth/`, `cache/`, sqlite/db/WAL/SHM files, and filenames containing `transcript`.

## Routing lanes

- Direct Codex: small deterministic local work where normal verification is enough.
- `codex-superpowers-harness`: automation-heavy browser, visual, report, reviewer, and recovery work.
- `codex-multi-agent-harness`: worker/reviewer/verifier decomposition for complex tasks.
- Run Harness: durable phases, artifacts, receipts, reviews, verification, and gates.
- Ralph: adapter/delegated executor lane under a durable supervisor.

Run Harness gates are reported as pending blockers unless their artifact explicitly says they are approved. OpenClaw surfaces the gate and approval target; it does not mutate gate state.

## Node surface

`summarizeDurableRunFromArtifacts({ runRoot })` returns:

- run id, task statuses, stage statuses, gates, blockers
- receipt/review/verification artifact paths
- routing explanations
- `safety.gatesAutoApproved = false`
- `sourcesRead` and `loadErrors` for auditability

`tasksSupervisionCommand({ runRoot, json: true }, runtime)` exposes the same payload for command wiring and status integrations.
