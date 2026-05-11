# Polytropos Core Release Script

This repo includes a script to perform a **core release** end-to-end.

- Script: [`scripts/polytropos-release.mjs`](../../scripts/polytropos-release.mjs)

## What it does (encoded policy)

- Determines the upstream base version by finding the nearest reachable git tag matching:
  - `upstream/<ver>`
- Creates a Polytropos release tag:
  - `polytropos/<ver>+poly.<N>`
  - where `<N>` is a **global build number** that increments across all versions.
- Builds the repo to produce `dist/`:
  - `pnpm install`
  - `pnpm ui:build`
  - `pnpm build`
- Publishes the release by copying `dist/` byte-for-byte into:
  - `~/polytropos/releases/<ver>+poly.<N>/`
- Updates symlinks (mandatory):
  - `previous` → prior `current`
  - `current` → new release
- Restarts the gateway.

## Usage

```bash
node scripts/polytropos-release.mjs release
```

## Notes / safety

- The script requires a **clean git working tree**.
- It assumes the gateway service is already cut over to run from `~/polytropos/releases/current/index.js`.
- It will restart the gateway.
