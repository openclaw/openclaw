# Build & Development Commands

## Requirements
- Node **22+** (keep Node + Bun paths working)

## Install Dependencies
```bash
pnpm install
# Also supported:
bun install  # Keep pnpm-lock.yaml + Bun patching in sync
```

## Pre-commit Hooks
```bash
prek install  # Runs same checks as CI
```

## Development
```bash
# Prefer Bun for TypeScript execution
bun <file.ts>
bunx <tool>

# Run CLI in dev
pnpm dna ...  # or pnpm dev
```

## Build
```bash
pnpm build  # tsc type-check + build
```

## Lint & Format
```bash
pnpm lint    # oxlint
pnpm format  # oxfmt
```

## Tests
```bash
pnpm test           # vitest
pnpm test:coverage  # with coverage
```

## Mac Packaging
```bash
scripts/package-mac-app.sh  # Defaults to current arch
```

Release checklist: `docs/platforms/mac/release.md`

## Node vs Bun
- **Bun:** TypeScript execution (scripts, dev, tests)
- **Node:** Built output (`dist/*`) and production installs
