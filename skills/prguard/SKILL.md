---
name: prguard
description: GitHub App for automated PR/Issue triage — auto-label, auto-assign, and enforce PR standards.
homepage: https://github.com/alexmelges/prguard
metadata: { "openclaw": { "emoji": "🛡️", "requires": { "anyBins": ["gh"] } } }
---

# PRGuard

A GitHub App that automatically triages PRs and Issues — labels, assigns reviewers, enforces standards, and provides metrics.

## Installation

Install the GitHub App on your repo:

- **GitHub Marketplace:** [github.com/apps/prguard](https://github.com/apps/prguard)

## Configuration

Create `.github/prguard.yml` in your repo:

```yaml
labels:
  size:
    enabled: true
    thresholds: { s: 10, m: 50, l: 200, xl: 500 }
  type:
    enabled: true # bug, feature, chore, docs

assign:
  reviewers:
    enabled: true
    teams: ["core-reviewers"]

rules:
  require_description: true
  max_files_changed: 50
```

## BYOK (Bring Your Own Key)

Use your own OpenAI key for AI-powered triage:

```yaml
ai:
  enabled: true
  # Set OPENAI_API_KEY in repo secrets
```

## Check status via CLI

```bash
# View PRGuard check runs on a PR
gh pr checks <pr-number> --repo owner/repo

# View recent PRGuard activity
gh api repos/owner/repo/events --jq '.[] | select(.type | startswith("Pull")) | {type, created_at}'
```

## Links

- **Source:** [github.com/alexmelges/prguard](https://github.com/alexmelges/prguard)
- **Install:** [github.com/apps/prguard](https://github.com/apps/prguard)
