---
name: codex-cli
description: "Use OpenAI Codex CLI for coding tasks. Triggers: codex, code review, fix CI, refactor code, implement feature, coding agent, gpt-5-codex. Enables Clawdbot to delegate coding work to Codex CLI as a subagent or direct tool."
---

# OpenAI Codex CLI Skill

Use OpenAI Codex CLI (`codex`) for coding tasks including code review, refactoring, bug fixes, CI repairs, and feature implementation. Codex CLI runs locally on your machine with full filesystem access.

## When to Use

- User asks for code changes, refactoring, or implementation
- CI/build failures need fixing
- Code review before commit/push
- Large codebase exploration or explanation
- Tasks requiring file editing + command execution
- When GPT-5-Codex model strengths are needed (code generation, tool use)

## Installation & Auth

Codex CLI requires ChatGPT Plus/Pro/Business/Enterprise subscription.

```bash
# Install
npm i -g @openai/codex

# Authenticate (opens browser for OAuth)
codex login

# Or use API key
printenv OPENAI_API_KEY | codex login --with-api-key

# Verify auth
codex login status
```

## Core Commands

### Interactive Mode (TUI)
```bash
codex                           # Launch interactive terminal UI
codex "explain this codebase"   # Start with a prompt
codex --cd ~/projects/myapp     # Set working directory
```

### Non-Interactive (Scripting)
```bash
codex exec "fix the CI failure"                    # Run and exit
codex exec --full-auto "add input validation"      # Auto-approve workspace writes
codex exec --json "list all API endpoints"         # JSON output for parsing
codex exec -i screenshot.png "match this design"   # With image input
```

### Session Management
```bash
codex resume               # Pick from recent sessions
codex resume --last        # Continue most recent
codex resume <SESSION_ID>  # Resume specific session
```

## Slash Commands (In TUI)

| Command | Purpose |
|---------|---------|
| `/model` | Switch model (gpt-5-codex, gpt-5) |
| `/approvals` | Set approval mode (Auto, Read Only, Full Access) |
| `/review` | Code review against branch, uncommitted changes, or specific commit |
| `/diff` | Show Git diff including untracked files |
| `/compact` | Summarize conversation to free context |
| `/init` | Generate AGENTS.md scaffold |
| `/status` | Show session config and token usage |
| `/undo` | Revert most recent turn |
| `/new` | Start fresh conversation |
| `/mcp` | List configured MCP tools |
| `/mention <path>` | Attach file to conversation |

## Approval Modes

| Mode | Behavior |
|------|----------|
| **Auto** (default) | Read/edit/run commands in workspace; asks for outside access |
| **Read Only** | Browse files only; requires approval for changes |
| **Full Access** | Full machine access including network (use sparingly) |

## Key Flags

| Flag | Purpose |
|------|---------|
| `--model, -m <model>` | Override model (gpt-5-codex, gpt-5) |
| `--cd, -C <path>` | Set working directory |
| `--add-dir <path>` | Add additional writable roots |
| `--image, -i <path>` | Attach image(s) to prompt |
| `--full-auto` | Workspace write + approve on failure |
| `--sandbox <mode>` | read-only, workspace-write, danger-full-access |
| `--json` | Output newline-delimited JSON |
| `--search` | Enable web search tool |

## Clawdbot Integration Patterns

### Pattern 1: Direct exec Tool
Call Codex from Clawdbot's exec tool for coding tasks:

```bash
# In Clawdbot session
exec codex exec --full-auto --cd ~/projects/medreport "fix the TypeScript errors in src/components"
```

### Pattern 2: Subagent Delegation
Spawn a coding subagent that uses Codex:

```json5
// In agents.defaults or per-agent config
{
  agents: {
    list: [
      {
        id: "coder",
        workspace: "~/clawd-coder",
        model: "openai-codex/gpt-5.2",  // Uses Codex auth
        tools: {
          allow: ["exec", "read", "write", "edit", "apply_patch", "process"]
        }
      }
    ]
  }
}
```

### Pattern 3: CLI Backend Fallback
Configure Codex as a text-only fallback:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "codex",
          args: ["exec", "--full-auto"],
          output: "text",
          sessionArg: null  // Codex manages its own sessions
        }
      }
    }
  }
}
```

### Pattern 4: MCP Server Mode
Run Codex as an MCP server for other agents:

```bash
codex mcp-server  # Exposes Codex tools via stdio MCP
```

## Clawdbot Config: OpenAI Codex Provider

Use your ChatGPT Pro subscription via the `openai-codex` provider:

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.2" },
      models: {
        "openai-codex/gpt-5.2": { alias: "Codex" },
        "anthropic/claude-opus-4-5": { alias: "Opus" }
      }
    }
  }
}
```

Auth syncs automatically from `~/.codex/auth.json` to Clawdbot's auth profiles.

## Code Review Workflow

```bash
# Interactive review
codex
/review  # Choose: branch, uncommitted, or specific commit

# Non-interactive
codex exec "review the changes in this PR against main branch"
```

## Multi-Directory Projects

```bash
# Work across monorepo packages
codex --cd apps/frontend --add-dir ../backend --add-dir ../shared

# Or in TUI
codex --cd ~/projects/myapp --add-dir ~/projects/shared-lib
```

## Custom Slash Commands

Create reusable prompts in `~/.codex/prompts/`:

```markdown
<!-- ~/.codex/prompts/pr.md -->
---
description: Prepare and open a draft PR
argument-hint: [BRANCH=<name>] [TITLE="<title>"]
---

Create branch `dev/$BRANCH` if specified.
Stage and commit changes with a clear message.
Open a draft PR with title $TITLE or auto-generate one.
```

Invoke: `/prompts:pr BRANCH=feature-auth TITLE="Add OAuth flow"`

## MCP Integration

Add MCP servers to extend Codex:

```bash
# Add stdio server
codex mcp add github -- npx @anthropic/mcp-server-github

# Add HTTP server
codex mcp add docs --url https://mcp.deepwiki.com/mcp

# List configured
codex mcp list
```

## Web Search

Enable in `~/.codex/config.toml`:

```toml
[features]
web_search_request = true

[sandbox_workspace_write]
network_access = true
```

Then Codex can search for current docs, APIs, etc.

## Best Practices

1. **Start with `/init`** to create AGENTS.md with repo-specific instructions
2. **Use `/review` before commits** for AI code review
3. **Set `/approvals` appropriately** — Auto for trusted repos, Read Only for exploration
4. **Use `--add-dir`** for monorepos instead of `danger-full-access`
5. **Resume sessions** to maintain context across coding sessions
6. **Attach images** for UI work, design specs, error screenshots

## Example Workflows

### Fix CI Failure
```bash
codex exec --full-auto "The CI is failing on the lint step. Fix all ESLint errors."
```

### Refactor Component
```bash
codex exec --cd src/components "Refactor UserProfile.tsx to use React Query instead of useEffect for data fetching"
```

### Implement Feature from Spec
```bash
codex exec -i spec.png --cd ~/projects/app "Implement this feature based on the design spec"
```

### Code Review PR
```bash
codex exec "Review the diff between main and feature/auth branch. Focus on security issues."
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Auth fails | Run `codex logout` then `codex login` |
| Commands blocked | Check `/approvals`, may need `--full-auto` |
| Out of context | Use `/compact` to summarize |
| Wrong directory | Use `--cd` flag or check `/status` |
| Model unavailable | Verify subscription tier supports model |

## References

- [Codex CLI Overview](https://developers.openai.com/codex/cli)
- [Codex CLI Features](https://developers.openai.com/codex/cli/features)
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference)
- [Slash Commands Guide](https://developers.openai.com/codex/cli/slash-commands)
- [AGENTS.md Spec](https://agents.md)
- [Codex GitHub](https://github.com/openai/codex)
