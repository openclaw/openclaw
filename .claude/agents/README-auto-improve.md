# Auto-Improve Agent

## What It Is

A continuously-running Claude Code agent that analyzes real Operator1 gateway session logs and iteratively improves workspace prompt files. Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch) — treat prompt files as the "model" and session logs as the "eval set."

## How It Works

The agent follows a closed-loop experiment cycle:

```
Collect session logs --> Score metrics --> Classify issues:
  |-- Prompt-fixable --> Edit workspace file, commit, restart
  |-- Platform issue --> Create GitHub issue (for auto-fix agent)
  |-- Escalation -----> Create GitHub issue (3 failed prompt attempts)
Sleep 10m --> Repeat
```

1. **Collect** — Reads the 5 most recent JSONL session logs from all 4 agents (main, neo, morpheus, trinity)
2. **Score** — Runs `scripts/score.ts` for deterministic metrics (composite + per-agent diagnostics)
3. **Detect** — Runs `scripts/score.ts --diagnostics` for platform issues (tool timeouts, MCP failures, session aborts)
4. **File issues** — Creates GitHub issues for platform problems (deduped against existing issues)
5. **Compare** — If the previous prompt change improved the score, keep it. If it regressed, `git revert`.
6. **Target** — Finds the weakest prompt-fixable metric
7. **Edit** — Makes exactly ONE small change to ONE file, commits it
8. **Restart** — Restarts the gateway (only if no active subagent sessions)
9. **Sleep** — Waits 10 minutes for new session data, then loops back

The agent also verifies auto-fix results post-merge: if an error signature disappears from sessions, it closes the corresponding GitHub issue.

## What It Edits

Workspace prompt files under `workspaces/*/`:

- `AGENTS.md` — routing, delegation, memory protocol, channel rules
- `SOUL.md` — personality, conciseness, tone
- `TOOLS.md` — tool usage instructions
- `HEARTBEAT.md` — periodic heartbeat behavior, memory consolidation

It does NOT touch `IDENTITY.md`, `MEMORY.md`, source code, or config files.

## Relationship to Auto-Fix

The two agents form a closed feedback loop:

```
auto-improve                        auto-fix
  |                                   |
  |-- Detects platform issue -------->|
  |   (creates GitHub issue)          |
  |                                   |-- Investigates root cause
  |                                   |-- Creates PR with fix
  |                                   |
  |<-- Verifies post-merge -----------|
  |   (error gone? close issue)       |
  |   (error persists? reopen)        |
```

## Dispatching

```bash
# Run in background (recommended)
claude agents dispatch auto-improve

# Run interactively (for debugging)
claude agents run auto-improve
```

The agent uses model `sonnet` with up to 200 turns per session.

## Results

Tracked in `.claude/skills/auto-improve/data/results.tsv` — a tab-separated log of every iteration with scores, status (keep/discard), and a description of what changed.
