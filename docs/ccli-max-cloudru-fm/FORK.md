# Cloud.ru FM Integration — Fork

## Repository

**Fork:** https://github.com/dzhechko/openclaw
**Upstream:** https://github.com/openclaw/openclaw
**Development branch:** `cloudru-fm`
**Main branch:** `main` (kept in sync with upstream)

> **Note:** The `main` branch of the fork is kept clean and identical to
> upstream. All Cloud.ru FM changes live exclusively on the `cloudru-fm`
> branch. This simplifies upstream syncing and makes it easy to create
> a clean pull request to upstream when ready.

## What was changed

Cloud.ru Foundation Models added as a first-class provider in OpenClaw.
Users can select Cloud.ru FM during `openclaw onboard` wizard and choose
between three model presets:

| Preset | Big Model | Middle Model | Small Model | Free? |
|--------|-----------|-------------|-------------|-------|
| GLM-4.7 (Full) | GLM-4.7 | GLM-4.7-FlashX | GLM-4.7-Flash | No |
| GLM-4.7-Flash | GLM-4.7-Flash | GLM-4.7-Flash | GLM-4.7-Flash | Yes |
| Qwen3-Coder-480B | Qwen3-Coder-480B | GLM-4.7-FlashX | GLM-4.7-Flash | No |

## Changed files (on `cloudru-fm` branch)

### New files
- `src/config/cloudru-fm.constants.ts` — models, presets, proxy config (SoT)
- `src/commands/auth-choice.apply.cloudru-fm.ts` — wizard handler
- `src/commands/onboard-cloudru-fm.ts` — .env writer, gitignore, preset resolver
- `src/commands/cloudru-rollback.ts` — config rollback utility
- `src/agents/cloudru-proxy-template.ts` — Docker Compose generator
- `src/agents/cloudru-proxy-health.ts` — health check with 30s cache

### Modified files
- `src/commands/onboard-types.ts` — 3 new AuthChoice values
- `src/commands/auth-choice-options.ts` — cloudru-fm group
- `src/commands/auth-choice.apply.ts` — handler registration

## How it works

```
User -> openclaw onboard -> selects "Cloud.ru FM"
  -> Wizard collects API key (prompt / env / CLI flag)
  -> Writes CLOUDRU_API_KEY to .env (never to config)
  -> Configures openclaw.json with proxy provider + CLI backend
  -> Generates docker-compose.cloudru-proxy.yml
  -> Runs pre-flight health check

Claude Code CLI -> localhost:8082 (proxy) -> cloud.ru FM API
```

## Working with the fork

### Cloning for development

```bash
git clone https://github.com/dzhechko/openclaw.git
cd openclaw
git checkout cloudru-fm
pnpm install
```

### Syncing `cloudru-fm` with upstream

```bash
cd openclaw

# One-time: add upstream remote
git remote add upstream https://github.com/openclaw/openclaw.git

# Sync main with upstream
git checkout main
git pull upstream main
git push origin main

# Rebase cloudru-fm onto updated main
git checkout cloudru-fm
git rebase main
# Resolve conflicts if any
git push --force-with-lease origin cloudru-fm
```

### Creating an upstream PR

When ready to submit changes to upstream OpenClaw:

```bash
# Push cloudru-fm branch to your fork
git push origin cloudru-fm

# Create PR from dzhechko/openclaw:cloudru-fm -> openclaw/openclaw:main
# via GitHub UI or:
gh pr create --repo openclaw/openclaw \
  --head dzhechko:cloudru-fm \
  --base main \
  --title "feat: add Cloud.ru FM as auth provider" \
  --body "Adds Cloud.ru Foundation Models integration..."
```

## Architecture decisions

See `docs/cloudru-fm/adr/` for ADR-001 through ADR-005.
