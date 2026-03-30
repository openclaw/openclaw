# Sense Worker Ops Workflow

## Purpose

Provide a minimal OpenClaw-side workflow for offloading selected text tasks from the T550 host to the Sense worker over LAN while keeping an ops-owned fallback path.

## Scope

- Primary owner: `ops`
- Primary tasks:
  - `summarize`
  - `generate_draft`
  - `analyze_text`
  - `heavy_task` (first mode: `long_text_review`)
- Transport: `POST http://192.168.11.11:8787/execute`
- Auth: optional shared header `X-Sense-Worker-Token`
- Safe default: local fallback summary when Sense is unavailable or times out

## Command

```bash
cd /home/deepnoa/openclaw
pnpm sense:summarize -- --input "Long text to summarize"
```

Generate a short draft:

```bash
cd /home/deepnoa/openclaw
pnpm sense:draft -- --input "Prepare a short follow-up note for a corporate inquiry."
```

Run lightweight analysis:

```bash
cd /home/deepnoa/openclaw
pnpm sense:analyze -- --input "Identify the main themes, risks, and next action from this note."
```

Run the first heavy-task entrypoint:

```bash
cd /home/deepnoa/openclaw
pnpm sense:heavy -- --input "Review this long note and prepare the next stage for deeper processing."
```

Mode-specific heavy-task commands:

```bash
pnpm sense:heavy:review -- --input "Review this long note and prepare the next stage for deeper processing."
pnpm sense:heavy:ollama -- --input "Run lightweight ollama analysis for this note."
pnpm sense:heavy:nemo -- --input "Submit a NemoClaw async job for this note."
```

Check async job status:

```bash
pnpm sense:job-status -- --job-id <job_id>
pnpm sense:job-poll -- --job-id <job_id>
```

Run a separate NemoClaw-style worker loop:

```bash
export SENSE_WORKER_URL="http://192.168.11.11:8787"
export SENSE_WORKER_TOKEN="replace-with-shared-token"
export OLLAMA_HOST="http://192.168.11.11:11434"
export OLLAMA_MODEL="gpt-oss:20b"
pnpm sense:nemo-runner -- --once
```

For a long-running worker process, omit `--once`.

The runner sends `POST /jobs/{job_id}/heartbeat` while a job is in progress.
Defaults:

- requested interval: `30s`
- if the job payload includes `lease_timeout_sec`, the runner uses a safer interval:
  - `min(requested_interval, lease_timeout_sec * 0.4)`
  - never below `1s`

You can override the requested interval for testing:

```bash
pnpm sense:nemo-runner -- --heartbeat-interval 5 --once
```

You can also pass a file:

```bash
pnpm sense:summarize -- --input-file /path/to/input.txt
```

If shared-token auth is enabled on the worker, export the token first:

```bash
export SENSE_WORKER_TOKEN="replace-with-shared-token"
pnpm sense:summarize -- --input "Long text to summarize"
```

## Output contract

Successful Sense run prints the worker JSON result.

Fallback run prints JSON like:

```json
{
  "ok": true,
  "path": "local_fallback",
  "agent": "ops",
  "task": "summarize",
  "summary": "- ...",
  "error": "sense_worker_unavailable"
}
```

For `task=generate_draft`, fallback returns `draft` instead of `summary`.

For `task=analyze_text`, fallback returns:

```json
{
  "ok": true,
  "path": "local_fallback",
  "agent": "ops",
  "task": "analyze_text",
  "analysis": {
    "summary": "...",
    "key_points": ["...", "..."],
    "suggested_next_action": "..."
  },
  "error": "sense_worker_unavailable"
}
```

The fallback keeps the worker-style `body.result` / `body.meta` shape so downstream handling can stay close to the live worker contract.

For `task=heavy_task`, success and fallback both use a structured result shape:

```json
{
  "status": "ok",
  "result": {
    "accepted": true,
    "task_type": "heavy_task",
    "mode": "long_text_review",
    "scope": "gpu",
    "request_summary": "...",
    "message": "..."
  },
  "meta": {
    "node": "sense",
    "task": "heavy_task"
  }
}
```

For `mode=nemoclaw_job`, the worker returns an async job envelope:

```json
{
  "status": "ok",
  "result": {
    "accepted": true,
    "job_id": "...",
    "status": "queued",
    "target": "nemoclaw"
  },
  "meta": {
    "node": "sense",
    "task": "heavy_task"
  }
}
```

OpenClaw's `sense-task.js` also surfaces a top-level `job` helper object when possible:

```json
{
  "job": {
    "job_id": "...",
    "status": "queued",
    "target": "nemoclaw"
  }
}
```

`GET /jobs/{job_id}` returns one of:

- `queued`
- `running`
- `done`
- `job_not_found`

`GET /jobs/next` returns the next queued job and marks it `running`. The helper runner in
[`/Volumes/deepnoa/openclaw/scripts/dev/nemoclaw_runner.py`](/Volumes/deepnoa/openclaw/scripts/dev/nemoclaw_runner.py)
polls that endpoint, performs a minimal pseudo workload, and then calls
`POST /jobs/{job_id}/complete`.

The current runner stores a structured result:

```json
{
  "summary": "...",
  "key_points": ["...", "...", "..."],
  "suggested_next_action": "...",
  "raw_output": "...",
  "runner": "nemoclaw_runner",
  "exit_code": 0
}
```

The runner now attempts a real Ollama call first:

- endpoint: `POST $OLLAMA_HOST/api/generate`
- default URL: `http://192.168.11.11:11434`
- default model: `gpt-oss:20b`
- `stream: false`

Resolution order for the Ollama host is:

1. `params.ollama_host`
2. `OLLAMA_HOST`
3. legacy `--ollama-url` / `OLLAMA_URL`
4. default `http://192.168.11.11:11434`

It instructs Ollama to return JSON only:

```json
{
  "summary": "...",
  "key_points": ["..."],
  "suggested_next_action": "..."
}
```

If Ollama returns invalid JSON, the runner applies a lightweight local parse fallback.
If Ollama is unavailable or times out, the job still completes with `exit_code != 0` and an `error`
field in the stored result so operators can see the failure without losing the job record.
While the job is running, heartbeat success/failure is logged to stderr.

Quick connectivity check:

```bash
curl http://192.168.11.11:11434/api/tags
```

When a job result already matches the structured schema above, `sense-task.js` also surfaces:

- `normalized.summary`
- `normalized.key_points`
- `normalized.suggested_next_action`

## Logging

The workflow writes a short request log to stderr:

- agent owner
- action/task
- target URL

The Sense adapter itself logs request / response / timeout details when invoked as a plugin tool.

## Structured result adoption

OpenClaw-side workflow handling now treats worker details like this:

- `worker_state=success` and `structured_source=json_primary`
  - adopt as the best result
- `worker_state=success` and `structured_source=json_retry`
  - adopt and log that the worker used retry parsing
- `worker_state=success` and `structured_source=heuristic_fallback`
  - adopt and log that the worker used heuristic structuring
- `worker_state=unavailable` and `structured_source=unavailable`
  - do not trust remote content
  - switch to local fallback
- `401 Unauthorized`
  - do not fallback
  - keep the unauthorized failure visible

For operator workflows, a normalized top-level view is added when available:

- `normalized.summary`
- `normalized.key_points`
- `normalized.suggested_next_action`

## Success and fallback checks

- Success:
  - `pnpm sense:summarize -- --input "..."`
  - `pnpm sense:draft -- --input "..."`
  - `pnpm sense:analyze -- --input "..."`
  - `pnpm sense:heavy -- --input "..."`
  - `pnpm sense:heavy:nemo -- --input "..."`
  - `pnpm sense:job-status -- --job-id <job_id>`
  - `pnpm sense:nemo-runner -- --once`
- Fallback:
  - `pnpm sense:summarize -- --base-url http://192.168.11.11:9999 --input "..."`
  - `pnpm sense:draft -- --base-url http://192.168.11.11:9999 --input "..."`
  - `pnpm sense:analyze -- --base-url http://192.168.11.11:9999 --input "..."`
  - `pnpm sense:heavy -- --base-url http://192.168.11.11:9999 --input "..."`

## Troubleshooting

- `401 Unauthorized`
  - `SENSE_WORKER_TOKEN` on T550 does not match the worker-side token.
  - helper workflows do not fallback on `401`; unauthorized should stay visible to the operator.
- debug response modes
  - use only for validation or troubleshooting
  - normal production runs should not set `debug_response_mode`
- `fetch failed`
  - worker is unavailable, wrong base URL, or LAN route is down.
- timeout
  - increase `--timeout` or reduce worker-side processing time.

## Next integration step

When plugin tools are consistently exposed inside the target agent runtime, replace this explicit helper workflow with a native agent-side call to `sense-worker(action=execute, task=summarize)` while keeping the same fallback contract.

## Dispatcher note

- The current live worker already accepts arbitrary `task` names and returns a generic success envelope.
- The long-term worker-side direction is:
  - auth check
  - dispatcher
  - per-task handlers (`summarize`, `generate_draft`, `analyze_text`, future heavy tasks)
  - worker-internal adapters for Ollama / NemoClaw / GPU paths

## Heavy-task note

- Current first mode: `long_text_review`
- OpenClaw forwards:
  - `task: "heavy_task"`
  - `params.mode: "long_text_review"`
- Current known modes:
  - `long_text_review`
  - `ollama_analysis`
  - `nemoclaw_job`
- Future direction:
  - richer queueing metadata
  - GPU/NemoClaw/Ollama branching inside the worker
  - job status polling instead of immediate inline results

## Async NemoClaw job handling

- Submit:
  - `pnpm sense:heavy:nemo -- --input "..."`
- Status:
  - `pnpm sense:job-status -- --job-id <job_id>`
- Poll:
  - `pnpm sense:job-poll -- --job-id <job_id>`

OpenClaw treats the initial submit as an accepted async job, then uses `/jobs/{job_id}` to follow `queued / running / done / job_not_found`.
