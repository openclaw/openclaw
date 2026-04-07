---
name: openclaw-qa-testing
description: Run, watch, debug, and extend OpenClaw QA testing with qa-lab and qa-channel. Use when Codex needs to execute the repo-backed QA suite, inspect live QA artifacts, debug failing scenarios, add new QA scenarios, or explain the OpenClaw QA workflow. Prefer the live OpenAI lane with regular openai/gpt-5.4 in fast mode; do not use gpt-5.4-pro or gpt-5.4-mini unless the user explicitly overrides that policy.
---

# OpenClaw QA Testing

Use this skill for `qa-lab` / `qa-channel` work. Repo-local QA only.

## Read first

- `docs/concepts/qa-e2e-automation.md`
- `docs/help/testing.md`
- `docs/channels/qa-channel.md`
- `qa/QA_KICKOFF_TASK.md`
- `qa/seed-scenarios.json`
- `extensions/qa-lab/src/suite.ts`

## Model policy

- Live OpenAI lane: `openai/gpt-5.4`
- Fast mode: on
- Do not use:
  - `openai/gpt-5.4-pro`
  - `openai/gpt-5.4-mini`
- Only change model policy if the user explicitly asks.

## Default workflow

1. Read the seed plan and current suite implementation.
2. Decide lane:
   - mock/dev: `mock-openai`
   - real validation: `live-openai`
3. For live OpenAI, use:

```bash
OPENCLAW_LIVE_OPENAI_KEY="${OPENAI_API_KEY}" \
pnpm openclaw qa suite \
  --provider-mode live-openai \
  --model openai/gpt-5.4 \
  --alt-model openai/gpt-5.4 \
  --output-dir .artifacts/qa-e2e/run-all-live-openai-<tag>
```

4. Watch outputs:
   - summary: `.artifacts/qa-e2e/run-all-live-openai-<tag>/qa-suite-summary.json`
   - report: `.artifacts/qa-e2e/run-all-live-openai-<tag>/qa-suite-report.md`
5. If the user wants to watch the live UI, find the current `openclaw-qa` listen port and report `http://127.0.0.1:<port>`.
6. If a scenario fails, fix the product or harness root cause, then rerun the full lane.

## Repo facts

- Seed scenarios live in `qa/`.
- Main live runner: `extensions/qa-lab/src/suite.ts`
- QA lab server: `extensions/qa-lab/src/lab-server.ts`
- Child gateway harness: `extensions/qa-lab/src/gateway-child.ts`
- Synthetic channel: `extensions/qa-channel/`

## What “done” looks like

- Full suite green for the requested lane.
- User gets:
  - watch URL if applicable
  - pass/fail counts
  - artifact paths
  - concise note on what was fixed

## Common failure patterns

- Live timeout too short:
  - widen live waits in `extensions/qa-lab/src/suite.ts`
- Discovery cannot find repo files:
  - point prompts at `repo/...` inside seeded workspace
- Subagent proof too brittle:
  - prefer stable final reply evidence over transient child-session listing
- Harness “rebuild” delay:
  - dirty tree can trigger a pre-run build; expect that before ports appear

## When adding scenarios

- Add scenario metadata to `qa/seed-scenarios.json`
- Keep kickoff expectations in `qa/QA_KICKOFF_TASK.md` aligned
- Add executable coverage in `extensions/qa-lab/src/suite.ts`
- Prefer end-to-end assertions over mock-only checks
- Save outputs under `.artifacts/qa-e2e/`
