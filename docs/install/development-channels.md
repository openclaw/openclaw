---
summary: "Stable, beta, and dev channels: semantics, switching, and tagging"
read_when:
  - You want to switch between stable/beta/dev
  - You are tagging or publishing prereleases
title: "Development Channels"
---

# Development channels

Last updated: 2026-01-21

OpenClaw ships three update channels:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (builds under test).
- **dev**: moving head of `main` (git). npm dist-tag: `dev` (when published).

We ship builds to **beta**, test them, then **promote a vetted build to `latest`**
without changing the version number — dist-tags are the source of truth for npm installs.

## Switching channels

Set the channel in your config:

```bash
openclaw config set update.channel stable
openclaw config set update.channel beta
openclaw config set update.channel dev
```

Then update:

- For **global installs** (npm/pnpm): `stable` uses dist-tag `latest`, `beta` uses `beta`, `dev` uses `dev`. Update with your package manager (e.g. `npm i -g openclaw@latest`).
- For **source installs** (git):
  - `dev` tracks `main`: `git pull --rebase && pnpm install && pnpm build && pnpm ui:build && openclaw doctor`.
  - `stable`/`beta` use tagged releases. Update via the Control UI, or re-run the installer, which handles tag checkout automatically.

Tip: if you want stable + dev in parallel, keep two clones and point your gateway at the stable one.

## Plugins and channels

When you switch channels, OpenClaw also syncs plugin sources:

- `dev` prefers bundled plugins from the git checkout.
- `stable` and `beta` restore npm-installed plugin packages.

## Tagging best practices

- Tag releases you want git checkouts to land on (`vYYYY.M.D` for stable, `vYYYY.M.D-beta.N` for beta).
- `vYYYY.M.D.beta.N` is also recognized for compatibility, but prefer `-beta.N`.
- Legacy `vYYYY.M.D-<patch>` tags are still recognized as stable (non-beta).
- Keep tags immutable: never move or reuse a tag.
- npm dist-tags remain the source of truth for npm installs:
  - `latest` → stable
  - `beta` → candidate build
  - `dev` → main snapshot (optional)

## macOS app availability

Beta and dev builds may **not** include a macOS app release. That’s OK:

- The git tag and npm dist-tag can still be published.
- Call out “no macOS build for this beta” in release notes or changelog.
