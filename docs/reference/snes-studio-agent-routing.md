---
summary: "SNES Studio PCC agent roles, model routing, and parallel work policy"
read_when:
  - You are assigning SNES Studio PCC work to agents
  - You are changing local model defaults for SNES worker roles
  - You need to know which SNES tasks may run in parallel
title: "SNES Studio Agent Routing"
---

SNES Studio uses deterministic orchestration first. Model calls are explicit, receipt-backed, and avoided for routine state checks.

## Default Model Routing

| Role                   | Default                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Producer Orchestrator  | deterministic script                                                                     |
| Initial blueprint      | GPT 5.5 high reasoning, approval-gated                                                   |
| Routine worker patches | `ollama/openclaw-control-qwen3-30b-q6-chatfix:latest`                                    |
| Quality fallback       | `ollama/openclaw-control-qwen36-27b:latest`                                              |
| Speed fallback         | `ollama/openclaw-control-qwen25-32b:latest`                                              |
| Final approval         | deterministic receipts, GPT 5.5 high reasoning, and human visual approval where required |

## Parallel Work

The PCC may run these worker plans in parallel when write surfaces do not overlap:

- level design;
- gameplay feel;
- art intent contracts;
- audio and SPC700 planning;
- hardware budget planning.

Run these sequentially:

- initial blueprint;
- integration;
- ROM build;
- milestone judging;
- final release approval.

Max default parallelism is four workers. A worker must not judge its own milestone.

## PCC v2 worker packets

Use `pnpm snes:team -- --mode worker-packet --project <id> --milestone <id> --json` to export a bounded task packet. The packet lists owner role, allowed write surfaces, proof requirements, pass/fail criteria, forbidden actions, model policy, and the next validation command. Routine packets default to `gpt55Used: false` and `hostedGlmUsed: false`.

## PCC v3 Multi-Agent Coordination

PCC v3 adds dispatch dry-runs, worker sandbox contracts, write-surface guards, patch application gates, local-only live worker dispatch, parallel scheduling metadata, model health routing, artifact cache metadata, reviewer receipts, conflict detection, compact memory cards, telemetry, dashboard snapshots, and legal clean-room prompt-to-ROM benchmark scaffolding. Hosted GLM, paid tools, commercial SNES material, FXPAK writes, push/PR, and human production visual approval remain approval-gated.

## PCC real local model execution

PCC can now distinguish dry-run worker dispatch from real local-only Ollama dispatch. Dry runs keep `modelInvoked: false`; `--local-only --invoke-local-models` must call a local Ollama/OpenClaw model, validate strict JSON worker output, and record model, prompt SHA, response SHA, latency, and validation status. Hosted GPT/GLM remains approval-gated and is not used by routine PCC workers.
