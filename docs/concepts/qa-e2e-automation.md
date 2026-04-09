---
summary: "Private QA automation shape for qa-lab, qa-channel, seeded scenarios, and protocol reports"
read_when:
  - Extending qa-lab or qa-channel
  - Adding repo-backed QA scenarios
  - Building higher-realism QA automation around the Gateway dashboard
title: "QA E2E Automation"
---

# QA E2E Automation

The private QA stack is meant to exercise OpenClaw in a more realistic,
channel-shaped way than a single unit test can.

Current pieces:

- `extensions/qa-channel`: synthetic message channel with DM, channel, thread,
  reaction, edit, and delete surfaces.
- `extensions/qa-lab`: debugger UI and QA bus for observing the transcript,
  injecting inbound messages, and exporting a Markdown report.
- `qa/`: repo-backed seed assets for the kickoff task and baseline QA
  scenarios.

The long-term goal is a two-pane QA site:

- Left: Gateway dashboard (Control UI) with the agent.
- Right: QA Lab, showing the Slack-ish transcript and scenario plan.

That lets an operator or automation loop give the agent a QA mission, observe
real channel behavior, and record what worked, failed, or stayed blocked.

## Repo-backed seeds

Seed assets live in `qa/`:

- `qa/QA_KICKOFF_TASK.md`
- `qa/seed-scenarios.json`

These are intentionally in git so the QA plan is visible to both humans and the
agent. The baseline list should stay broad enough to cover:

- DM and channel chat
- thread behavior
- message action lifecycle
- cron callbacks
- memory recall
- model switching
- subagent handoff
- repo-reading and docs-reading
- one small build task such as Lobster Invaders

## Reporting

`qa-lab` exports a Markdown protocol report from the observed bus timeline.
The report should answer:

- What worked
- What failed
- What stayed blocked
- What follow-up scenarios are worth adding

## Related docs

- [Testing](/help/testing)
- [QA Channel](/channels/qa-channel)
- [Dashboard](/web/dashboard)
