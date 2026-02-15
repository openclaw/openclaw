# Codebase Concerns

**Analysis Date:** 2026-02-15

## Tech Debt

**Large Monolithic Files (1000+ lines):**
- Files: `src/memory/qmd-manager.ts` (1156 lines), `src/agents/pi-embedded-runner/run/attempt.ts` (1149 lines), `src/config/io.ts` (1133 lines), `src/telegram/send.ts` (1089 lines), `src/memory/manager-sync-ops.ts` (1077 lines)
- Impact: Difficult to test individual behaviors, high cognitive load for changes, increased surface area for bugs
- Fix approach: Break into focused modules by responsibility (parsing, validation, state management). Extract helper functions into separate files. Aim for <600 line files with single responsibilities.

**Type Assertions (1048 instances):**
- Pattern: `as unknown`, `as any`, `// @ts-ignore` spread across codebase
- Files: `src/test-utils/vitest-mock-fn.ts`, web utilities, various test files
- Impact: Loss of type safety. Silent errors possible when assertions hide real type mismatches
- Fix approach: Replace with proper type definitions using discriminated unions, assertion functions (`asserts`), or type guards. Audit high-risk areas (web extraction, telegram parsing) first.

**ESLint Disables (47 instances):**
- Pattern: `eslint-disable` comments throughout codebase
- Files: Scattered across agent files, web utilities, test harness files
- Impact: Rules being bypassed suggest either overly strict rules or problematic patterns being hidden
- Fix approach: Document why each disable is needed. Move to centralized overrides if legitimate. Remove if rule can be satisfied.

**Silent Failures - Undefined Returns:**
- Files: `src/web/inbound/extract.ts` (13 undefined returns), `src/telegram/bot/helpers.ts` (7 undefined returns), `src/web/inbound/media.ts` (multiple)
- Pattern: `return undefined` for missing/invalid data without logging or signaling
- Impact: Callers may not realize a parse/extract operation failed. Can lead to missing features or dropped data silently
- Fix approach: Return `Result<T>` types or throw errors. Ensure callers check for nullability with strict null checks. Add logging for unexpected undefined returns.

## Known Issues from Recent Commits

**Discord Role-Based Allowlist Bug (#16369):**
- Issue: Role allowlist never matches because Carbon Role objects stringify to mentions
- File: `src/discord/audit.ts`
- Impact: Role-based access control ineffective, potentially allowing unauthorized access
- Status: Recently fixed in commit `c68263418`
- Mitigation: Ensure role ID comparisons use object properties, not string representations

**Telegram DM Message Thread ID (#10942):**
- Issue: `message_thread_id` sent for DMs causes 400 Bad Request errors
- File: `src/telegram/send.ts`
- Impact: DM failures, poor user experience
- Status: Recently fixed in commit `cc0bfa0f3`
- Lesson: Channel-specific context (forum topics vs DMs) must be validated before parameter inclusion

**JSON Parsing Without Error Handling:**
- Files: `src/telegram/update-offset-store.ts`, `src/tts/tts.ts`, `src/cron/run-log.ts`, `src/imessage/client.ts`, `src/web/session.ts`
- Pattern: `JSON.parse()` without try-catch
- Impact: Unhandled exceptions if stored data is corrupted; can cause crashes on state load
- Fix approach: Wrap all JSON.parse calls in try-catch. Return defaults on parse failure. Add validation before parse where possible.

## Security Considerations

**Type System Gaps Allow Implicit Leaks:**
- Risk: Heavy use of `as unknown`/`any` in type assertions bypasses safety checks
- Files: Web extraction, inbound message parsing, media handling
- Mitigation: Recent commits (2026.2.14+) show hardening of security critical paths (SSRF, local file disclosure, shell injection), but type safety could prevent future issues
- Recommendations: Enforce strict null checks and `noImplicitAny` compiler flags. Create branded types for security-critical values (file paths, URLs, IDs).

**Unbounded Memory Growth in Long-Running Gateways:**
- Risk: Multiple components accumulate in-memory state without bounds
- Identified areas:
  - `src/infra/session-cost-usage.ts`: agentRunSeq tracking
  - `src/auto-reply/heartbeat-runner.ts`: ABORT_MEMORY state
  - `src/infra/system-events.ts`: Session event tracking
  - Memory: thread-starter cache, directory cache, remote-skills cache
- Impact: Long-running gateways (days+) degrade and eventually OOM
- Status: Recent fixes (CHANGELOG 2026.2.14+) added TTL + max-size pruning, but pattern suggests more areas may have same issue
- Fix approach: Audit all Maps/Sets for unbounded growth. Add LRU eviction + TTL to: `src/slack/thread-cache.ts`, `src/outbound/directory-cache.ts`, `src/skills/remote-cache.ts`. Add monitoring for map/set sizes.

## Performance Bottlenecks

**QMD Index Operations Under Lock:**
- Problem: `src/memory/qmd-manager.ts` SQLite database lock contention on index updates
- Files: `src/memory/qmd-manager.ts` (lines 1049-1081)
- Cause: Synchronous SQLite access blocks concurrent searches. Debouncing helps but doesn't eliminate contention.
- Improvement path: Consider async SQLite wrapper or separate read replicas for searches. Currently mitigated by `SEARCH_PENDING_UPDATE_WAIT_MS` (500ms) timeout.

**Large Test Files Causing Slowdown:**
- Files: `src/security/audit.test.ts` (2126 lines), `src/commands/auth-choice.e2e.test.ts` (1369 lines), `src/memory/qmd-manager.test.ts` (1289 lines)
- Impact: Slow test runs, difficult to run individual test cases
- Fix approach: Split by concern (unit vs integration). Move E2E tests to separate suite. Use test parameterization instead of repetitive test definitions.

**JSON Serialization/Deserialization in Hot Paths:**
- Problem: Multiple JSON.parse/stringify calls in session/config load paths
- Files: `src/config/io.ts` (1133 lines), `src/telegram/update-offset-store.ts`, `src/cron/store.ts`
- Impact: Unnecessary CPU for large session histories or config files
- Improvement: Cache parsed results, consider binary formats for frequently-accessed data

## Fragile Areas

**Web Inbound Message Extraction:**
- Files: `src/web/inbound/extract.ts` (200+ lines of message type casting)
- Why fragile: Heavy reliance on proto message type narrowing with multiple fallback paths and manual `Record<string, unknown>` casting
- Safe modification: Add integration tests for each message type. Use discriminated unions instead of cascading type guards. Document expected message shapes.
- Test coverage: Exists but focused on happy path; edge cases (malformed contextInfo, missing fields) undercovered.

**Telegram Update Processing:**
- Files: `src/telegram/bot.ts`, `src/telegram/send.ts`, `src/telegram/bot-handlers.ts` (947 lines)
- Why fragile: Multiple recent fixes (#10942, #16789, #17218) suggest handling edge cases in streaming, threading, and media delivery is error-prone
- Safe modification: Add test cases before fixing bugs. Document forum-topic vs DM differences. Create telegram-specific utilities for parameter filtering.
- Risk: New channel features (polls, topics) may introduce regressions if parameter validation is incomplete

**Memory System State Synchronization:**
- Files: `src/memory/qmd-manager.ts`, `src/memory/manager-sync-ops.ts` (1077 lines), `src/memory/backend-config.ts`
- Why fragile: Async update operations, SQLite locks, multi-collection index coordination
- Safe modification: Add detailed state logging before/after update operations. Test scenarios: rapid concurrent updates, index corruption recovery, collection renames
- Test coverage: Basic smoke tests exist; concurrency and failure modes undercovered

**Session Transcript Repair:**
- Files: `src/agents/session-transcript-repair.ts`, `src/agents/session-file-repair.ts`
- Why fragile: Modifying saved user/assistant history can introduce subtle message reconstruction errors
- Safe modification: Always validate round-trip (parse → fix → serialize → parse) preserves structure. Add diff-based tests showing before/after.
- Test coverage: Regressions exist; correlation between test additions and bug fixes suggests reactive rather than proactive

## Scaling Limits

**SQLite for Memory Indexing:**
- Current capacity: Single SQLite database per agent, QMD command-line interface
- Limit: Concurrency limited by SQLite locks; large memory collections hit query timeout limits
- Scaling path: Database-backed queue system or separate search service. Consider vector DB for embeddings (LanceDB exists but single-process).

**Session State File Growth:**
- Current capacity: Full session history in single JSON/transcript files
- Limit: Large conversations (1000+ turns) become slow to load/save; tool results with large artifacts cause file bloat
- Scaling path: Split sessions into time-windows or implement incremental saving. Archive old turns separately.

**Heartbeat System Under Load:**
- Current capacity: Per-agent heartbeat loops with queue monitoring
- Limit: Complex prompts or slow models cause heartbeat delays, missing scheduled runs
- Scaling path: Separate heartbeat executor, configurable concurrency limits

## Dependencies at Risk

**@mariozechner/pi-* Packages (0.52.x):**
- Risk: Proprietary embedded agent/coding packages tied to specific versions. Limited visibility into updates.
- Impact: Security patches, model compatibility changes require coordination
- Migration plan: Monitor for updates in CHANGELOG. No direct alternatives for PI-based embedding.

**@whiskeysockets/baileys (7.0.0-rc9):**
- Risk: Pre-release WhatsApp library. RC versions may have undocumented breaking changes.
- Impact: WhatsApp channel instability, authentication failures
- Migration plan: Upgrade to 7.0.0 final when available. Consider fallback to official WhatsApp Business API.

**SQLite (via node:sqlite):**
- Risk: New native module in Node 22+. Limited ecosystem maturity.
- Impact: Installation/compilation issues on some platforms, fewer utility libraries
- Migration plan: Already adopted; consider database abstraction layer to enable swappable backends (PostgreSQL, etc.) for production deployments

## Missing Critical Features

**Comprehensive Error Categorization:**
- Problem: Error classification scattered across files (telegram network errors, failover reasons, SSRF guards). No unified error taxonomy.
- Blocks: Consistent error handling, observability, user-facing error messaging
- Example gaps: HTTP timeout vs network unreachable treated differently in some modules

**Request/Response Tracing:**
- Problem: No built-in request correlation IDs across channels/gateways
- Blocks: Debugging multi-hop issues, performance profiling, audit trails
- Workaround: Context locals in pi-agent-core, but not consistent across all entry points

**Graceful Degradation Strategy:**
- Problem: Limited fallback mechanisms when external services fail (media download, memory index, embedding service)
- Blocks: Resilience under degraded conditions
- Gaps: No circuit breaker pattern, limited retry budgets documented, no fallback model specs

## Test Coverage Gaps

**Concurrent Operation Safety:**
- What's not tested: Simultaneous session writes, memory index updates, heartbeat triggers, cron execution
- Files: `src/agents/session-write-lock.ts`, `src/memory/qmd-manager.ts`, `src/infra/heartbeat-runner.ts`
- Risk: Data corruption, lost updates under load
- Priority: High - gateway designed for concurrent channels

**State Migration Consistency:**
- What's not tested: Large batches of sessions migrating between state formats, rollback scenarios
- Files: `src/infra/state-migrations.ts` (972 lines)
- Risk: Data loss during version upgrades
- Priority: High - affects all users on deployment

**Security Audit Edge Cases:**
- What's not tested: Malicious configs (path traversal attempts, SSRF payloads), permission bypass scenarios
- Files: `src/security/audit.ts` (many recent security fixes suggest reactive testing)
- Risk: Security issues discovered post-deployment
- Priority: Critical - multi-tenant implications

**Media Handling Under Stress:**
- What's not tested: Large files (100MB+), oversized base64 payloads, concurrent downloads
- Files: `src/web/media.ts`, `src/agents/tools/web-fetch.ts`
- Risk: Resource exhaustion, memory pressure
- Priority: High - users can trigger via media sends

**Error Path Code Coverage:**
- What's not tested: Many error handlers and fallback paths (especially in agents, telegram, memory modules)
- Pattern: Recent fixes show bugs in error recovery logic suggesting coverage < 50%
- Priority: Medium - impacts reliability but rare in happy path

---

*Concerns audit: 2026-02-15*
