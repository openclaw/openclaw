---
name: channel-message-flows
description: "Use when running QA Lab channel message flow evidence."
---

# Channel Message Flows

Use this from the OpenClaw repo root to run the QA Lab evidence for Telegram
draft/final delivery sequencing. This skill no longer launches a standalone
script; the behavior is owned by the QA scenario and its Vitest-backed e2e test.

## QA Scenario

Run the scenario through QA Lab:

```bash
pnpm openclaw qa suite --scenario channel-message-flows
```

Run the focused e2e test directly in a Codex worktree:

```bash
node scripts/run-vitest.mjs extensions/telegram/src/channel-message-flows.qa.e2e.test.ts
```

## References

- `qa/scenarios/channels/channel-message-flows.yaml`
- `extensions/telegram/src/channel-message-flows.qa.e2e.test.ts`
- `extensions/telegram/src/test-support/channel-message-flows.ts`

The scenario covers `channels.streaming` as primary evidence and records
secondary coverage for thread preservation, delivery ordering, and reasoning
preview visibility.
