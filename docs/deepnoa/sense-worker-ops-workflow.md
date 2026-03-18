# Sense Worker Ops Workflow

## Purpose

Provide a minimal OpenClaw-side workflow for offloading selected text tasks from the T550 host to the Sense worker over LAN while keeping an ops-owned fallback path.

## Scope

- Primary owner: `ops`
- Primary tasks:
  - `summarize`
  - `generate_draft`
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
- Fallback:
  - `pnpm sense:summarize -- --base-url http://192.168.11.11:9999 --input "..."`
  - `pnpm sense:draft -- --base-url http://192.168.11.11:9999 --input "..."`

## Troubleshooting

- `401 Unauthorized`
  - `SENSE_WORKER_TOKEN` on T550 does not match the worker-side token.
- token header is sent but request still succeeds with a wrong token
  - current Sense worker is not yet enforcing token verification.
  - OpenClaw-side auth transport is ready, but worker-side `401` enforcement must be enabled on Sense.
- `fetch failed`
  - worker is unavailable, wrong base URL, or LAN route is down.
- timeout
  - increase `--timeout` or reduce worker-side processing time.

## Next integration step

When plugin tools are consistently exposed inside the target agent runtime, replace this explicit helper workflow with a native agent-side call to `sense-worker(action=execute, task=summarize)` while keeping the same fallback contract.
