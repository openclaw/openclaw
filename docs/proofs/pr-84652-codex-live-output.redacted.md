# PR 84652 Redacted Live Output Proof

Date: 2026-05-24
Environment: local OpenClaw checkout (`/home/rev/openclaw-src`)

## Command

```bash
CI=1 NO_COLOR=1 node scripts/run-vitest.mjs \
  extensions/codex/src/app-server/run-attempt.test.ts \
  --run --reporter=verbose \
  --testNamePattern "mirrors the accepted prompt before Codex turn completion using the context session key"
```

## Redacted Output Excerpt

```text
✓ |extensions| ../../extensions/codex/src/app-server/run-attempt.test.ts > runCodexAppServerAttempt > mirrors the accepted prompt before Codex turn completion using the context session key 229ms

Test Files  1 passed (1)
Tests  1 passed | 215 skipped (216)
```

## What This Proves

- Early prompt visibility: the passing test verifies the accepted user prompt is mirrored before Codex turn completion.
- Context-key attribution: the same test asserts `before_message_write` observes the context session key (`agent:webchat:*`) and not sandbox session key.
- No duplicate final user row: the same test asserts final transcript contains exactly one user row after final mirror dedupe.

Reference assertions live in:

- `extensions/codex/src/app-server/run-attempt.test.ts`
  - test name: `mirrors the accepted prompt before Codex turn completion using the context session key`
