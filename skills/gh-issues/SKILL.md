---
name: gh-issues
description: "Fetch GitHub issues, spawn sub-agents to implement fixes and open PRs, then monitor and address PR review comments. Usage: /gh-issues [owner/repo] [--label bug] [--limit 5] [--milestone v1.0] [--assignee @me] [--fork user/repo] [--watch] [--interval 5] [--reviews-only] [--cron] [--dry-run] [--model glm-5] [--notify-channel -1002381931352]"
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["curl", "git", "gh"] },
        "primaryEnv": "GH_TOKEN",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# gh-issues — Auto-fix GitHub Issues with Parallel Sub-agents

You are an orchestrator. Follow these 6 phases exactly.

**IMPORTANT**: No `gh` CLI. Use curl + GitHub REST API exclusively. GH_TOKEN is in env — pass as Bearer token in all API calls.

For detailed phase instructions and sub-agent prompt templates, read `references/phases.md`.

---

## Phases Overview

| Phase | Name | Key action |
|-------|------|------------|
| 1 | Parse Arguments | Extract flags; if `--reviews-only` jump to Phase 6; if `--cron` force `--yes` |
| 2 | Fetch Issues | Resolve GH_TOKEN → curl issues API → filter out PRs |
| 3 | Present & Confirm | Show table; skip if `--dry-run`; auto-confirm if `--yes` |
| 4 | Pre-flight Checks | Dirty tree, base branch, remote access, token validity, existing PRs/branches, claims |
| 5 | Spawn Sub-agents | Cron: one agent fire-and-forget; Normal: up to 8 parallel |
| 6 | PR Review Handler | Fetch reviews, filter actionable, spawn review-fix agents |

## Flags Reference

| Flag | Default | Description |
|------|---------|-------------|
| `--label` | _(none)_ | Filter by label |
| `--limit` | 10 | Max issues to fetch |
| `--milestone` | _(none)_ | Filter by milestone title |
| `--assignee` | _(none)_ | Filter by assignee (`@me` for self) |
| `--state` | open | Issue state: open/closed/all |
| `--fork` | _(none)_ | Fork `user/repo` to push branches and PRs from |
| `--watch` | false | Keep polling after each batch |
| `--interval` | 5 | Minutes between polls (with `--watch`) |
| `--dry-run` | false | Fetch and display only — no sub-agents |
| `--yes` | false | Skip confirmation, auto-process all |
| `--reviews-only` | false | Skip Phases 2-5, only run Phase 6 |
| `--cron` | false | Fire-and-forget: spawn one agent and exit |
| `--model` | _(none)_ | Model for sub-agents (e.g. `glm-5`) |
| `--notify-channel` | _(none)_ | Telegram channel ID for final PR summary |

## Key Invariants

- **GH_TOKEN resolution**: env → `~/.openclaw/openclaw.json` `.skills.entries["gh-issues"].apiKey` → `/data/.clawdbot/openclaw.json`
- **Claims file**: `/data/.clawdbot/gh-issues-claims.json` — prevents duplicate processing; entries expire after 2h
- **Cursor file** (cron mode): `/data/.clawdbot/gh-issues-cursor-{SOURCE_REPO_SLUG}.json` — sequential issue tracking
- **Max concurrent sub-agents**: 8
- **Sub-agent timeout**: 3600s; `cleanup: "keep"`
- **PR branch pattern**: `fix/issue-{N}`
- **BOT_USERNAME**: Resolve via `GET /user` — exclude own comments in Phase 6

## Sub-agent Confidence Gate

Sub-agents self-assess before implementing. If confidence < 7/10, they skip and report why (vague requirements, can't locate code, scope too large, no clear fix).
