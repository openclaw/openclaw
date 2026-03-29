# Codebase Concerns

**Analysis Date:** 2026-03-28

## Tech Debt

**Large files exceeding 700 LOC guideline (120 offenders):**

- Issue: 120 production source files exceed the 700 LOC guideline; the top offenders are massive and hard to reason about or test in isolation.
- Files:
  - `src/plugins/types.ts` (2442 lines)
  - `src/config/io.ts` (2285 lines)
  - `src/gateway/server-methods/chat.ts` (1875 lines)
  - `src/agents/pi-embedded-runner/run/attempt.ts` (1871 lines)
  - `src/acp/control-plane/manager.core.ts` (1732 lines)
  - `src/config/zod-schema.providers-core.ts` (1562 lines)
  - `src/channels/plugins/setup-wizard-helpers.ts` (1531 lines)
  - `src/security/audit.ts` (1504 lines)
  - `src/gateway/server.impl.ts` (1496 lines)
  - `src/agents/pi-embedded-runner/run.ts` (1428 lines)
  - `src/plugins/loader.ts` (1410 lines)
  - `src/cli/config-cli.ts` (1390 lines)
  - `src/gateway/session-utils.ts` (1370 lines)
  - `src/security/audit-extra.sync.ts` (1359 lines)
  - `src/security/audit-extra.async.ts` (1324 lines)
  - `src/cron/service/timer.ts` (1263 lines)
  - `src/gateway/server/ws-connection/message-handler.ts` (1248 lines)
  - `src/gateway/server-methods/sessions.ts` (1210 lines)
  - `src/infra/heartbeat-runner.ts` (1200 lines)
  - `src/gateway/server-methods/nodes.ts` (1194 lines)
- Impact: Large files reduce discoverability, make test coverage harder, and increase merge conflict surface.
- Fix approach: Progressively split by extracting cohesive sub-responsibilities into dedicated modules. Prioritize files that also have no unit tests (see Test Coverage Gaps section).

**Legacy config migration layer with no retirement mechanism:**

- Issue: 13 legacy migration files exist under `src/config/` with no documented deprecation timeline or retirement gate. Migrations accumulate without being removed after the target config format becomes universal.
- Files:
  - `src/config/legacy-migrate.ts`
  - `src/config/legacy.ts`
  - `src/config/legacy.shared.ts`
  - `src/config/legacy.migrations.ts`
  - `src/config/legacy.migrations.audio.ts`
  - `src/config/legacy.migrations.channels.ts`
  - `src/config/legacy.migrations.runtime.ts`
  - `src/config/legacy-web-search.ts`
  - `src/config/sessions/store-migrations.ts`
- Impact: Boot path runs migrations on every startup; as config shapes diverge further, migration logic becomes increasingly risky to modify.
- Fix approach: Add a minimum supported config version check; once a version is universally deployed, retire the corresponding migration(s) and remove dead code.

**`no-await-in-loop` suppressions in security-critical paths:**

- Issue: 18 `eslint-disable-next-line no-await-in-loop` suppressions in production source; the majority are concentrated in security audit code paths where parallelism bugs would be silent and consequential.
- Files:
  - `src/security/fix.ts` (lines 328, 352, 354, 358, 361, 367, 371, 381, 453 — 9 suppressions)
  - `src/security/audit-extra.async.ts` (lines 744, 807, 924, 1039, 1078 — 5 suppressions)
  - `src/config/includes-scan.ts` (line 79)
  - `src/test-utils/ports.ts` (lines 69, 82, 84 — test utilities)
- Impact: Sequential awaits inside loops prevent parallelism and degrade audit performance; in `fix.ts` they may cause partial-apply race conditions.
- Fix approach: Replace loop awaits with `Promise.all`/`Promise.allSettled` batching where safe; add unit tests that assert batch behavior for the security paths.

**Scattered debug environment variable checks with no central registry:**

- Issue: `OPENCLAW_DEBUG_INGRESS_TIMING` is checked independently in 4 separate files; `OPENCLAW_DEBUG_HEALTH` in 2. There is no central registry of debug flags, their expected values, or documentation.
- Files:
  - `src/agents/model-catalog.ts:41`
  - `src/agents/auth-profiles/store.ts:398`
  - `src/auto-reply/reply/model-selection.ts:45`
  - `src/auto-reply/reply/session.ts:217`
  - `src/commands/health.ts:78,623`
- Impact: New contributors have no discovery path for debug flags; flags can drift out of sync across duplicated check sites.
- Fix approach: Create a `src/infra/debug-flags.ts` module that exports typed flag accessors; replace all direct `process.env` checks with imports from that module.

**`express` dependency isolated to a single file:**

- Issue: `express` is imported only in `src/media/server.ts` while the rest of the project avoids it entirely.
- Files: `src/media/server.ts` (lines 3, 108)
- Impact: Adds a full Express dependency (with its own middleware chain, types, and security surface) for a single server. Inconsistent with the rest of the HTTP layer.
- Fix approach: Migrate `src/media/server.ts` to Node's built-in `http` module or to whichever HTTP framework the gateway uses; then remove `express` from `package.json`.

**`hono` in dependencies but no production imports found:**

- Issue: `hono@4.12.9` and `@hono/node-server@1.19.10` appear in both `dependencies` and `pnpm.overrides` in `package.json`, but no `import ... from "hono"` exists in production source files.
- Files: `package.json` (lines 1212, 1279–1280)
- Impact: Unused dependency adds install size and supply-chain attack surface; the override pinning it hints at an abandoned or in-progress migration that was never completed or reverted.
- Fix approach: Confirm whether a migration to Hono is planned. If not, remove the dependency and the override entry.

---

## Known Bugs

**Markdown blockquote triple-newline output:**

- Symptoms: Rendering a blockquote followed by a paragraph produces `\n\n\n` (triple newline) instead of the correct `\n\n`. The bug is documented and the tests are currently failing.
- Files: `src/markdown/ir.blockquote-spacing.test.ts:15` (documents the bug), `src/markdown/ir.ts` (root cause: `blockquote_close` handler adds an extra `\n`)
- Root cause: `paragraph_close` inside a blockquote already emits `\n\n`; `blockquote_close` then emits another `\n`, producing three total. Container block closings should not add their own spacing.
- Fix: Remove or suppress the extra `\n` emission in the `blockquote_close` handler in `src/markdown/ir.ts`.

**ACP error kind conflation with `end_turn`:**

- Symptoms: Transient server errors (timeouts, rate limits) reported as `end_turn` stop reason to clients instead of a structured error kind, causing clients to misinterpret errors as normal completion.
- Files: `src/acp/translator.ts:897–900`
- Root cause: ACP's `ChatEventSchema` has no structured `errorKind` field; `end_turn` is used as a stopgap fallback. Acknowledged via `TODO` comment in source.
- Fix: Add an `errorKind` discriminated field to `ChatEventSchema` and use it in `translator.ts` to distinguish `refusal` / `timeout` / `rate_limit` / `server_error`.

**Typing keepalive loop runaway edge case:**

- Symptoms: If the dispatcher exits early or errors before firing its `onIdle` callback, the typing keepalive loop runs forever. Currently mitigated by a defensive `markDispatchIdle()` call in the `finally` block.
- Files: `src/auto-reply/reply/agent-runner.ts:790–800`
- Risk: The mitigation is a safety net; a path that bypasses both the dispatcher callback and the `finally` block (e.g., unhandled rejection) would still leak. Regression precedent: issue #26881.
- Fix: Add a test verifying that the keepalive loop terminates when the dispatcher throws; audit for any code paths that could skip the `finally` block.

**Cron timer hot-loop on stuck `runningAtMs`:**

- Symptoms: When a job has a stuck `runningAtMs` marker and a past-due `nextRunAtMs`, `findDueJobs` skips the job while `recomputeNextRunsForMaintenance` does not advance `nextRunAtMs`, causing `armTimer` to be called with `delay === 0` in a tight loop that saturates the event loop and fills logs to cap.
- Files: `src/cron/service/timer.ts:535–554`
- Mitigation: A `MIN_REFIRE_GAP_MS` floor is applied to `delay === 0` cases. Root cause (stuck `runningAtMs`) is not self-healing.
- Fix: Add a `runningAtMs` watchdog that clears the marker after a configurable staleness threshold; add an integration test simulating a stuck job.

---

## Security Considerations

**Large number of unguarded `JSON.parse` calls:**

- Risk: `JSON.parse` throws on malformed input. The codebase has approximately 538 `JSON.parse` calls in production source; only a small fraction are wrapped in `try/catch`. Malformed or attacker-controlled JSON from external channels, tool responses, or network payloads can produce uncaught exceptions that crash request handlers or leak stack traces.
- Files: Widespread across `src/`; highest density in `src/config/`, `src/gateway/`, `src/acp/`, `src/channels/`.
- Current mitigation: None systematic. Some callers use Zod `.safeParse()` after parsing, which catches schema errors but not the initial parse throw.
- Recommendations: Introduce a shared `safeJsonParse<T>` utility in `src/infra/` that returns `Result<T, Error>`; mandate its use for all externally-sourced JSON.

**`globalThis.window` mutation for gaxios compat:**

- Risk: `src/infra/gaxios-fetch-compat.ts:256` mutates `globalThis` to inject a synthetic `window.fetch` shim. This can interfere with any code (including plugins) that performs `typeof window` environment detection, potentially enabling plugins or third-party code to access APIs gated behind that check.
- Files: `src/infra/gaxios-fetch-compat.ts:251–256`
- Current mitigation: The mutation is conditional on `installState !== "not-installed"` and the presence of native `fetch`.
- Recommendations: Replace the global mutation with a fetch-wrapper approach that passes the custom fetch directly to gaxios options instead of polluting the global environment.

**`as any` casts bypassing type safety in security/gateway code:**

- Risk: `as any` casts in gateway and auth code allow values of unknown shape to pass through without type validation, which can mask injection or shape-confusion bugs.
- Files:
  - `src/gateway/tools-invoke-http.ts:276,278,323,345` — tool schema and execute calls cast to `any`
  - `src/gateway/server.auth.shared.ts:243,316` — auth response objects cast to `any`
- Current mitigation: None; these are raw type suppressions.
- Recommendations: Replace `as any` with proper discriminated union types or Zod validation at the boundary; treat these files as high-priority candidates for type hardening.

---

## Performance Bottlenecks

**Sequential `no-await-in-loop` in security audit paths:**

- Problem: Security audit and fix operations in `src/security/fix.ts` and `src/security/audit-extra.async.ts` await items one at a time inside loops rather than batching. On large plugin installs or audit runs, this serializes what could be parallel I/O.
- Files: `src/security/fix.ts` (9 suppressions), `src/security/audit-extra.async.ts` (5 suppressions)
- Cause: Sequential pattern chosen for simplicity; no benchmarks exist for the audit paths.
- Improvement path: Batch independent checks with `Promise.allSettled`; measure audit time on a fixture with 20+ plugins before and after.

---

## Fragile Areas

**`src/gateway/server/ws-connection/message-handler.ts` (1248 lines, no unit tests):**

- Files: `src/gateway/server/ws-connection/message-handler.ts`
- Why fragile: All WebSocket message routing flows through this single file. No unit tests exist. Any regression in message dispatch, session lookup, or error handling will only be caught by e2e tests (if covered there).
- Safe modification: Read the integration tests under `src/gateway/server.sessions.gateway-server-sessions-*.test.ts` for indirect coverage before touching this file. Add targeted unit tests before making logic changes.
- Test coverage: No `message-handler.test.ts` file exists.

**`src/security/audit-extra.async.ts` (1324 lines, no unit tests):**

- Files: `src/security/audit-extra.async.ts`
- Why fragile: Contains async audit logic with multiple sequential loop patterns; no unit test file.
- Safe modification: The extensive `src/security/audit.test.ts` (3977 lines) covers some paths indirectly. Add focused unit tests for the `audit-extra.async` exports before modifying.
- Test coverage: No `audit-extra.async.test.ts` file exists.

**`src/acp/control-plane/manager.core.ts` (1732 lines, no unit tests):**

- Files: `src/acp/control-plane/manager.core.ts`
- Why fragile: ACP control-plane manager is the central coordinator for agent/session lifecycle; no unit tests exist for its 1732-line surface.
- Safe modification: Trace the call chain from `src/acp/translator.ts` before modifying state transitions.
- Test coverage: No `manager.core.test.ts` file exists.

**`src/gateway/server.impl.ts` (1496 lines, no unit tests):**

- Files: `src/gateway/server.impl.ts`
- Why fragile: Gateway server implementation; changes here affect all connected clients. No dedicated unit test file.
- Safe modification: Rely on `src/gateway/server.sessions.gateway-server-sessions-*.test.ts` for regression signals; add unit tests for any new methods before shipping.
- Test coverage: No `server.impl.test.ts` file exists.

**`src/infra/heartbeat-runner.ts` (1200 lines, no unit tests):**

- Files: `src/infra/heartbeat-runner.ts`
- Why fragile: Heartbeat orchestration affects connection health reporting across all channel types. No unit test file.
- Safe modification: Changes should be validated with integration-level tests manually before merging.
- Test coverage: No `heartbeat-runner.test.ts` file exists.

---

## Dependencies at Risk

**`express` — orphaned single-file dependency:**

- Risk: Full Express framework maintained for a single file (`src/media/server.ts`). Express has a larger attack surface than Node's native HTTP server and adds unnecessary transitive dependencies.
- Impact: Any Express CVE requires a project-level response despite near-zero usage.
- Migration plan: Rewrite `src/media/server.ts` using Node's native `http`/`https` or the project's existing HTTP infrastructure; remove `express` from `package.json`.

**`hono` + `@hono/node-server` — unused pinned overrides:**

- Risk: Two packages pinned in `pnpm.overrides` with no production imports. Override pinning forces a specific version for all transitive dependents, which can mask future incompatibilities.
- Impact: Dead weight in the dependency graph; override could silently conflict with a future package that legitimately depends on a different Hono version.
- Migration plan: Remove from `dependencies` and `pnpm.overrides` if no active Hono migration is planned; document the intent in a tracking issue if migration is deferred.

---

## Test Coverage Gaps

**WebSocket message handler — core dispatch path untested:**

- What's not tested: All WebSocket message routing, session lookup, error dispatch, and protocol handling in `src/gateway/server/ws-connection/message-handler.ts`.
- Files: `src/gateway/server/ws-connection/message-handler.ts` (1248 lines)
- Risk: Protocol bugs, session leaks, and error-handling regressions go undetected until e2e tests catch them (if at all).
- Priority: High

**Async security audit — audit loop logic untested at unit level:**

- What's not tested: The async audit sweep logic, sequential loop patterns, and per-check error handling in `src/security/audit-extra.async.ts`.
- Files: `src/security/audit-extra.async.ts` (1324 lines)
- Risk: Silent correctness bugs in audit results; `no-await-in-loop` suppressions make race conditions hard to catch without focused tests.
- Priority: High

**ACP control-plane manager — session lifecycle untested:**

- What's not tested: Agent session creation, state transitions, error handling, and cancellation paths in `src/acp/control-plane/manager.core.ts`.
- Files: `src/acp/control-plane/manager.core.ts` (1732 lines)
- Risk: ACP session management regressions propagate silently; the `end_turn` conflation bug (see Known Bugs) went undiscovered partly due to this gap.
- Priority: High

**Gateway server implementation — method-level behavior untested:**

- What's not tested: Individual method behaviors, auth path edge cases, and session binding in `src/gateway/server.impl.ts`.
- Files: `src/gateway/server.impl.ts` (1496 lines)
- Risk: Regressions in gateway session handling affect all clients; currently only catchable via slow integration tests.
- Priority: High

**Heartbeat runner — connection health logic untested:**

- What's not tested: Heartbeat scheduling, connection state transitions, backoff logic, and cleanup in `src/infra/heartbeat-runner.ts`.
- Files: `src/infra/heartbeat-runner.ts` (1200 lines)
- Risk: Silent failures in connection health reporting across all channel types.
- Priority: Medium

---

_Concerns audit: 2026-03-28_
