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
