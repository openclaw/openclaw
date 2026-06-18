# RausserHQ Rebase Guide

## Add Upstream Remote

```sh
git remote add upstream https://github.com/openclaw/openclaw.git
git remote -v
```

If `upstream` already exists, confirm it points to `https://github.com/openclaw/openclaw.git`:

```sh
git remote set-url upstream https://github.com/openclaw/openclaw.git
```

## Fetch Upstream Tags

```sh
git fetch upstream --tags
git tag --list 'v2026.*' --sort=-v:refname | head
```

## Create A Branch For A New Upstream Tag

Replace `vYYYY.M.D` with the target upstream tag:

```sh
git checkout -B rausser/vYYYY.M.D-fork-bootstrap vYYYY.M.D
git rev-parse vYYYY.M.D^{}
node -p "require('./package.json').version"
```

For patch work, use a separate topic branch from the tag baseline:

```sh
git checkout -B rausser/vYYYY.M.D-source-patches vYYYY.M.D
```

## Replay The Rausser Patchset

Replay source-level changes only:

```sh
git cherry-pick <patch-commit-sha>
```

After each patch or small patch group:

```sh
git status -sb
git diff --check
```

Resolve conflicts in source and tests. Do not copy compiled `/app/dist` overlay files into the fork.

## Compare Sensitive Surfaces Before Porting

Before porting Slack, cron, delivery, or session patches, compare upstream changes from the previous baseline to the new tag:

```sh
git diff --stat <old-baseline>..<new-tag> -- extensions/slack src/channels src/gateway src/agents src/plugins
git diff <old-baseline>..<new-tag> -- extensions/slack src/channels src/gateway src/agents src/plugins
rg -n "cron|heartbeat|delivery|session|thread|response" extensions/slack src/channels src/gateway src/agents src/plugins
```

Use the diff to decide whether the old patch is still needed, whether upstream already fixed it, or whether the patch must be rewritten against the new source shape.

## Validation

Use the upstream package manager and scripts from `package.json`:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test extensions/slack
corepack pnpm check:changed
git diff --check
```

For Docker image smoke tests, use the repository Dockerfile only when a local image smoke test is explicitly required:

```sh
docker build --build-arg OPENCLAW_EXTENSIONS=slack -t rausser/openclaw:local-smoke .
```

Do not build or publish production images from rebase branches unless production cutover work explicitly requires it.

## Avoid Stale Compiled Dist Overlays

- Treat compiled overlays as migration debt.
- Port behavior into source files and tests.
- Delete overlay assumptions from the patch plan once the source fork absorbs them.
- Do not use `/app/dist` files as source of truth when upstream source has moved.
- Re-check package build output after source patches instead of carrying old generated output forward.
