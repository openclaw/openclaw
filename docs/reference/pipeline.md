# Release Pipeline

This document describes openclaw's staged release pipeline for contributors and maintainers.

## Branch Strategy

```
dev/* ──────► develop ──────► alpha ──────► beta ──────► main
feature/*         │              │            │            │
fix/*             │              │            │            │
                  ▼              ▼            ▼            ▼
              Internal       Alpha         Beta        Stable
              testing      testers       testers      release
```

### Branch Purposes

| Branch                        | Purpose             | npm tag   | Who uses it      |
| ----------------------------- | ------------------- | --------- | ---------------- |
| `dev/*`, `feature/*`, `fix/*` | Active development  | -         | Contributors     |
| `develop`                     | Integration branch  | -         | CI validation    |
| `alpha`                       | Early testing       | `@alpha`  | Internal testers |
| `beta`                        | Pre-release testing | `@beta`   | Beta testers     |
| `main`                        | Production releases | `@latest` | Everyone         |

## Workflow Overview

### 1. Feature Development

1. Create a branch: `git checkout -b dev/my-feature`
2. Make changes and push
3. **Auto-PR created** to `develop` via `feature-pr.yml`
4. Get review, iterate, merge to `develop`

### 2. Promotion Through Stages

When code lands in `develop`, the `promote-branch.yml` workflow:

1. Runs tests appropriate for that stage
2. Creates a PR to the next branch (develop → alpha → beta → main)
3. Auto-merges `develop → alpha` if tests pass
4. Requires manual approval for `alpha → beta` and `beta → main`

### 3. Releases

Releases are triggered manually via the **Release** workflow:

1. Go to Actions → Release → Run workflow
2. Select release type: `alpha`, `beta`, or `stable`
3. Workflow runs: version bump → changelog → tests → npm publish → Docker push

## Test Coverage by Stage

| Stage   | Tests Run                                             |
| ------- | ----------------------------------------------------- |
| develop | tsgo, lint, format, protocol, unit tests (Node + Bun) |
| alpha   | + secrets scan                                        |
| beta    | + Windows tests                                       |
| stable  | + macOS tests, install smoke tests                    |

## Emergency Hotfixes

For critical production issues:

1. Create branch: `git checkout -b hotfix/critical-bug`
2. Push → **Auto-PR created** directly to `main`
3. Get expedited review (skip staging)
4. After merge, cherry-pick to `develop`, `alpha`, `beta` to sync

```bash
# After hotfix merges to main
git checkout develop && git cherry-pick <commit-sha> && git push
git checkout alpha && git cherry-pick <commit-sha> && git push
git checkout beta && git cherry-pick <commit-sha> && git push
```

## npm Installation by Channel

```bash
# Stable (default)
npm install -g openclaw

# Beta testing
npm install -g openclaw@beta

# Alpha testing (bleeding edge)
npm install -g openclaw@alpha
```

## Docker Images

Images are published to GitHub Container Registry:

```bash
# Stable
docker pull ghcr.io/openclaw/openclaw:latest

# Beta
docker pull ghcr.io/openclaw/openclaw:beta

# Specific version
docker pull ghcr.io/openclaw/openclaw:2026.2.6
```

## Version Format

- **Stable**: `YYYY.M.D` (e.g., `2026.2.6`)
- **Beta**: `YYYY.M.D-beta.N` (e.g., `2026.2.6-beta.1`)
- **Alpha**: `YYYY.M.D-alpha.N` (e.g., `2026.2.6-alpha.3`)

## Setup

### Required Secrets

Configure these in GitHub repo Settings → Secrets and variables → Actions:

| Secret                | Required?            | Purpose                                                 | How to get it                                               |
| --------------------- | -------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `GITHUB_TOKEN`        | Automatic            | PR creation, Docker registry, branch ops                | Provided by GitHub Actions — no setup needed                |
| `NPM_TOKEN`           | Yes (for publishing) | npm publish with `@alpha`, `@beta`, `@latest` tags      | npmjs.com → Access Tokens → Generate New Token → Automation |
| `DISCORD_WEBHOOK_URL` | Optional             | Notifications for promotions, test results, deployments | Discord → Server Settings → Integrations → Webhooks         |

Without `NPM_TOKEN`, the pipeline runs normally but skips npm publishing. Without `DISCORD_WEBHOOK_URL`, notifications are silently skipped.

### Branch Setup

Staging branches are auto-created from `main` when the first promotion runs. No manual setup required.

### Rollback

The rollback workflow (`Actions → Rollback`) re-tags npm and Docker to a previous version. Requires `NPM_TOKEN` and is manual-trigger only.
