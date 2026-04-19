---
name: blink-github
description: >
  Access GitHub repos, issues, PRs, code, AND clone/push/PR via the Blink
  GitHub App. Use when asked to clone a repository, push changes, open a pull
  request, review PRs, create issues, check CI status, list repos, or
  otherwise interact with GitHub. Requires a linked GitHub connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "github" } }
---

# Blink GitHub

Full GitHub access — REST, clone, push, and PRs — backed by the workspace's
Blink GitHub App installation. Tokens are short-lived (1 h) and minted just
in time by the credential helper; **no PAT, no `gh auth login`, no secrets
on disk**.

## Quick reference

| Goal | Command |
|------|---------|
| Clone a repo | `blink github clone owner/repo` (or plain `git clone https://github.com/owner/repo.git`) |
| Push changes | `git push` |
| Open a PR | `gh pr create --fill` |
| Read status | `blink github status` |
| Print a token (scripting) | `blink github token --json \| jq -r .token` |
| REST call | `blink connector exec github /user/repos GET` |

## Clone, push, open a PR

```bash
# Clone — credentials are auto-minted by the Blink git credential helper.
git clone https://github.com/blink-new/auto-engineer.git
cd auto-engineer

# Or use the `blink` helper, which mints a scoped token and strips it from
# the saved remote URL after cloning:
blink github clone blink-new/auto-engineer

# Normal git and gh workflows — all auto-authenticated:
git checkout -b feat/my-change
# ...edit files...
git add .
git commit -m "my change"
git push -u origin feat/my-change
gh pr create --fill
```

**Why this works:** the Claw image ships a system-level git credential
helper (`/usr/local/bin/blink-git-credential`) that calls
`blink-apis /v1/github/mint-token` on demand. Tokens are scoped to this
workspace's GitHub App installation only, expire in 60 minutes, and are
never written to disk.

## Multi-account workspaces

If the workspace has multiple GitHub accounts linked (e.g. your personal
account + one or more org accounts), the right installation is chosen
automatically from the repo URL. You can also pick explicitly:

```bash
blink github status --account blink-new         # show a specific account
blink github clone blink-new/repo --account blink-new
blink github token --account blink-new          # mint a token for a specific account
blink github token --connection wcon_abc123     # mint by workspace_connections.id
```

Plain `git clone https://github.com/OWNER/repo.git` also picks the right
installation automatically because git sends the repo path to the Blink
credential helper.

## REST API

Use `blink connector exec github` for any REST endpoint — same mint pipeline,
server-side. Provider key: `github`.

```bash
# List my repositories
blink connector exec github /user/repos GET

# Get a specific issue
blink connector exec github /repos/{owner}/{repo}/issues/{number} GET

# Create an issue
blink connector exec github /repos/{owner}/{repo}/issues POST '{"title":"Bug: something broken","body":"Steps to reproduce..."}'

# List open pull requests
blink connector exec github /repos/{owner}/{repo}/pulls GET '{"state":"open"}'

# Get PR details
blink connector exec github /repos/{owner}/{repo}/pulls/{pull_number} GET

# Workflow runs (CI status)
blink connector exec github /repos/{owner}/{repo}/actions/runs GET '{"per_page":5}'

# Search code
blink connector exec github /search/code GET '{"q":"function+repo:{owner}/{repo}"}'
```

## Common use cases

- "Clone the project" → `blink github clone owner/repo`
- "Push my changes" → `git push` (credentials auto-minted)
- "Open a PR for this branch" → `gh pr create --fill`
- "Create a GitHub issue for the login bug" → `blink connector exec github /repos/{owner}/{repo}/issues POST ...`
- "Check CI status for the last commit" → `gh run list --limit 5` or `blink connector exec github /repos/{owner}/{repo}/actions/runs GET`
- "Show me the README of repo X" → `blink connector exec github /repos/{owner}/{repo}/contents/README.md GET`

## Troubleshooting

- **`remote: Repository not found`** on a repo you know exists → the repo is
  not included in the workspace's GitHub App installation. Add it at
  `https://blink.new/settings?tab=connectors` → GitHub → Configure.
- **`Please install the Blink GitHub App`** or `NO_INSTALLATION` error →
  the workspace has never completed the App install. Run
  `blink github status` for details; install at
  `https://blink.new/settings?tab=connectors`.
- **Token in a URL shows up in history** → use `blink github clone` (which
  strips the token post-clone) instead of manual `git clone https://x-access-token:...`.
- **Wrong account picked for a clone** → pass `--account <login>` or
  `--connection <id>` explicitly (see `blink github status`).
