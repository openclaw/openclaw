# Embedded Runner Test Performance

## Guardrails

- Full `runEmbeddedAttempt` tests only for cross-component behavior. For a
  derived field, extract a helper production calls directly and test that; no
  test-only copies.
- Preserve context-engine coverage for `sessionKey`, `sessionTarget`, token
  budget, current token count, prompt cache, and routing fields when slimming
  tests.

## Verification

- Slimming runner tests: also run `run/attempt.test.ts` and the touched
  context-engine test.
