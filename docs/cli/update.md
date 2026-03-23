---
summary: "The `openclaw update` CLI command has been removed. See Updating for current update instructions."
read_when:
  - You want to update OpenClaw
  - You need to understand update channels
title: "update (removed)"
---

# `openclaw update` (removed)

The `openclaw update` CLI command has been removed. Update OpenClaw using one of these methods instead:

## Global installs (npm/pnpm)

```bash
npm i -g openclaw@latest
# or
pnpm add -g openclaw@latest
```

## Source installs (git checkout)

```bash
git pull --rebase
pnpm install
pnpm build
pnpm ui:build
openclaw doctor
```

## Switching channels

Set the channel in your config:

```bash
openclaw config set update.channel stable
openclaw config set update.channel beta
openclaw config set update.channel dev
```

## Re-run the installer

The simplest update path is to re-run the website installer:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## See also

- [Updating](/install/updating)
- [Development channels](/install/development-channels)
- [CLI reference](/cli)
