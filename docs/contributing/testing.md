# Testing Guidelines

## Framework
- Vitest with V8 coverage
- Thresholds: 70% lines/branches/functions/statements

## Naming
- Match source names: `*.test.ts`
- E2E tests: `*.e2e.test.ts`

## Running Tests
```bash
pnpm test           # Standard run
pnpm test:coverage  # With coverage
```

Run before pushing when you touch logic.

## Live Tests (Real Keys)
```bash
# DNA-only live tests
DNA_LIVE_TEST=1 pnpm test:live

# Including provider live tests
LIVE=1 pnpm test:live

# Docker tests
pnpm test:docker:live-models
pnpm test:docker:live-gateway
pnpm test:docker:onboard
```

Full kit + coverage: `docs/testing.md`

## Workers
Do not set test workers above 16; tried already.

## Mobile Testing
Before using a simulator, check for connected real devices (iOS + Android) and prefer them.

**"Restart apps"** means rebuild (recompile/install) and relaunch, not just kill/launch.

## Changelog
Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior.
