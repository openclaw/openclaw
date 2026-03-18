# Sense Worker Ops Workflow

## Purpose

Provide a minimal OpenClaw-side workflow for offloading selected text tasks from the T550 host to the Sense worker over LAN while keeping an ops-owned fallback path.

## Scope

- Primary owner: `ops`
- Primary tasks:
  - `summarize`
  - `generate_draft`
  - `analyze_text`
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

## Logging

The workflow writes a short request log to stderr:

- agent owner
- action/task
- target URL

The Sense adapter itself logs request / response / timeout details when invoked as a plugin tool.

## Success and fallback checks

- Success:
  - `pnpm sense:summarize -- --input "..."`
  - `pnpm sense:draft -- --input "..."`
  - `pnpm sense:analyze -- --input "..."`
- Fallback:
  - `pnpm sense:summarize -- --base-url http://192.168.11.11:9999 --input "..."`
  - `pnpm sense:draft -- --base-url http://192.168.11.11:9999 --input "..."`
  - `pnpm sense:analyze -- --base-url http://192.168.11.11:9999 --input "..."`

## Troubleshooting

- `401 Unauthorized`
  - `SENSE_WORKER_TOKEN` on T550 does not match the worker-side token.
  - helper workflows do not fallback on `401`; unauthorized should stay visible to the operator.
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
