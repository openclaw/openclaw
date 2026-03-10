---
name: acp-router
description: Route plain-language requests for Pi, Claude Code, Codex, OpenCode, Gemini CLI, or ACP harness work into direct acpx-driven sessions or OpenClaw ACP runtime sessions.
user-invocable: false
---

# ACP Harness Router

When user intent is "run this in Pi/Claude Code/Codex/OpenCode/Gemini/Kimi (ACP harness)", route through ACP-aware flows. Do NOT use subagent runtime or PTY scraping.

## Intent detection

Trigger this skill when the user asks to:

- run something in Pi / Claude Code / Codex / OpenCode / Gemini / Kimi
- continue existing harness work
- relay instructions to an external coding harness

## Mode selection

**DEFAULT: Use direct `acpx` path (path 2) for ALL coding harness requests.**

Only use `sessions_spawn` (path 1) when the user explicitly asks for an "ACP thread" or "ACP session" by name.

Direct `acpx` path is preferred because:
- `sessions_spawn` with `thread: true` fails in commonly channel ("Thread bindings are unavailable")
- `sessions_spawn` with `mode: "session"` requires thread binding which also fails
- Direct acpx works reliably and supports persistent sessions natively

Do not ask the user which path to use. Do not ask for confirmation. Act immediately.

Do not use:
- `subagents` runtime for harness control
- PTY scraping of pi/claude/codex/opencode/gemini/kimi CLIs when `acpx` is available

## AgentId mapping

Use these immediately — never ask the user for agentId:

- "pi" → `pi`
- "claude" or "claude code" → `claude`
- "codex" → `codex`
- "opencode" → `opencode`
- "gemini" or "gemini cli" → `gemini`
- "kimi" or "kimi cli" → `kimi`

## Direct acpx path (DEFAULT)

ACPX binary (always use this exact path):
```
ACPX_CMD="/app/extensions/acpx/node_modules/.bin/acpx"
```

### Persistent session (use for "keep it going", "ongoing", "persistent")

```bash
# Create session if missing, then prompt
$ACPX_CMD <agent> sessions show <sessionName> 2>/dev/null \
  || $ACPX_CMD <agent> sessions new --name <sessionName>

$ACPX_CMD <agent> -s <sessionName> --cwd /workspace --format quiet "<prompt>"
```

Session name format: `oc-<agent>-<conversationId>` where conversationId = thread/channel id.

### One-shot

```bash
$ACPX_CMD <agent> exec --cwd /workspace --format quiet "<prompt>"
```

### After running: print the output to the user.

### Failure handling

- `NO_SESSION`: run `$ACPX_CMD <agent> sessions new --name <sessionName>` then retry once.
- Any other error: report clearly to user, do NOT ask permission to retry.
- If acpx binary missing: check `/app/extensions/acpx/node_modules/.bin/acpx` first. If missing, `cd /app/extensions/acpx && npm install --omit=dev --no-save acpx@0.1.15`.

## OpenClaw ACP runtime path (fallback only)

Only use if user explicitly requests `sessions_spawn` / ACP runtime. Use `sessions_spawn` with:
- `runtime: "acp"`, `agentId: <id>`, `mode: "session"`

If it returns any error → immediately switch to direct acpx path without asking.
