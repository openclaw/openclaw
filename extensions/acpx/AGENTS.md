# ACPX Extension Notes

## Purpose

The ACPX extension is a thin OpenClaw wrapper around the published `acpx` package. Keep reusable ACP runtime logic in `openclaw/acpx`, not in this extension.

## Default Version Policy

- Default: published npm `acpx` in `extensions/acpx/package.json`. GitHub commit pins and `allowBuilds` entries are temporary.

## Unreleased ACPX Development Flow

1. Make the ACPX code change in the `openclaw/acpx` repo first.
2. In OpenClaw, temporarily point `extensions/acpx/package.json` at the ACPX GitHub commit you need (dependency change: needs explicit approval).
3. If pnpm blocks ACPX lifecycle/build scripts for that temporary GitHub-sourced package, temporarily add `acpx: true` to `allowBuilds` in `pnpm-workspace.yaml`.
4. Refresh the root workspace lock:
   - `pnpm install --lockfile-only --filter ./extensions/acpx`
5. Build, then validate in an isolated Gateway with a real ACP agent.
6. Once ACPX is released, switch `extensions/acpx/package.json` back to the published npm version, refresh the lock again, and remove the temporary `allowBuilds` entry.

## Local Runtime Validation

When ACPX integration changes here, prefer this sequence:

1. `pnpm install --filter ./extensions/acpx` (owned checkout only)
2. `pnpm test:extension acpx`
3. `pnpm build`
4. If ACP runtime behavior, bundled plugin wiring, or direct ACP chat behavior changed, run a real ACP smoke in an isolated Gateway.

## Direct ACPX Binary Policy

- Use `extensions/acpx/node_modules/.bin/acpx`, never a global `acpx`.
