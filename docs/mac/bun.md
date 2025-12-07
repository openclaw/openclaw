# Bundled Bun runtime (mac app only)

Date: 2025-12-07 · Owner: steipete · Scope: packaged mac app runtime

## What we ship
- The mac menu-bar app embeds an **arm64 Bun runtime** under `Contents/Resources/Relay/` only for the packaged app. Dev/CI keep using pnpm+node.
- Payload: `bun` binary (defaults to `/opt/homebrew/bin/bun`, override with `BUN_PATH=/path/to/bun`), `dist/` output, production `node_modules/`, and the root `package.json`/`pnpm-lock.yaml` for provenance.
- We prune dev/build tooling (vite, rolldown, biome, vitest, tsc/tsx, @types, etc.) and drop all non-macOS sharp vendors so only `sharp-darwin-arm64` + `sharp-libvips-darwin-arm64` remain.

## Build/packaging flow
- Run `scripts/package-mac-app.sh` (or `BUN_PATH=/custom/bun scripts/package-mac-app.sh`).
  - Ensures deps via `pnpm install`, then `pnpm exec tsc`.
  - Builds the Swift app and stages `dist/`, Bun, and production `node_modules` into `Contents/Resources/Relay/` using a temp deploy (hoisted layout, no dev deps).
  - Prunes optional tooling + extra sharp vendors, then codesigns binaries and native addons.
- Architecture: **arm64 only**. Ship a separate bundle if you need Rosetta/x64.

## Runtime behavior
- `CommandResolver` prefers the bundled `bun dist/index.js <subcommand>` when present; falls back to system `clawdis`/pnpm/node otherwise.
- `RelayProcessManager` runs in the bundled cwd/PATH so native deps (sharp, undici) resolve without installing anything on the host.

## Testing the bundle
- After packaging: `cd dist/Clawdis.app/Contents/Resources/Relay && ./bun dist/index.js --help` should print the CLI help without missing-module errors.
- If sharp fails to load, confirm the remaining `@img/sharp-darwin-arm64` + `@img/sharp-libvips-darwin-arm64` directories exist and are codesigned.

## Notes / limits
- Bundle is mac-app-only; keep using pnpm+node for dev/test.
- Packaging stops early if Bun or `pnpm build` prerequisites are missing.

## FAQ
- **What does `--legacy` do?** When used with `pnpm deploy`, `--legacy` builds a classic flattened `node_modules` layout instead of pnpm's symlinked structure. We no longer need it in the current packaging flow because we create a self-contained hoisted install directly in the temp deploy dir.
