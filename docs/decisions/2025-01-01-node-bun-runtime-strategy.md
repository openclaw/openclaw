# ADR: Node 22+ / Bun Runtime Strategy

**Date:** 2025-01-01 (reconstructed)

## Context

OpenClaw needs to support both Node.js (production installs, `dist/*`) and Bun (faster dev/test execution). These have different module resolution and ESM behaviours.

## Decision

- Runtime baseline: Node **22+**
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`
- Node remains supported for running built output and production installs
- Keep `pnpm-lock.yaml` + Bun patching in sync when touching deps/patches
- Tests: Vitest auto-disables `vmForks` on Node 24+ to avoid `ERR_VM_MODULE_LINK_FAILURE`

## Consequences

- Both runtimes must be tested; CI runs on Node
- Bun-specific APIs must not leak into code that ships in `dist/`
- `bun install` is a supported alternative to `pnpm install` but lockfile sync is the developer's responsibility
