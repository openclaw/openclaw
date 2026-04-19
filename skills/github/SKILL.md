---
name: github
description: "GitHub operations via the `gh` CLI: issues, PRs, CI runs, code review, API queries. On Blink Claw, `gh` and `git` are pre-authenticated via the Blink GitHub App credential helper — no `gh auth login`, no PAT needed. Use when: (1) checking PR status or CI, (2) creating/commenting on issues, (3) listing/filtering PRs or issues, (4) viewing run logs. For cloning and REST via the connector, see the `blink-github` skill."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
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
            {
              "id": "apt",
              "kind": "apt",
              "package": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (apt)",
            },
          ],
      },
  }
---

# GitHub Skill (`gh` CLI)

Use the `gh` CLI for GitHub issues, PRs, CI, and API queries.

## Setup (Blink Claw — zero config)

On Claw machines `gh` and `git` are pre-authenticated via the Blink credential
helper — **never run `gh auth login`**. If `gh auth status` reports
"not logged in", the credential helper is still active and git/gh will
successfully fetch/push via HTTPS. You can verify with:

```bash
gh api /user --jq .login    # should print your GitHub username
blink github status         # shows the workspace installation + token expiry
```

If both of those fail, the workspace has no GitHub App installation yet —
run `blink github status` for the install link, or connect at
`https://blink.new/settings?tab=connectors`.

## When to Use

**USE this skill when:**
- Checking PR status, reviews, or merge readiness
- Viewing CI/workflow run status and logs
- Creating, closing, or commenting on issues
- Creating or merging pull requests
- Querying GitHub REST / GraphQL API

**DON'T use this skill when:**
- Cloning repos → use `git clone` directly, or `blink github clone`
  (both auto-auth via the Blink credential helper)
- Simple REST proxy calls → `blink connector exec github ...` is one line
- Local git operations (commit, push, pull, branch) → plain `git` works

## Common commands

### Pull Requests

```bash
gh pr list --repo owner/repo
gh pr checks 55 --repo owner/repo
gh pr view 55 --repo owner/repo
gh pr create --title "feat: add feature" --body "Description"
gh pr merge 55 --squash --repo owner/repo
```

### Issues

```bash
gh issue list --repo owner/repo --state open
gh issue create --title "Bug: something broken" --body "Details..."
gh issue close 42 --repo owner/repo
```

### CI/Workflow Runs

```bash
gh run list --repo owner/repo --limit 10
gh run view <run-id> --repo owner/repo
gh run view <run-id> --repo owner/repo --log-failed
gh run rerun <run-id> --failed --repo owner/repo
```

### API Queries

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
gh api repos/owner/repo/labels --jq '.[].name'
gh api graphql -f query='{ viewer { login } }'
```

## JSON Output

Most commands support `--json` for structured output with `--jq` filtering:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
gh pr list --json number,title,state,mergeable --jq '.[] | select(.mergeable == "MERGEABLE")'
```

## Notes

- Always specify `--repo owner/repo` when not in a git directory.
- Use URLs directly: `gh pr view https://github.com/owner/repo/pull/55`.
- Rate limits apply; use `gh api --cache 1h` for repeated queries.
