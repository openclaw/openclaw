---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Stable, beta, and dev channels: semantics, switching, and tagging"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to switch between stable/beta/dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are tagging or publishing prereleases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Development Channels"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Development channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Last updated: 2026-01-21（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw ships three update channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **stable**: npm dist-tag `latest`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **beta**: npm dist-tag `beta` (builds under test).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **dev**: moving head of `main` (git). npm dist-tag: `dev` (when published).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We ship builds to **beta**, test them, then **promote a vetted build to `latest`**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
without changing the version number — dist-tags are the source of truth for npm installs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Switching channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Git checkout:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel stable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel beta（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stable`/`beta` check out the latest matching tag (often the same tag).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dev` switches to `main` and rebases on the upstream.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm/pnpm global install:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel stable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel beta（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This updates via the corresponding npm dist-tag (`latest`, `beta`, `dev`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you **explicitly** switch channels with `--channel`, OpenClaw also aligns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the install method:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dev` ensures a git checkout (default `~/openclaw`, override with `OPENCLAW_GIT_DIR`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  updates it, and installs the global CLI from that checkout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stable`/`beta` installs from npm using the matching dist-tag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: if you want stable + dev in parallel, keep two clones and point your gateway at the stable one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugins and channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you switch channels with `openclaw update`, OpenClaw also syncs plugin sources:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dev` prefers bundled plugins from the git checkout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stable` and `beta` restore npm-installed plugin packages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tagging best practices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tag releases you want git checkouts to land on (`vYYYY.M.D` or `vYYYY.M.D-<patch>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep tags immutable: never move or reuse a tag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- npm dist-tags remain the source of truth for npm installs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `latest` → stable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `beta` → candidate build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `dev` → main snapshot (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## macOS app availability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Beta and dev builds may **not** include a macOS app release. That’s OK:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The git tag and npm dist-tag can still be published.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Call out “no macOS build for this beta” in release notes or changelog.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
