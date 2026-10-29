# Claude Migration

Bring Claude Code and Claude Desktop instructions, MCP servers, and skills into
OpenClaw. The migration provider discovers supported local state and shows a
plan before applying changes.

## Get started

Preview the import:

```bash
openclaw migrate claude --dry-run
```

Use `--from <path>` to choose a Claude home or project. After reviewing the plan,
run `openclaw migrate apply claude` and follow the prompts. Apply backs up
existing OpenClaw state; target conflicts require an explicit decision.

Hooks, broad permission settings, and opaque credential state are not activated
automatically. Review archive-only items separately.

See [Migrating from Claude](https://docs.openclaw.ai/install/migrating-claude) for
import coverage, conflicts, and post-import verification.
