# Codex CLI Quick Reference

## Commands

| Command | Description |
|---------|-------------|
| `codex` | Launch interactive TUI |
| `codex exec <prompt>` | Non-interactive execution |
| `codex resume [--last]` | Continue previous session |
| `codex login` | Authenticate via OAuth |
| `codex logout` | Clear credentials |
| `codex apply <task_id>` | Apply Codex Cloud diff locally |
| `codex completion <shell>` | Generate shell completions |
| `codex mcp <subcommand>` | Manage MCP servers |
| `codex mcp-server` | Run Codex as MCP server |
| `codex cloud [exec]` | Manage Codex Cloud tasks |
| `codex sandbox` | Run commands in sandbox |

## Global Flags

| Flag | Values | Description |
|------|--------|-------------|
| `--model, -m` | string | Override model |
| `--image, -i` | path[,path...] | Attach images |
| `--cd, -C` | path | Set working directory |
| `--add-dir` | path | Add writable root |
| `--sandbox, -s` | read-only, workspace-write, danger-full-access | Sandbox policy |
| `--ask-for-approval, -a` | untrusted, on-failure, on-request, never | Approval mode |
| `--full-auto` | boolean | workspace-write + approve on failure |
| `--yolo` | boolean | No approvals or sandbox (dangerous) |
| `--profile, -p` | string | Config profile name |
| `--oss` | boolean | Use local Ollama |
| `--search` | boolean | Enable web search |
| `--json` | boolean | JSON output |

## codex exec Flags

| Flag | Description |
|------|-------------|
| `PROMPT` | Task instruction (or `-` for stdin) |
| `--skip-git-repo-check` | Allow non-Git directories |
| All global flags | Inherited |

## codex mcp Subcommands

| Subcommand | Description |
|------------|-------------|
| `list [--json]` | List configured MCP servers |
| `get <n> [--json]` | Show server config |
| `add <n> -- <cmd...>` | Add stdio server |
| `add <n> --url <url>` | Add HTTP server |
| `remove <n>` | Delete server |
| `login <n>` | OAuth for HTTP server |
| `logout <n>` | Clear OAuth |

## Slash Commands (TUI)

| Command | Description |
|---------|-------------|
| `/approvals` | Set approval mode |
| `/compact` | Summarize to free context |
| `/diff` | Show Git diff |
| `/exit`, `/quit` | Exit CLI |
| `/feedback` | Send logs to maintainers |
| `/init` | Generate AGENTS.md |
| `/logout` | Sign out |
| `/mcp` | List MCP tools |
| `/mention <path>` | Attach file |
| `/model` | Switch model |
| `/new` | Fresh conversation |
| `/review` | Code review |
| `/status` | Session info |
| `/undo` | Revert last turn |

## Approval Modes

| Mode | Read | Edit | Execute | Network |
|------|------|------|---------|---------|
| Auto | ✓ | ✓ (workspace) | ✓ (workspace) | Ask |
| Read Only | ✓ | Ask | Ask | Ask |
| Full Access | ✓ | ✓ | ✓ | ✓ |

## Sandbox Policies

| Policy | Description |
|--------|-------------|
| `read-only` | No writes allowed |
| `workspace-write` | Writes in workspace + /tmp |
| `danger-full-access` | No restrictions |

## Config File

Location: `~/.codex/config.toml`

```toml
[model]
default = "gpt-5-codex"

[features]
web_search_request = true
rmcp_client = true

[sandbox_workspace_write]
network_access = true

[mcp_servers]
# Defined via codex mcp add
```

## Custom Prompts

Location: `~/.codex/prompts/<n>.md`

```markdown
---
description: Short description
argument-hint: KEY=<value>
---

Prompt content with $KEY placeholders.
$1-$9 for positional args.
$ARGUMENTS for all args.
$$ for literal dollar sign.
```

## Session Files

Location: `~/.codex/sessions/`

## Auth Files

Location: `~/.codex/auth.json`

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error / task failure |
| Non-zero | git apply conflict, auth failure, etc |
