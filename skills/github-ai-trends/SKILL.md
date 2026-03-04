---
name: github-ai-trends
description: "AI 趋势追踪。Track AI/ML repos, stars, and trends on GitHub. Use when: (1) user asks for trending AI repos or topics, (2) compare stars/activity across repos, (3) list repos by topic or language, (4) recent releases or issues. Uses gh CLI and GitHub API."
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "requires": { "bins": ["gh"] },
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

# GitHub AI Trends (AI 趋势追踪)

Use the **gh** CLI (and GitHub API) to track AI/ML repos, stars, and activity.

## When to use

- “Trending AI repos”, “hot ML projects”, “most starred this week”
- Compare repos (stars, forks, last push)
- List repos by topic (`topic:machine-learning`, `topic:llm`)
- Recent releases or issues for a repo

## Setup

```bash
gh auth login
```

API key: use `gh` (uses auth from `gh auth login`) or set `GH_TOKEN` / `skills.entries["gh-issues"].apiKey` for API-only use.

## Commands (gh CLI)

```bash
# Search repos (topic + sort by stars)
gh search repos --topic machine-learning --sort stars --limit 20

# Repo info
gh repo view owner/repo --json name,stargazerCount,forkCount,pushedAt,description

# List releases
gh release list --repo owner/repo --limit 5

# Search issues
gh search issues --repo owner/repo --state open --limit 10
```

## Example workflows

- **Trending AI repos:** `gh search repos --topic llm --sort stars --limit 15`
- **Activity:** `gh repo view owner/repo --json pushedAt,stargazerCount`
- **Releases:** `gh release list -R owner/repo -L 5`

Combine with **coding-agent** or **github** skill when the user wants to clone, open PRs, or work inside a repo.
