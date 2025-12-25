---
summary: "Background bash execution and process management"
read_when:
  - Adding or modifying background bash behavior
  - Debugging long-running bash tasks
---

# Background Bash + Process Tool

Clawdis runs shell commands through the `bash` tool and keeps long‑running tasks in memory. The `process` tool manages those background sessions.

## bash tool

Key parameters:
- `command` (required)
- `yieldMs` (default 20000): auto‑background after this delay
- `background` (bool): background immediately
- `timeout` (seconds): kill the process after this timeout
- `workdir`, `env`

Behavior:
- Foreground runs return output directly.
- When backgrounded (explicit or timeout), the tool returns `status: "running"` + `sessionId` and a short tail.
- Output is kept in memory until the session is polled or cleared.

Environment overrides:
- `PI_BASH_YIELD_MS`: default yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: in‑memory output cap (chars)
- `PI_BASH_JOB_TTL_MS`: TTL for finished sessions (ms, bounded to 1m–3h)

## process tool

Actions:
- `list`: running + finished sessions
- `poll`: drain new output for a session (also reports exit status)
- `log`: read the aggregated output (supports `offset` + `limit`)
- `write`: send stdin (`data`, optional `eof`)
- `kill`: terminate a background session
- `clear`: remove a finished session from memory
- `remove`: kill if running, otherwise clear if finished

Notes:
- Only backgrounded sessions are listed/persisted in memory.
- Sessions are lost on process restart (no disk persistence).
- Session logs are only saved to chat history if you run `process poll/log` and the tool result is recorded.

## Examples

Run a long task and poll later:
```json
{"tool": "bash", "command": "sleep 5 && echo done", "yieldMs": 1000}
```
```json
{"tool": "process", "action": "poll", "sessionId": "<id>"}
```

Start immediately in background:
```json
{"tool": "bash", "command": "npm run build", "background": true}
```

Send stdin:
```json
{"tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n"}
```
