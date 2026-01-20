---
summary: "Stable, beta, and dev channels: semantics, switching, and tagging"
read_when:
  - You want to switch between stable/beta/dev
  - You are tagging or publishing prereleases
---

# Development channels

Clawdbot ships three update channels:

- **stable**: tagged releases (`vYYYY.M.D` or `vYYYY.M.D-<patch>`). npm dist-tag: `latest`.
- **beta**: prerelease tags (`vYYYY.M.D-beta.N`). npm dist-tag: `beta`.
- **dev**: moving head of `main` (git). npm dist-tag: `dev` (when published).

## Switching channels

Git checkout:

```bash
clawdbot update --channel stable
clawdbot update --channel beta
clawdbot update --channel dev
```

- `stable`/`beta` check out the latest matching tag.
- `dev` switches to `main` and rebases on the upstream.

npm/pnpm global install:

```bash
clawdbot update --channel stable
clawdbot update --channel beta
clawdbot update --channel dev
```

This updates via the corresponding npm dist-tag (`latest`, `beta`, `dev`).

Tip: if you want stable + dev in parallel, keep two clones and point your gateway at the stable one.

## Tagging best practices

- Stable: tag each release (`vYYYY.M.D` or `vYYYY.M.D-<patch>`).
- Beta: use `vYYYY.M.D-beta.N` (increment `N`).
- Keep tags immutable: never move or reuse a tag.
- Publish dist-tags alongside git tags:
  - `latest` → stable
  - `beta` → prerelease
  - `dev` → main snapshot (optional)

## macOS app availability

Beta and dev builds may **not** include a macOS app release. That’s OK:

- The git tag and npm dist-tag can still be published.
- Call out “no macOS build for this beta” in release notes or changelog.
