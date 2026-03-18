# Sense Worker Ops Workflow

## Purpose

Provide a minimal OpenClaw-side workflow for offloading summarize tasks from the T550 host to the Sense worker over LAN while keeping an ops-owned fallback path.

## Scope

- Primary owner: `ops`
- Primary task: `summarize`
- Transport: `POST http://192.168.11.11:8787/execute`
- Safe default: local fallback summary when Sense is unavailable or times out

## Command

```bash
cd /home/deepnoa/openclaw
pnpm sense:summarize -- --input "Long text to summarize"
```

You can also pass a file:

```bash
pnpm sense:summarize -- --input-file /path/to/input.txt
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

## Logging

The workflow writes a short request log to stderr:

- agent owner
- action/task
- target URL

The Sense adapter itself logs request / response / timeout details when invoked as a plugin tool.

## Next integration step

When plugin tools are consistently exposed inside the target agent runtime, replace this explicit helper workflow with a native agent-side call to `sense-worker(action=execute, task=summarize)` while keeping the same fallback contract.
