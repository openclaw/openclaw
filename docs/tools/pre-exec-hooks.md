# Pre-Exec Hooks

Pre-exec hooks let workspace-level scripts intercept and approve/deny shell commands before they run. This provides a safety net for AI agent operations — preventing pushes to protected branches, writes to production databases, or dangerous file operations.

## How It Works

```
Agent runs: git push origin develop
         ↓
Clawdbot exec tool → runs pre-exec hooks
         ↓
~/.clawdbot/hooks/safe-git.sh → receives command as JSON
         ↓
Hook outputs: {"decision": "deny", "reason": "🚫 Protected branch"}
         ↓
Exec tool throws error instead of running command
```

## Hook Discovery

Hooks are discovered from these directories (in order):

1. `<workspace>/.clawdbot/hooks/` (preferred)
2. `<workspace>/hooks/` (fallback)

Any executable shell script in these directories is treated as a hook.

## Hook Protocol

### Input (JSON on stdin)

```json
{
  "tool_name": "exec",
  "tool_input": {
    "command": "git push origin main",
    "workdir": "/path/to/workspace",
    "env": {}
  }
}
```

### Output (JSON on stdout)

```json
{
  "decision": "approve",
  "reason": "optional message"
}
```

Or to deny:

```json
{
  "decision": "deny", 
  "reason": "🚫 Pushing to protected branches is blocked."
}
```

## Writing a Hook

Create an executable script in `.clawdbot/hooks/`:

```bash
#!/bin/bash
# .clawdbot/hooks/block-sudo.sh

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$COMMAND" | grep -qE '(^|\s)sudo\s'; then
  echo '{"decision": "deny", "reason": "🚫 sudo is not allowed."}'
  exit 0
fi

echo '{"decision": "approve"}'
```

Make it executable:

```bash
chmod +x .clawdbot/hooks/block-sudo.sh
```

## Example Hooks

Clawdbot includes example hooks in `examples/pre-exec-hooks/`:

### safe-git.sh

Blocks:
- Force pushes (`--force`, `-f`)
- Pushes to protected branches (main, develop, staging, production)
- Remote modifications (`git remote add/remove/set-url`)

### safe-db.sh

Blocks:
- Non-SELECT operations on remote databases
- Migrations/seeds targeting staging/production environments

### safe-rm.sh

Blocks:
- `rm -rf /`
- `rm` on home/system directories
- `rm -rf *` (wildcard deletion)

## Behavior

- **Sequential execution**: Hooks run in alphabetical order
- **Short-circuit**: First "deny" stops execution
- **Fail-open**: Timeouts and errors default to "approve"
- **Timeout**: 10 seconds per hook (configurable)

## Environment Variables

Hooks receive these environment variables:

| Variable | Description |
|----------|-------------|
| `CLAWDBOT_HOOK_NAME` | Name of the current hook |
| `CLAWDBOT_TOOL_NAME` | Tool being invoked (`exec` or `Bash`) |

## Tips

1. **Use jq** for parsing JSON input
2. **Keep hooks fast** — they run on every command
3. **Log to stderr** — only stdout is parsed
4. **Test locally** before deploying

```bash
# Test a hook manually
echo '{"tool_name":"exec","tool_input":{"command":"git push origin main"}}' | .clawdbot/hooks/safe-git.sh
```

## Related

- [Exec Tool](exec.md) — Shell command execution
- [Exec Approvals](exec-approvals.md) — Allowlist-based command approval
