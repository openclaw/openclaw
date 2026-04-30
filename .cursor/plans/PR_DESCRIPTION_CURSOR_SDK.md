## Summary

- Problem: OpenClaw lacks a Cursor SDK agent backend — users cannot delegate tasks to Cursor's local or cloud agent runtimes.
- Why it matters: The Cursor SDK (`@cursor/sdk`) provides a TypeScript-native interface for Cursor agents with local and cloud execution modes, expanding the agent backend ecosystem alongside Claude CLI and Codex CLI.
- What changed: Added `cursor-sdk` as a core provider with `runCursorSdkAgent()`, typed config (`CursorSdkBackendConfig`), Zod validation, `CURSOR_API_KEY` env resolution, dispatch branches in all three execution paths (chat reply, agent command, cron), and SDK-aware error classification (`AuthenticationError` → auth, `RateLimitError` → rate_limit).
- What did NOT change (scope boundary): No existing providers, CLI backends, embedded Pi runner, auth profiles, or plugin system were modified. The auth integration uses the env-var pipeline only; a full onboarding wizard plugin is out of scope for this PR.

## Change Type (select all)

- [ ] Bug fix
- [x] Feature
- [ ] Refactor required for the fix
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [x] Gateway / orchestration
- [ ] Skills / tool execution
- [x] Auth / tokens
- [ ] Memory / storage
- [x] Integrations
- [x] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Related: https://cursor.com/blog/typescript-sdk
- [ ] This PR fixes a bug or regression

## Root Cause (if applicable)

N/A — new feature.

## Regression Test Plan (if applicable)

- Coverage level that should have caught this:
  - [x] Unit test
  - [ ] Seam / integration test
  - [ ] End-to-end test
  - [ ] Existing coverage already sufficient
- Target test or file: `src/agents/cursor-sdk-runner.test.ts`
- Scenario the test should lock in: Provider detection, API key resolution failure → FailoverError(auth), successful SDK run → EmbeddedPiRunResult with text payload, local vs cloud agent creation from config, agent disposal on error, SDK `RateLimitError`/`AuthenticationError` → correct FailoverError reason classification.
- Why this is the smallest reliable guardrail: Tests mock the SDK module boundary and validate the runner contract without requiring a live API key.
- Existing test that already covers this (if any): None — new provider.

## User-visible / Behavior Changes

- New provider `cursor-sdk` available for agent delegation.
- New config key `agents.defaults.cursorSdk` for runtime (local/cloud), model, cloud repos, and local cwd.
- New env var `CURSOR_API_KEY` recognized by the auth pipeline.

## Diagram (if applicable)

```text
User prompt → agent dispatch
  ├─ isCliProvider()       → runCliAgent()            (existing)
  ├─ isCursorSdkProvider() → runCursorSdkAgent()      (new)
  └─ default               → runEmbeddedPiAgent()     (existing)

runCursorSdkAgent:
  resolveApiKeyForProvider("cursor-sdk")
  → Agent.create({ local | cloud })
  → agent.send(prompt)
  → stream SDKMessage events → collect assistant text
  → run.wait() → EmbeddedPiRunResult
  → agent[Symbol.asyncDispose]()
```

## Security Impact (required)

- New permissions/capabilities? No
- Secrets/tokens handling changed? Yes — `CURSOR_API_KEY` added to `CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES`; follows the same `resolveApiKeyForProvider` pipeline as all other providers.
- New/changed network calls? Yes — Cursor SDK makes gRPC calls to Cursor's API when the `cursor-sdk` provider is selected. No calls are made unless the user explicitly configures this provider.
- Command/tool execution surface changed? No — the Cursor agent runs within the SDK's sandbox. OpenClaw does not add new shell commands or tool execution paths.
- Data access scope changed? No
- If any Yes, explain risk + mitigation: The `CURSOR_API_KEY` is handled identically to `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. via the existing secret resolution pipeline. Network calls only occur when the user actively selects `cursor-sdk` as their provider. The SDK's agent sandbox is managed by Cursor, not OpenClaw.

## Repro + Verification

### Environment

- OS: macOS (darwin 25.4.0)
- Runtime/container: Node.js v24.12.0
- Model/provider: cursor-sdk / composer-2
- Relevant config (redacted): `CURSOR_API_KEY=crsr_****`

### Steps

1. Set `CURSOR_API_KEY` in env.
2. Run unit tests: `pnpm test src/agents/cursor-sdk-runner.test.ts`
3. Run live test: `OPENCLAW_LIVE_CURSOR_SDK=1 pnpm test --config test/vitest/vitest.live.config.ts src/agents/cursor-sdk-runner.live.test.ts`

### Expected

- Unit tests: 20 passed (10 tests × 2 vitest projects).
- Live test: 1 passed, response contains `CURSOR_SDK_LIVE_OK`.

### Actual

- Unit tests: 20 passed.
- Live test: 1 passed, response text (18 chars): `CURSOR_SDK_LIVE_OK`.

## Evidence

- [x] Failing test/log before + passing after
- [x] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

Unit test output:

```
 ✓ isCursorSdkProvider > returns true for cursor-sdk
 ✓ isCursorSdkProvider > returns true for Cursor-SDK (case-insensitive normalization)
 ✓ isCursorSdkProvider > returns false for other providers
 ✓ runCursorSdkAgent > throws FailoverError when no API key is available
 ✓ runCursorSdkAgent > returns EmbeddedPiRunResult with text payload on success
 ✓ runCursorSdkAgent > creates local agent by default
 ✓ runCursorSdkAgent > creates cloud agent when config specifies runtime=cloud
 ✓ runCursorSdkAgent > disposes agent even on error
 ✓ runCursorSdkAgent > classifies RateLimitError as rate_limit failover reason
 ✓ runCursorSdkAgent > classifies AuthenticationError as auth failover reason
Tests  20 passed (20)
```

Live test output:

```
[live-test] response text (18 chars): CURSOR_SDK_LIVE_OK
Tests  1 passed (1)
```

## Human Verification (required)

- Verified scenarios: Unit tests (mocked SDK), live test (real Cursor API), standalone smoke test in temp dir (SDK + key validation).
- Edge cases checked: Missing API key → FailoverError(auth), SDK RateLimitError → FailoverError(rate_limit), SDK AuthenticationError → FailoverError(auth), agent disposal on error path, workspace fallback logging, empty response handling, cloud vs local config branching.
- What you did **not** verify: Full OpenClaw onboarding wizard flow (out of scope), multi-turn Cursor sessions, concurrent Cursor SDK runs, production cron execution path (tested via code review only).

## Review Conversations

- [x] I replied to or resolved every bot review conversation I addressed in this PR.
- [x] I left unresolved only the conversations that still need reviewer or maintainer judgment.

## Compatibility / Migration

- Backward compatible? Yes
- Config/env changes? Yes — new optional `agents.defaults.cursorSdk` config block and `CURSOR_API_KEY` env var. Both are additive.
- Migration needed? No
- If yes, exact upgrade steps: N/A

## Risks and Mitigations

- Risk: `@cursor/sdk` is a new dependency that increases the install footprint.
  - Mitigation: The SDK is dynamically imported (`await import("@cursor/sdk")`) only when the `cursor-sdk` provider is selected, so it has zero runtime cost for users who don't use it.
- Risk: Cursor SDK API surface may change in future versions.
  - Mitigation: The runner wraps the SDK behind a stable `runCursorSdkAgent()` interface. SDK types are used where available; the `EmbeddedPiRunResult` contract is the stable boundary.

## Files Changed

| File                                               | Change                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `src/agents/cursor-sdk-runner.ts`                  | **New** — Core runner with SDK error classification           |
| `src/agents/cursor-sdk-runner.test.ts`             | **New** — 10 unit tests (20 across 2 vitest projects)         |
| `src/agents/cursor-sdk-runner.live.test.ts`        | **New** — Live integration test                               |
| `src/config/types.agent-defaults.ts`               | Added `CursorSdkBackendConfig` type                           |
| `src/config/zod-schema.agent-defaults.ts`          | Added Zod schema with `.url()`, `.trim().min(1)` validation   |
| `src/agents/model-selection.ts`                    | Added `isCursorSdkProvider()`                                 |
| `src/secrets/provider-env-vars.ts`                 | Added `cursor-sdk` to `CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES` |
| `src/auto-reply/reply/agent-runner-execution.ts`   | Dispatch branch + lifecycle events                            |
| `src/agents/command/attempt-execution.ts`          | Dispatch branch                                               |
| `src/cron/isolated-agent/run-executor.ts`          | Dispatch branch                                               |
| `src/cron/isolated-agent/run-execution.runtime.ts` | Lazy runtime re-exports                                       |
| `package.json` + `pnpm-lock.yaml`                  | `@cursor/sdk` (^1.0.7)                                        |
