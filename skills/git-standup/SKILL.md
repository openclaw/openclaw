---
name: git-standup
description: Summarize recent git activity across local repos. Use when the user asks for a standup, dev summary, "what did I work on", recent commits, or repo activity overview. Shows commits, branches, and optionally open PRs via gh CLI. NOT for: detailed code review (use coding-agent), git operations like push/pull/merge, or GitHub issue management (use gh-issues).
metadata:
  { "openclaw": { "emoji": "📋", "requires": { "anyBins": ["git"] } } }
---

# Git Standup

Generate a quick developer standup summary from local git repositories.

## Usage

1. Identify target repos — ask the user or scan common locations
2. Run the standup script to gather recent activity
3. Summarize the output in a clean, human-readable format

## Quick Start

Run the bundled script against one or more repo paths:

```bash
bash SKILL_DIR/scripts/git-standup.sh [OPTIONS] [REPO_PATHS...]
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-d DAYS` | `1` | Look back N days |
| `-a AUTHOR` | git user.name | Filter by author |
| `-b` | off | Include branch summary |
| `-p` | off | Include open PRs (requires `gh` CLI) |

### Examples

```bash
# Yesterday's commits in current repo
bash SKILL_DIR/scripts/git-standup.sh .

# Last 3 days across multiple repos, with branches and PRs
bash SKILL_DIR/scripts/git-standup.sh -d 3 -b -p ~/projects/openclaw ~/projects/myapp

# Specific author
bash SKILL_DIR/scripts/git-standup.sh -a "yinfangchen" -d 7 ~/projects/openclaw
```

## Output Format

Present results grouped by repo:

```
📋 Git Standup — Last 1 day

## repo-name
**Commits (3):**
- abc1234 Fix auth token refresh logic (2h ago)
- def5678 Add rate limit tests (5h ago)  
- 789abcd Update README badges (8h ago)

**Active branches:** main, feature/oauth-refresh

**Open PRs:**
- #142 Fix token refresh (draft)
```

## When gh CLI is available

If `gh` is installed and authenticated, use `-p` to also fetch:
- Open PRs authored by the user
- PR review requests pending

## Tips

- For standup in a chat, keep output concise — bullet points, no diffs
- If scanning for repos, check `~/projects`, `~/code`, `~/src`, and `~/*.git`
- Respect the user's timezone when saying "today" vs "yesterday"
