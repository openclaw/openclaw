# Testing

## Framework

Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).

- Test files: colocated `*.test.ts`; e2e in `*.e2e.test.ts`
- Run before pushing when you touch logic

## Commands

```bash
pnpm test                    # Full suite
pnpm test:coverage           # With V8 coverage
pnpm test:force              # Kills lingering gateway, runs suite (use when port 18789 is occupied)
pnpm test:e2e                # Gateway end-to-end smoke tests
pnpm test:docker:live-models # Docker live model tests
pnpm test:docker:live-gateway
pnpm test:docker:onboard     # Onboarding Docker E2E
```

## Live Tests (real keys)

```bash
CLAWDBOT_LIVE_TEST=1 pnpm test:live   # OpenClaw-only live tests
LIVE=1 pnpm test:live                  # Includes provider live tests
```

## Memory Pressure (Pi / non-Mac-Studio)

```bash
OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test
```

## Workers

- Do not set test workers above 16.
- E2E workers: `OPENCLAW_E2E_WORKERS=<n>`, verbose: `OPENCLAW_E2E_VERBOSE=1`

## Node 24+

OpenClaw auto-disables Vitest `vmForks` and uses `forks` to avoid `ERR_VM_MODULE_LINK_FAILURE`. Force behavior with `OPENCLAW_TEST_VM_FORKS=0|1`.

## Mobile

Before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.

## Changelog

- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior.

## Full Kit Docs

See `docs/reference/test.md` and [Testing](/help/testing) for the complete guide.
