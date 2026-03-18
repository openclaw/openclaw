---
name: blink-github
description: >
  Access GitHub repos, issues, PRs, code via the GitHub REST API. Use when asked
  to create issues, review PRs, check CI status, list repositories, or interact
  with GitHub. Requires a linked GitHub connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "github" } }
---

# Blink GitHub

Access the user's linked GitHub account. Provider key: `github`.

## List my repositories
```bash
bash scripts/call.sh github /user/repos GET
```

## Get a specific issue
```bash
bash scripts/call.sh github /repos/{owner}/{repo}/issues/{number} GET
```

## Create an issue
```bash
bash scripts/call.sh github /repos/{owner}/{repo}/issues POST '{"title":"Bug: something broken","body":"Steps to reproduce..."}'
```

## List open pull requests
```bash
bash scripts/call.sh github /repos/{owner}/{repo}/pulls GET '{"state":"open"}'
```

## Get PR details
```bash
bash scripts/call.sh github /repos/{owner}/{repo}/pulls/{pull_number} GET
```

## List repo issues
```bash
bash scripts/call.sh github /repos/{owner}/{repo}/issues GET '{"state":"open","per_page":20}'
```

## Get workflow runs (CI status)
```bash
bash scripts/call.sh github /repos/{owner}/{repo}/actions/runs GET '{"per_page":5}'
```

## Search code
```bash
bash scripts/call.sh github /search/code GET '{"q":"function+repo:{owner}/{repo}"}'
```

## Common use cases
- "Create a GitHub issue for the login bug" → POST /repos/{owner}/{repo}/issues
- "List open PRs in my repo" → GET /repos/{owner}/{repo}/pulls
- "Check CI status for the last commit" → GET /repos/{owner}/{repo}/actions/runs
- "What issues are assigned to me?" → GET /issues?assignee=@me
- "Show me the README of repo X" → GET /repos/{owner}/{repo}/contents/README.md
