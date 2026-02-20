# Testability Assessment: ADR-001 Email Brief Extension

**Date**: 2026-02-20
**Assessor**: QA Testability Assessment Analyst
**Scope**: ADR-001 -- Email Brief Extension (Gmail Summary via Telegram)
**Inputs**: ADR-001, Shift-Left Testing Report, codebase audit of existing test patterns

---

## Executive Summary

The Email Brief extension design exhibits strong testability characteristics. The pipeline architecture (Parse -> Auth -> Fetch -> Summarize -> Format) decomposes cleanly into independently testable modules, each with well-defined inputs and outputs. The project's existing Vitest infrastructure, established mock patterns for `vi.mock()` / `vi.stubGlobal("fetch", ...)`, and colocated test file conventions provide a ready-made foundation. The only structural concern is the LLM summarization boundary, which is inherently non-deterministic but mitigated by testing invocation contracts rather than output content.

**Overall Testability Rating: GOOD**
**Gate Decision: GO**

---

## 1. Controllability -- EXCELLENT

Controllability measures whether we can set up the exact preconditions needed for each test scenario.

### Assessment

| Precondition           | Controllability Mechanism                                                                                             | Rating    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | --------- |
| Argument strings       | Direct string input to `parseArgs()` pure function                                                                    | Excellent |
| Service Account key    | Fixture file with a test RSA keypair (generated once, committed to test fixtures) or inline JSON env var              | Excellent |
| Gmail API responses    | `vi.stubGlobal("fetch", ...)` as established in `extensions/googlechat/src/api.test.ts`                               | Excellent |
| OAuth2 token endpoint  | Same fetch stub; return controlled `{ access_token, expires_in }` JSON                                                | Excellent |
| LLM responses          | `vi.mock("../../src/agents/pi-embedded-runner.js")` as established in `extensions/llm-task/src/llm-task-tool.test.ts` | Excellent |
| Plugin config values   | Object literal for `ctx.config` and `api.pluginConfig`, as seen in `fakeApi()` pattern from llm-task tests            | Excellent |
| Environment variables  | `vi.stubEnv()` or direct `process.env` manipulation in `beforeEach` / `afterEach`                                     | Excellent |
| Token cache state      | Inject a clock or use `vi.useFakeTimers()` to control TTL-based refresh                                               | Good      |
| Authorized sender flag | Direct boolean on `ctx.isAuthorizedSender`                                                                            | Excellent |

### Evidence from Codebase

The project already demonstrates all required controllability patterns:

- **Fetch mocking**: `vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))` in `extensions/googlechat/src/api.test.ts`
- **Module mocking**: `vi.mock("../../../src/agents/pi-embedded-runner.js", () => { ... })` in `extensions/llm-task/src/llm-task-tool.test.ts`
- **Config injection**: `fakeApi({ pluginConfig: { allowedModels: [...] } })` pattern in llm-task tests
- **Isolated test home**: `withIsolatedTestHome()` in `test/setup.ts` prevents filesystem leakage

### Risks

- **RSA key generation for JWT tests**: Requires generating a test RSA keypair for fixture. This is a one-time setup cost; `node:crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })` can produce a fixture key inline.
- **Token TTL timing**: Tests that verify token cache refresh need `vi.useFakeTimers()`. The project's `test/setup.ts` already calls `vi.useRealTimers()` in `afterEach`, confirming fake timer usage is a supported pattern.

### Rating: **EXCELLENT**

All test preconditions can be fully controlled using existing project patterns. No external services, no browser interactions, no filesystem dependencies that cannot be isolated.

---

## 2. Observability -- GOOD

Observability measures whether we can verify what the system did -- return values, side effects, and internal state.

### Assessment

| Observable                                | Verification Mechanism                                                                                               | Rating    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- |
| Parsed arguments (period, filters)        | Direct return value from `parseArgs()`                                                                               | Excellent |
| Gmail search query string                 | Inspect return value from query builder; or spy on fetch call args                                                   | Excellent |
| JWT structure (header, claims, signature) | Decode the JWT passed to the mocked token endpoint; verify `sub`, `scope`, `iss` fields                              | Excellent |
| Gmail API call parameters                 | Inspect `fetch.mock.calls` for URL, headers, query params                                                            | Excellent |
| LLM prompt content                        | Inspect `runEmbeddedPiAgent.mock.calls[0][0]` for prompt text, `disableTools` flag                                   | Excellent |
| Final formatted output                    | Assert on `{ text: ... }` return value from command handler                                                          | Excellent |
| Error messages                            | Assert on `{ text: ... }` return value; verify it does NOT contain private key material                              | Good      |
| Token caching behavior                    | Spy on fetch call count (0 calls = cache hit, 1 call = cache miss/refresh)                                           | Good      |
| Domain events emitted                     | Depends on whether the extension emits events via an observable mechanism; ADR lists events but not the emission API | Fair      |

### Gaps

1. **Domain event observability**: The ADR specifies events (`command:email_brief`, `email_brief:success`, `email_brief:error`) but does not describe the emission mechanism. If events are emitted via `api.emit()` or similar, they can be spied on. If not yet designed, this is an observability gap for integration tests. **Impact: Low** -- events are secondary to functional correctness.

2. **Internal logging**: The ADR does not specify structured log output. Using `api.logger` (as recommended in shift-left report MR-09) would make log assertions possible via a spy logger, but log content is typically not asserted in unit tests. **Impact: Low**.

3. **LLM output quality**: Non-deterministic by nature. Cannot observe "is the summary good." Mitigated by testing the contract: prompt was well-formed, `disableTools: true` was set, non-empty text was returned. This is a fundamental limitation, not a design flaw.

### Rating: **GOOD**

All critical outputs are directly observable through return values and mock call inspection. The minor gap around domain events does not affect core test coverage.

---

## 3. Isolation -- EXCELLENT

Isolation measures whether each module can be tested independently without requiring other modules to be functional.

### Assessment

| Module               | Dependencies                                  | Isolation Strategy                                                             | Rating    |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | --------- |
| `parse-args.ts`      | None (pure function)                          | Direct invocation, no mocks needed                                             | Excellent |
| `gmail-query.ts`     | None (pure function, takes parsed args)       | Direct invocation, no mocks needed                                             | Excellent |
| `gmail-body.ts`      | None (pure function, takes API response JSON) | Direct invocation with fixture data                                            | Excellent |
| `gmail-client.ts`    | `node:crypto`, `fetch`                        | Stub `fetch` for HTTP calls; real `node:crypto` (deterministic with known key) | Excellent |
| `summarize.ts`       | `runEmbeddedPiAgent`                          | `vi.mock()` the module import                                                  | Excellent |
| `index.ts` (handler) | All above modules, `ctx`, `api`               | Mock all sub-modules or use integration approach with all stubs                | Good      |

### Dependency Graph

```
index.ts (orchestrator)
  |-- parse-args.ts        (0 external deps)
  |-- gmail-client.ts      (fetch, node:crypto)
  |   |-- gmail-query.ts   (0 external deps)
  |   |-- gmail-body.ts    (0 external deps)
  |-- summarize.ts         (runEmbeddedPiAgent)
```

Every leaf module has zero or minimal dependencies. The orchestrator (`index.ts`) can be tested at multiple granularity levels:

- **Unit**: Mock every sub-module, test orchestration logic only
- **Integration**: Use real sub-modules with only external boundaries mocked (fetch, LLM)
- **E2E**: Full pipeline with all external calls mocked

### Evidence from Codebase

The proposed file structure (`parse-args.ts`, `gmail-client.ts`, `gmail-query.ts`, `gmail-body.ts`, `summarize.ts`) follows the same decomposition pattern as other extensions. For example, `extensions/max/` separates `config-schema.ts`, `normalize.ts`, `channel.ts`, and `accounts.ts` -- each with its own `.test.ts` file.

### Rating: **EXCELLENT**

The architecture is deliberately designed for isolation. Pure functions dominate the pipeline. External boundaries are narrow and mockable.

---

## 4. Decomposability -- EXCELLENT

Decomposability measures whether features can be tested incrementally, following the natural pipeline stages.

### Assessment

The pipeline has five distinct stages, each independently testable and each producing a well-typed intermediate result:

```
Stage 1: Parse     "/email_brief from:x@y.com urgent 7d"
                   -> { period: "7d", from: "x@y.com", urgent: true }

Stage 2: Auth      ServiceAccountKey + userEmail
                   -> accessToken (string)

Stage 3: Fetch     accessToken + parsedArgs
                   -> EmailMessage[] (structured data)

Stage 4: Summarize EmailMessage[] + config
                   -> summaryText (string)

Stage 5: Format    summaryText
                   -> { text: string } (Telegram-ready response)
```

| Stage     | Input Type       | Output Type      | Independently Testable | Test Count (est.) |
| --------- | ---------------- | ---------------- | ---------------------- | ----------------- |
| Parse     | `string`         | `ParsedArgs`     | Yes -- pure function   | ~10               |
| Auth      | `SAKey + email`  | `string` (token) | Yes -- mock fetch      | ~7                |
| Fetch     | `token + args`   | `EmailMessage[]` | Yes -- mock fetch      | ~12               |
| Summarize | `EmailMessage[]` | `string`         | Yes -- mock LLM        | ~6                |
| Format    | `string`         | `{ text }`       | Yes -- pure function   | ~3                |

### Incremental Testing Strategy

Implementation can proceed stage-by-stage with full test coverage at each step before moving to the next. This aligns with the shift-left report's recommended implementation order (Section 5.2):

1. Arg parser with full coverage
2. JWT auth with token caching
3. Gmail query builder
4. MIME body extraction
5. Summarization prompt + LLM invocation
6. Command handler wiring

Each stage has a clear contract that can be tested before its consumer exists. This means a developer can `pnpm test` after each module and confirm correctness before integration.

### Rating: **EXCELLENT**

The pipeline architecture is a textbook example of decomposable design. Each stage has typed boundaries, no hidden coupling, and can be implemented and tested in isolation.

---

## 5. Simplicity -- GOOD

Simplicity assesses the inherent complexity of each module and its impact on test design.

### Per-Module Complexity Assessment

| Module               | Cyclomatic Complexity                                     | State                  | Async | Test Complexity                                  | Rating    |
| -------------------- | --------------------------------------------------------- | ---------------------- | ----- | ------------------------------------------------ | --------- |
| `parse-args.ts`      | Low (regex + conditionals)                                | Stateless              | No    | Low -- enumerate input combos                    | Excellent |
| `gmail-query.ts`     | Low (string concatenation)                                | Stateless              | No    | Low -- string assertions                         | Excellent |
| `gmail-body.ts`      | Medium (recursive MIME traversal)                         | Stateless              | No    | Medium -- need diverse MIME fixtures             | Good      |
| `gmail-client.ts`    | Medium (JWT creation, token caching, HTTP error handling) | Stateful (token cache) | Yes   | Medium -- timer mocking, HTTP stubs, error paths | Good      |
| `summarize.ts`       | Low (prompt construction + single LLM call)               | Stateless              | Yes   | Low -- mock LLM, assert prompt                   | Excellent |
| `index.ts` (handler) | Medium (orchestration, error routing, authorization)      | Stateless              | Yes   | Medium -- multiple mock setups                   | Good      |

### Complexity Concerns

1. **MIME multipart traversal** (`gmail-body.ts`): Recursive tree walking through `payload.parts[]` to find `text/plain` or fall back to `text/html`. Complexity is manageable but requires diverse test fixtures (simple single-part, multipart/alternative, multipart/mixed with nested parts, missing body). The shift-left report correctly identified this (MR-04, MR-05, MR-06).

2. **Token caching** (`gmail-client.ts`): Stateful module with time-dependent behavior. Requires `vi.useFakeTimers()` to test TTL expiry and refresh. Not complex per se, but adds test setup overhead.

3. **Error path coverage**: The ADR specifies graceful handling for HTTP 401, 403, 429, 500, missing credentials, invalid JSON key, LLM timeout, and empty results. This is approximately 8 distinct error paths, each needing its own test case. The paths are straightforward but numerous.

### Mitigations

- MIME fixtures can be extracted from real Gmail API documentation examples and stored as JSON files in a `__fixtures__/` directory.
- Token caching tests are a well-understood pattern; the project's `afterEach(() => vi.useRealTimers())` in `test/setup.ts` already supports this.

### Rating: **GOOD**

No module exceeds ~500 LOC (per project convention). The most complex modules (MIME traversal, token caching) are medium complexity with well-understood testing patterns. The extension avoids unnecessary abstractions.

---

## 6. Stability -- GOOD

Stability assesses how likely design changes are to break existing tests, and how resilient the test suite will be to refactoring.

### Stability Analysis

| Change Scenario                            | Likelihood | Impact on Tests                                    | Mitigation                                                                           |
| ------------------------------------------ | ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Gmail API response schema changes          | Very Low   | High (fixture data breaks)                         | Pin fixture data to documented API version; test graceful fallback on missing fields |
| `runEmbeddedPiAgent` API signature changes | Low-Medium | Medium (mock setup breaks)                         | Mock at module boundary; single point of change per shift-left report Section 4.3    |
| New filter types added (e.g., `label:`)    | Medium     | Low (add new test cases, existing tests unchanged) | Parser is additive; new filters do not affect old ones                               |
| Prompt template changes                    | High       | None (tests assert structure, not LLM output)      | Test prompt contains required sections, not exact text                               |
| Plugin SDK `registerCommand` changes       | Low        | Medium (handler signature changes)                 | Follow existing extension patterns; SDK is internal and versioned                    |
| Config schema changes                      | Medium     | Low (update test config objects)                   | Use factory functions for test config (like `fakeApi()` pattern)                     |
| Telegram message limit changes             | Very Low   | Low (update constant)                              | Use constant, not magic number, in tests                                             |

### Fragility Risks

1. **LLM mock contract**: If `runEmbeddedPiAgent` changes its return type (e.g., from `{ payloads: [{ text }] }` to a different shape), all summarizer tests break. This is mitigated by the fact that `llm-task` extension already depends on the same interface, so breaking changes would be caught project-wide.

2. **Gmail API fixtures**: Hardcoded JSON fixtures are fragile if Google changes the API response format. Mitigated by: (a) Gmail API v1 is stable and versioned, (b) the extension should handle missing fields gracefully (shift-left TR-05), (c) fixtures can be versioned alongside the code.

3. **Prompt text assertions**: If tests assert exact prompt strings, any wording change breaks tests. Instead, tests should assert structural properties: "prompt contains email subject lines," "prompt includes urgency instructions when urgent flag is set." The shift-left report's acceptance tests (Section 2, LLM Summarization) correctly use structural assertions.

### Rating: **GOOD**

The pipeline architecture provides natural seams that limit blast radius of changes. The main stability risk (LLM runner interface) is shared with other extensions and thus has project-wide visibility.

---

## 7. Test Infrastructure -- EXCELLENT

This dimension assesses whether the required test tooling and infrastructure already exists or needs to be built.

### Required Infrastructure

| Requirement                               | Status         | Notes                                                    |
| ----------------------------------------- | -------------- | -------------------------------------------------------- |
| Vitest test runner                        | Available      | `vitest.config.ts` includes `extensions/**/*.test.ts`    |
| V8 coverage provider                      | Available      | Configured in `vitest.config.ts`                         |
| `vi.mock()` for module mocking            | Available      | Used in `llm-task-tool.test.ts` for `runEmbeddedPiAgent` |
| `vi.stubGlobal("fetch")` for HTTP mocking | Available      | Used in `googlechat/src/api.test.ts`                     |
| `vi.useFakeTimers()` for time control     | Available      | `vi.useRealTimers()` cleanup already in `test/setup.ts`  |
| `vi.stubEnv()` for environment variables  | Available      | Standard Vitest capability                               |
| JSON fixture files                        | Need to create | Gmail API response fixtures, SA key fixture              |
| RSA test keypair for JWT signing          | Need to create | One-time generation via `node:crypto`                    |
| Colocated test pattern                    | Established    | All extensions use `*.test.ts` next to source            |
| Test setup/teardown                       | Available      | `test/setup.ts` with `beforeEach`/`afterEach`            |
| Type checking                             | Available      | `pnpm tsgo` for fast type validation                     |
| Linting                                   | Available      | `pnpm check` runs oxlint + oxfmt                         |

### What Needs to Be Created

1. **Test fixture: RSA keypair** (~10 lines of setup code)

   ```typescript
   // Can be generated inline in test setup or committed as a fixture
   const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
     modulusLength: 2048,
     publicKeyEncoding: { type: "spki", format: "pem" },
     privateKeyEncoding: { type: "pkcs8", format: "pem" },
   });
   ```

2. **Test fixture: Gmail API responses** (~4 JSON files)
   - `messages-list.json` -- list endpoint response with message IDs
   - `message-simple.json` -- single-part text/plain message
   - `message-multipart.json` -- multipart/alternative with text/plain + text/html
   - `message-html-only.json` -- HTML-only message for fallback testing

3. **Test fixture: Service Account key JSON** (~1 JSON file)
   - Fake SA key with test RSA private key, project ID, client email

4. **Helper: `fakePluginApi()` factory** (~20 lines)
   - Following the `fakeApi()` pattern from `llm-task-tool.test.ts`
   - Returns a typed mock of `OpenClawPluginApi` with config, logger, and `registerCommand`

### Infrastructure Gap Analysis

| Gap                         | Effort  | Blocking?                                  |
| --------------------------- | ------- | ------------------------------------------ |
| Gmail API fixture files     | ~1 hour | No -- can be created during implementation |
| RSA test keypair generation | ~15 min | No -- trivial with `node:crypto`           |
| `fakePluginApi()` factory   | ~30 min | No -- follows existing `fakeApi()` pattern |

**Total infrastructure setup effort: approximately 2 hours**, all of which is standard test setup work.

### Rating: **EXCELLENT**

The project's test infrastructure is mature and provides every capability needed. The only new artifacts are fixture files, which are standard and low-effort.

---

## Summary Matrix

| Dimension           | Rating        | Rationale                                                            |
| ------------------- | ------------- | -------------------------------------------------------------------- |
| Controllability     | **EXCELLENT** | All preconditions controllable via existing mock patterns            |
| Observability       | **GOOD**      | All critical outputs verifiable; minor gap on domain events          |
| Isolation           | **EXCELLENT** | Pure functions dominate; narrow external boundaries                  |
| Decomposability     | **EXCELLENT** | Five-stage pipeline with typed interfaces between stages             |
| Simplicity          | **GOOD**      | Medium complexity in MIME traversal and token caching; manageable    |
| Stability           | **GOOD**      | Pipeline seams limit blast radius; LLM interface shared project-wide |
| Test Infrastructure | **EXCELLENT** | Vitest, mocking, fixtures, coverage all available                    |

---

## Risks to Testability

### Risk 1: MIME Body Extraction Complexity (Medium)

**Description**: Gmail messages have diverse MIME structures (single-part, multipart/alternative, multipart/mixed, nested multipart). Covering all variants requires varied fixture data.

**Mitigation**: Create 4-5 representative MIME fixtures based on Gmail API documentation. Implement recursive traversal with explicit tests for each MIME type. The `gmail-body.ts` module is pure and stateless, making fixture-driven testing straightforward.

### Risk 2: LLM Output Non-Determinism (Low, Accepted)

**Description**: `runEmbeddedPiAgent` returns non-deterministic text. Cannot assert on summary quality.

**Mitigation**: Test the contract, not the content. Verify: (a) prompt is well-formed, (b) `disableTools: true` is set, (c) non-empty text is returned, (d) fallback message is produced on empty/error responses. This is the same approach used by `llm-task-tool.test.ts`.

### Risk 3: Token Cache Timing Sensitivity (Low)

**Description**: Token refresh tests depend on time passage (1h TTL).

**Mitigation**: Use `vi.useFakeTimers()` and `vi.advanceTimersByTime()`. The project already supports and cleans up fake timers in `test/setup.ts`.

---

## Recommendations

1. **Implement parse-args.ts first** with full test coverage (~10 cases). This is the lowest-risk, highest-confidence starting point and validates the test infrastructure setup.

2. **Extract gmail-query.ts and gmail-body.ts as separate pure modules** (as proposed in the ADR). These are the easiest to test and the most likely to accumulate edge cases over time.

3. **Use structural prompt assertions** for summarizer tests. Assert that the prompt contains email metadata, includes urgency instructions when appropriate, and respects the context window limit. Do not assert exact prompt wording.

4. **Create a shared `fakePluginApi()` factory** that can be reused across `index.test.ts` and `summarize.test.ts`. Follow the `fakeApi()` pattern from `extensions/llm-task/src/llm-task-tool.test.ts`.

5. **Commit test fixtures** (fake SA key, Gmail API responses) to `extensions/email-brief/__fixtures__/` so they are versioned alongside the code and reusable across test files.

6. **Address domain event observability** during implementation by ensuring events are emitted through a spyable mechanism (e.g., `api.emit()` or callback). This is a minor concern but improves integration test coverage.

---

## Gate Decision

### **GO**

The Email Brief extension design is highly testable. All seven dimensions rate GOOD or EXCELLENT. The pipeline architecture provides natural test boundaries, existing project infrastructure covers all required tooling, and established mock patterns (`vi.mock`, `vi.stubGlobal("fetch")`, `fakeApi()`) directly apply to every external dependency. The estimated ~38 test cases identified in the shift-left report are achievable with approximately 2 hours of fixture setup and no new test framework dependencies.

No redesign is required. Implementation may proceed with test-driven development following the stage-by-stage approach outlined in the Decomposability section.
