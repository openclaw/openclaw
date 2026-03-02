# Kimi ACP Agent Adapter for OpenClaw

This directory contains a custom agent adapter that enables Kimi CLI to work as a first-class ACP agent in OpenClaw.

## Problem

The `acpx` npm package (v0.1.15) only has built-in support for:
- `codex` - OpenAI Codex CLI
- `claude` - Anthropic Claude Code  
- `gemini` - Google Gemini CLI
- `opencode` - OpenCode agent
- `pi` - Pi coding agent

Kimi CLI is not supported despite having native ACP support via `kimi acp`.

## Solution

This adapter creates a `kimi` command that wraps `kimi acp` and presents the same interface as other acpx built-in agents.

## Files

- `kimi-adapter.js` - The adapter script that translates acpx-style commands to Kimi CLI
- `install.sh` - Installation script to set up the adapter

## Usage

After installation, Kimi works like any other ACP agent:

```bash
acpx kimi "Write a Python function"
acpx kimi sessions new --name my-session
acpx kimi prompt --session my-session "Continue the task"
```

From OpenClaw:

```javascript
sessions_spawn({
  runtime: "acp",
  agentId: "kimi",
  task: "Write a Python function"
})
```

## Implementation Notes

The adapter:
1. Intercepts acpx-style commands (sessions, prompt, exec, etc.)
2. Translates them to Kimi CLI equivalents
3. Returns acpx-compatible JSON responses
4. Handles session management via local JSON files

## Limitations

- Session state is stored locally (in `~/.acpx-kimi/sessions/`)
- Not as robust as native acpx built-in agents
- Requires Kimi CLI to be installed separately

## Future Work

This adapter should be replaced by native Kimi support in the `acpx` npm package.
See: https://github.com/openclaw/openclaw/issues/32018