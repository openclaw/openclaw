# Sense Worker Rules

This file is a focused supplement to [`DEEPNOA_RULES.md`](/Volumes/deepnoa/openclaw/DEEPNOA_RULES.md) for the
Sense/NemoClaw remote execution path.

## Role Split

- OpenClaw: orchestration, fallback, operator UX
- Sense worker: authenticated remote execution entrypoint
- NemoClaw runner: async execution worker that polls Sense jobs and completes them

## Stable Contracts

- Sense base URL default: `http://192.168.11.11:8787`
- Ollama host default: `http://192.168.11.11:11434`
- Worker auth header: `X-Sense-Worker-Token`
- Job routes:
  - `GET /jobs/next`
  - `GET /jobs/{job_id}`
  - `POST /jobs/{job_id}/complete`
  - `POST /jobs/{job_id}/heartbeat`

## Remote Execution Rules

- `401 unauthorized` must remain an explicit failure.
- Remote unavailable / timeout may use local fallback only in workflows that already define one.
- Do not weaken token checks for convenience during debugging.
- `debug_response_mode` is for validation only, not for normal operations.

## Structured Output Rules

Prefer structured outputs that can normalize into:

- `summary`
- `key_points`
- `suggested_next_action`

For async runner completions, also keep:

- `raw_output`
- `runner`
- `exit_code`
- optional `error`

## Async Runner Rules

- `nemoclaw_runner.py` should poll, lease, heartbeat, and complete jobs without mutating unrelated OpenClaw state.
- Heartbeat should be sent only while processing a job.
- Job completion should stop heartbeat cleanly.
- If Ollama fails, return structured fallback with `exit_code != 0` instead of dropping the job.
- Keep runner logic dependency-light so it can run on dedicated execution nodes.

## Git Hygiene

- Keep Sense/NemoClaw integration changes grouped in small commits.
- Do not mix unrelated gateway or UI edits into runner commits.
- When upstream changes touch tool/plugin plumbing, re-verify:
  - `pnpm sense:summarize`
  - `pnpm sense:analyze`
  - `pnpm sense:heavy:nemo`
  - `pnpm sense:job-status`
  - `pnpm sense:nemo-runner -- --once`
