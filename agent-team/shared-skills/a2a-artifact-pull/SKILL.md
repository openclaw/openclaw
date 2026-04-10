---
name: a2a_artifact_pull
description: Use agent-to-agent direct (A2A) ONLY to pull a finished artifact file from another agent's workspace after a Slack pointer references it. Trigger whenever you see a Slack pointer like "File: files/YYYY-MM-DD/..." and you actually need the full artifact.
---

# A2A Artifact Pull

A2A (agent-to-agent direct) is enabled on this team **only** for pulling finished artifacts from another agent's `files/` folder. It is NEVER for tasking, discussion, or coordination — those stay in Slack channels.

## Hard rule

> A2A is ONLY for pulling finished artifacts from another agent's `workspace-<id>/files/` folder. NEVER use A2A for tasking, discussion, or coordination — those stay in Slack channels. If you catch yourself using A2A to ask a question, stop and post in Slack instead.

This rule is reproduced in every `AGENTS.md` and in `team-memory.md`.

## Trigger

- You are reading a Slack post with a pointer like `File: files/2026-04-10/quant-backtest-spy.json` and you actually need the full file (not just the headline metrics in the pointer).
- You are the Orchestrator assembling a `portfolio_decision_brief` and need the raw research markdown or backtest JSON behind a specialist pointer.
- You are Devil's Advocate checking a Quant artifact's assumptions before the stress test.

## Inputs

- The producing agent's workspace id (`scout`, `analyst`, `quant`, `devils-advocate`, `orchestrator`).
- The relative file path from the pointer (`files/YYYY-MM-DD/<filename>`).

## Steps

1. Verify the pointer actually exists in Slack. If you invented the path, stop — you are guessing, not pulling.
2. Construct the A2A pull: read from `workspace-<producer>/files/YYYY-MM-DD/<filename>`.
3. Load the file. If it does not exist, post in the producer's channel asking what happened — do NOT use A2A to ask.
4. Use the file contents for your current skill (brief, stress test, follow-up verification).
5. Do NOT modify the other agent's file. Pull only.

## Forbidden uses

- **Never** use A2A to ask a question. Questions go in Slack channels with explicit `@` mentions.
- **Never** use A2A to dispatch work. Dispatch goes in `#dispatch` via `explicit_dispatch`.
- **Never** use A2A to share an opinion, a thesis, or a review. Those go in the owning channel.
- **Never** use A2A to pull a file that has not been referenced by a Slack pointer. Undocumented pulls are invisible to the team and break the audit trail.

## Self-check

Before every A2A call, ask: "Is this a pull of a referenced file?" If the answer is no, cancel the A2A call and post in Slack instead.

## Next step

Return to the skill that triggered this pull. Do not append the pull itself to `files/index.md` — your own index is for files you produce, not files you consume.
