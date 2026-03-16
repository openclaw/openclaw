---
name: claude-codex-delegation
description: Delegate code-writing, document generation, and analysis tasks to Claude Code or OpenAI Codex sub-processes. Use when you need to spawn a coding agent for file generation, code modification, script writing, or any multi-step coding task. Triggers on "delegate to claude", "delegate to codex", "use claude code", "use codex", "spawn coding agent", "run delegation", or when a task requires writing/modifying code that should be handed off to a sub-process.
metadata:
  { "openclaw": { "os": ["linux", "darwin"], "requires": { "anyBins": ["claude", "codex"], "bins": ["bash", "timeout"] } } }
---

# Claude Code + Codex Delegation

Delegate coding tasks to Claude Code or OpenAI Codex as sub-processes. Each delegation is self-contained — the sub-process has no access to the parent agent's conversation, tools, or MCP servers. It does have full filesystem access within the working directory you specify.

This skill extends the built-in `coding-agent` skill with concrete delegation scripts, tmux session management, and an example delegation policy. Use `coding-agent` for prompt composition guidance; use this skill when you need the actual execution infrastructure.

## Agent Selection

| Request | Agent | CLI |
|---------|-------|-----|
| Default / unspecified | Claude Code | `claude` |
| User says "use codex" | Codex | `codex` |
| User says "use claude code" | Claude Code | `claude` |

Never auto-select Codex. Only use it when the user explicitly requests it.

## Quick Delegation (One-Shot)

```bash
# Claude Code (no PTY needed)
cd /path/to/project && claude --permission-mode bypassPermissions --print 'Your task prompt'

# Codex (PTY required)
bash pty:true workdir:/path/to/project command:"codex exec --full-auto 'Your task prompt'"
```

## Delegation via Script

Use `scripts/delegate.sh` for structured delegation with logging:

```bash
# Claude Code (default)
scripts/delegate.sh --prompt "Build a REST API for todos" --workdir ~/project

# Codex
scripts/delegate.sh --agent codex --prompt "Refactor the auth module" --workdir ~/project

# From a prompt file
scripts/delegate.sh --file /tmp/task-prompt.md --workdir ~/project --log /tmp/task.log

# Background mode (returns immediately)
scripts/delegate.sh --background --prompt "Long running task" --workdir ~/project
```

## Long-Running Tasks in tmux

Use `scripts/tmux-session.sh` for persistent sessions (requires tmux):

```bash
# Start a delegation in a named tmux session
scripts/tmux-session.sh --name build-api --agent claude --workdir ~/project \
  --prompt "Build a REST API with authentication"

# Check session status
scripts/tmux-session.sh --status build-api

# Reattach to session
scripts/tmux-session.sh --attach build-api

# List all delegation sessions
scripts/tmux-session.sh --list
```

## Composing Self-Contained Prompts

The sub-process has no access to the parent agent's conversation, tools, or MCP servers. It can read and write files in the working directory, but has no other context. Include everything else it needs:

```markdown
# Task: [description]

## Context
[All relevant background — the sub-process has no conversation history]

## Verified Facts (use ONLY these)
[Every fact needed — do not assume the sub-process knows anything beyond the working directory]

## Anti-Hallucination Rule
Do not invent facts, numbers, names, or data not listed above.
If information is missing, use [TBD] as placeholder.

## Requirements
[Specific deliverable requirements — structure, format, audience]

## Output
[File format, naming, save location]
```

## Security: API Key Stripping

The delegation scripts strip 23 known AI provider API keys from the sub-process environment. This forces subscription/OAuth-based auth and prevents key leakage to child processes. The list is not exhaustive — if your environment includes provider keys not listed below, add them to the strip list in both scripts.

Keys stripped: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY`, `COHERE_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `GROQ_API_KEY`, `PERPLEXITY_API_KEY`, `BRAVE_API_KEY`, `BRAVE_SEARCH_API_KEY`, `REPLICATE_API_TOKEN`, `AI21_API_KEY`, `HUGGINGFACE_API_KEY`, `HF_TOKEN`, `VOYAGE_API_KEY`, `ANYSCALE_API_KEY`, `XAI_API_KEY`.

This is critical when running sub-processes that might:
- Spawn their own child processes
- Log environment variables
- Send telemetry containing env vars

Both `delegate.sh` and `tmux-session.sh` handle this automatically. For manual invocations, strip at minimum:

```bash
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY claude --permission-mode bypassPermissions --print 'task'
```

## ACP Runtime (If Available)

When OpenClaw's ACP runtime is configured, use it as the primary delegation path:

```
sessions_spawn with:
  runtime: "acp"
  agentId: "claude"       # or "codex" if explicitly requested
  task: "full prompt"     # self-contained (same rules as above)
  thread: true
  mode: "session"
```

Fall back to `delegate.sh` if ACP is unhealthy.

## Waiting for Results

When running in background mode, always poll for completion:

1. Launch the delegation
2. Poll with `process action:poll sessionId:XXX` or check the log file
3. Verify the output exists (`ls -lh /path/to/expected/output`)
4. Deliver the result to the user

Never end your turn after step 1 without polling. The user will not see the result otherwise.

## Session Resumption

Claude Code sessions are persistent. For follow-up amendments:

```bash
# Resume the most recent session in the working directory
cd /working/dir && claude --permission-mode bypassPermissions --print --continue "Make these changes: ..."

# Resume a specific session by ID
claude --permission-mode bypassPermissions --print --resume <session-id> "Amendments: ..."
```

## Resource Limits

- Each Claude Code process uses 300-400 MB RAM
- Avoid running more than 2-3 concurrent delegations on machines with less than 8 GB RAM
- Codex requires a git repository — use `mktemp -d && cd $_ && git init` for scratch work

## Delegation Policy

See `references/delegation-policy.md` for a complete example policy covering when to delegate, prompt composition, security, and result handling. Adopt or adapt it for your deployment.

## Rules

1. **Respect agent choice** — if the user asks for Codex, use Codex
2. **Never hand-code patches yourself** when orchestrating — delegate or ask the user
3. **Be patient** — do not kill sessions because they appear slow
4. **Monitor with logs** — check progress without interfering
5. **Never start coding agents in the OpenClaw config directory** — they may read and act on internal config
