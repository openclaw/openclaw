# coding-agent

Moltbot skill for orchestrating AI coding agents (Codex, Claude Code, Gemini CLI, Pi, OpenCode) via bash with PTY support and background process control.

## Features

- **Multi-agent support** - Codex CLI, Claude Code, Gemini CLI, Pi, OpenCode
- **Automatic fallback** - Falls back to Claude/Gemini when Codex hits limits
- **Background execution** - Run long tasks with session monitoring
- **PTY mode** - Proper terminal emulation for interactive CLIs
- **Parallel workflows** - Multiple agents via git worktrees or tmux
- **Agent forking** - Transfer context between different coding agents

## Quick Start

```bash
# One-shot task (Codex)
bash pty:true workdir:~/project command:"codex exec 'Add error handling'"

# Fallback to Claude Code
claude -p "Add error handling to src/api.ts"

# Fallback to Gemini
gemini "Add error handling to src/api.ts"

# Background with monitoring
bash pty:true workdir:~/project background:true command:"codex --full-auto 'Build a REST API'"
process action:log sessionId:XXX
```

## Requirements

At least one of these CLIs must be installed:
- `codex` - OpenAI Codex CLI
- `claude` - Claude Code CLI
- `gemini` - Gemini CLI
- `pi` - Pi Coding Agent
- `opencode` - OpenCode CLI

## Installation

Copy or symlink this skill to your Moltbot skills directory:

```bash
# Clone
git clone https://github.com/kesslerio/coding-agent-moltbot-skill.git

# Symlink to skills
ln -s /path/to/coding-agent-moltbot-skill ~/.moltbot/skills/coding-agent
```

## Documentation

See [SKILL.md](./SKILL.md) for complete documentation including:
- Bash tool parameters and process actions
- Codex, Claude Code, Gemini CLI command reference
- Fallback strategy and when to use each agent
- Parallel workflows with git worktrees
- tmux orchestration for advanced multi-agent control
- Best practices and learnings

Reference docs:
- [Claude Code Reference](./references/claude-code.md)
- [Gemini CLI Reference](./references/gemini-cli.md)

## License

MIT
