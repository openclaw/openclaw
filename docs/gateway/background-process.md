---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Background exec execution and process management"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying background exec behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging long-running exec tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Background Exec and Process Tool"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Background Exec + Process Tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw runs shell commands through the `exec` tool and keeps long‑running tasks in memory. The `process` tool manages those background sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## exec tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `command` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `yieldMs` (default 10000): auto‑background after this delay（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `background` (bool): background immediately（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeout` (seconds, default 1800): kill the process after this timeout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevated` (bool): run on host if elevated mode is enabled/allowed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Need a real TTY? Set `pty: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `workdir`, `env`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Foreground runs return output directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When backgrounded (explicit or timeout), the tool returns `status: "running"` + `sessionId` and a short tail.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output is kept in memory until the session is polled or cleared.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the `process` tool is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Child process bridging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When spawning long-running child processes outside the exec/process tools (for example, CLI respawns or gateway helpers), attach the child-process bridge helper so termination signals are forwarded and listeners are detached on exit/error. This avoids orphaned processes on systemd and keeps shutdown behavior consistent across platforms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Environment overrides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `PI_BASH_YIELD_MS`: default yield (ms)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `PI_BASH_MAX_OUTPUT_CHARS`: in‑memory output cap (chars)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: pending stdout/stderr cap per stream (chars)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `PI_BASH_JOB_TTL_MS`: TTL for finished sessions (ms, bounded to 1m–3h)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config (preferred):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.backgroundMs` (default 10000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.timeoutSec` (default 1800)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.cleanupMs` (default 1800000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.notifyOnExit` (default true): enqueue a system event + request heartbeat when a backgrounded exec exits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## process tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `list`: running + finished sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `poll`: drain new output for a session (also reports exit status)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `log`: read the aggregated output (supports `offset` + `limit`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `write`: send stdin (`data`, optional `eof`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kill`: terminate a background session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clear`: remove a finished session from memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remove`: kill if running, otherwise clear if finished（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only backgrounded sessions are listed/persisted in memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions are lost on process restart (no disk persistence).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session logs are only saved to chat history if you run `process poll/log` and the tool result is recorded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `process` is scoped per agent; it only sees sessions started by that agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `process list` includes a derived `name` (command verb + target) for quick scans.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `process log` uses line-based `offset`/`limit` (omit `offset` to grab the last N lines).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a long task and poll later:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "tool": "process", "action": "poll", "sessionId": "<id>" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start immediately in background:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "tool": "exec", "command": "npm run build", "background": true }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send stdin:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
