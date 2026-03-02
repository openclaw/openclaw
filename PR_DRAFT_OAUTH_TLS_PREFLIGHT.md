## Summary

Add an OpenAI OAuth TLS preflight to detect local certificate-chain problems early and provide actionable remediation, instead of surfacing only `TypeError: fetch failed`.

### Changes

- Add `runOpenAIOAuthTlsPreflight()` and remediation formatter in `src/commands/oauth-tls-preflight.ts`.
- Run TLS preflight before `loginOpenAICodex()` in `src/commands/openai-codex-oauth.ts`.
- Add doctor check via `noteOpenAIOAuthTlsPrerequisites()` in `src/commands/doctor.ts`.
- Keep doctor fast-path tests deterministic by mocking preflight in `src/commands/doctor.fast-path-mocks.ts`.

### User-visible behavior

- During OpenAI Codex OAuth, TLS trust failures now produce actionable guidance, including:
  - `brew postinstall ca-certificates`
  - `brew postinstall openssl@3`
  - expected cert bundle location when Homebrew prefix is detectable.
- `openclaw doctor` now reports an `OAuth TLS prerequisites` warning when TLS trust is broken for OpenAI auth calls.

## Why

On some Homebrew Node/OpenSSL setups, missing or broken cert bundle links cause OAuth failures like:

- `OpenAI OAuth failed`
- `TypeError: fetch failed`
- `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`

This change turns that failure mode into an explicit prerequisite check with concrete fixes.

## Tests

Ran:

```bash
corepack pnpm vitest run \
  src/commands/openai-codex-oauth.test.ts \
  src/commands/oauth-tls-preflight.test.ts \
  src/commands/oauth-tls-preflight.doctor.test.ts
```

All passed.
