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

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` check out the latest matching tag (often the same tag).
- `dev` switches to `main` and rebases on the upstream.

npm/pnpm global install:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

This updates via the corresponding npm dist-tag (`latest`, `beta`, `dev`).

When you **explicitly** switch channels with `--channel`, OpenClaw also aligns
the install method:

- `dev` ensures a git checkout (default `~/openclaw`, override with `OPENCLAW_GIT_DIR`),
  updates it, and installs the global CLI from that checkout.
- `stable`/`beta` installs from npm using the matching dist-tag.

Tip: if you want stable + dev in parallel, keep two clones and point your gateway at the stable one.

## Plugins and channels

When you switch channels with `openclaw update`, OpenClaw also syncs plugin sources:

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
