> **SUPERSEDED:** This document references ADR-006..013 which were deleted during the v2 ADR rewrite (commit e54143f). ADR-001..005 v2 now cover this scope. Retained for historical context only.

# Implementation Milestones: ADR-010 & ADR-011

## Current State

- **Streaming**: `runCliAgent()` in `cli-runner.ts` buffers all subprocess stdout and returns a single batch response. Users wait 10-30+ seconds with no feedback. No typing indicator, no progressive updates. The streaming capability exists at every layer (Cloud.ru FM SSE, claude-code-proxy passthrough, Claude Code `--output-format stream-json`) but is discarded at the OpenClaw application layer.
- **User Customization**: No mechanism for users to configure agent behavior, persist instructions, upload knowledge, register tools, or manage agent persona via messenger commands. Each invocation uses identical system behavior regardless of tenant.
- **Shared Infrastructure**: No `@openclaw/core-types` shared kernel. No `TenantContext` value object. No event bus. No filesystem abstraction. Workspace paths are undefined (ADR-008 says `/var/openclaw/tenants/{tenantId}/workspace`, ADR-011 says `/data/tenants/{tenantId}/`).
- **Test Coverage**: Zero tests for streaming or training domains.

## Goal State

- **Streaming**: Generic, provider-agnostic streaming pipeline (`@openclaw/stream-pipeline`) that reads incremental token events from any source (Claude Code subprocess, Cloud.ru SSE, future providers), buffers with backpressure-aware debouncing, and delivers progressive updates through platform-specific messenger adapters. Typing indicator within 500ms. TTFT under 3s for local providers. Graceful fallback to batch on any failure. All DDD invariants enforced via typed state machine.
- **User Customization**: Full `@openclaw/training-engine` module enabling users to manage behavioral rules (CLAUDE.md), upload knowledge (Cloud.ru RAG), register MCP tools, customize agent persona, define hooks/skills, and export/import configuration -- all via slash commands in Telegram/MAX. Per-tenant isolation with versioned history and rollback. Training changes take effect on the next message with zero restart.
- **Shared Infrastructure**: `TenantContext` value object with path derivation and validation. Shared error taxonomy. Domain event infrastructure. Injectable filesystem abstraction (`TenantRepository`). All types exported from a shared kernel.
- **Test Coverage**: 70/25/5 unit/integration/E2E split for streaming. 65/30/5 for training. All pre-implementation tests from the shift-left report passing. All Priority 1 QCSD test cases covered.

---

## Milestone 0: Shared Kernel and Cross-Cutting Infrastructure

- **Bounded Context**: Shared Kernel (cross-cutting)
- **Files to create**:
  - `/src/core/types/tenant-context.ts` -- `TenantContext` value object with validated `tenantId`, derived paths (`workspacePath`, `claudeMdPath`, `memoryNamespace`, `ragCollectionId`), and directory traversal prevention
  - `/src/core/types/errors.ts` -- Unified error taxonomy: `OpenClawError` base, `StreamError`, `TrainingError`, `ValidationError`, `SecurityError` with typed error codes
  - `/src/core/types/domain-events.ts` -- Domain event base type, event bus interface (`DomainEventBus`), correlation ID support
  - `/src/core/types/timer.ts` -- Injectable `Timer` interface for testable time-dependent logic
  - `/src/core/types/index.ts` -- Barrel export
  - `/src/core/infra/tenant-repository.ts` -- `TenantRepository` interface abstracting filesystem operations (`readClaudeMd`, `writeClaudeMd`, `readJson`, `writeJson`)
  - `/src/core/infra/fs-tenant-repository.ts` -- Filesystem implementation of `TenantRepository` with atomic writes
  - `/src/core/infra/event-bus.ts` -- In-process `DomainEventBus` implementation with error isolation (handler failure does not crash emitter)
  - `/src/core/index.ts` -- Package barrel export
- **Dependencies**: None (foundation layer)
- **Acceptance criteria**:
  - `TenantContext` rejects `tenantId` values containing path traversal sequences (`../`, `..\\`, etc.) and characters outside `^[a-z]+_\d+$`
  - `TenantContext.claudeMdPath` resolves to the canonical workspace path agreed upon across ADRs (resolve the ADR-008 vs ADR-011 path inconsistency before implementation)
  - `TenantRepository` filesystem implementation performs atomic writes (write to temp file, then rename) preventing partial CLAUDE.md on crash
  - `DomainEventBus` delivers events to all handlers; a throwing handler does not prevent delivery to subsequent handlers
  - All error types carry a typed `code` field from a string literal union, not freeform strings
  - `Timer` interface wraps `setInterval`/`setTimeout`/`clearInterval`/`clearTimeout` for injection in tests
- **Shift-left mitigations**:
  - SL-PATH: Resolves workspace path inconsistency between ADR-008 (`/var/openclaw/tenants/{tenantId}/workspace`) and ADR-011 (`/data/tenants/{tenantId}/`). Single source of truth in `TenantContext`.
  - SL-TYPES: Resolves `ClaudeMdSection` type conflict (string literal union vs interface) by defining canonical types in the shared kernel.
  - SL-ERRORS: Resolves missing global error taxonomy identified in shift-left cross-cutting findings.
- **QCSD quality gates**:
  - QG-SEC: `TenantContext` constructor rejects `../other-tenant` (R011-06 SSRF/traversal test)
  - QG-REL: `DomainEventBus` handler failure isolation verified (ADR-012 event bus handler failure criterion)
  - QG-PERF: Event dispatch under 0.5ms for 10 handlers (QCSD ADR-012 performance threshold)
- **Estimated complexity**: MEDIUM

---

## Milestone 1: StreamParser -- Newline-Delimited JSON Event Parser

- **Bounded Context**: Response Delivery
- **Files to create**:
  - `/src/stream-pipeline/stream-parser.ts` -- `StreamParser` implementation: `feed(line)` parses JSON, discriminates `StreamJsonEvent` union, emits typed callbacks (`onToken`, `onToolUse`, `onComplete`, `onError`). Validates every line via `JSON.parse` with `PARSE_ERROR` on failure. Validates `StreamJsonEvent.type` against known union; unknown types logged and ignored. Tracks accumulated text for `partialText` on error. (~120 lines)
  - `/src/stream-pipeline/types.ts` -- All streaming domain types: `StreamJsonEvent` discriminated union, `StreamParser` interface, `ToolUseEvent`, `CompleteResponse`, `StreamError`, `ResponseStreamState` typed state machine, `ResponseStreamEvent` transition events
  - `/tests/stream-pipeline/stream-parser.test.ts` -- Unit tests (write BEFORE implementation per TDD)
- **Dependencies**: Milestone 0 (`errors.ts` for `StreamError` base)
- **Acceptance criteria**:
  - `feed('{"type":"assistant","subtype":"text","content":"hello"}')` triggers `onToken("hello")`
  - `feed('{"type":"result","subtype":"success","result":"done","session_id":"s1"}')` triggers `onComplete` with `sessionId: "s1"`
  - `feed('not json at all')` triggers `onError` with `code: "PARSE_ERROR"`
  - `end(1)` without prior `onComplete` triggers `onError` with `code: "SUBPROCESS_CRASH"` and accumulated `partialText`
  - `end(0)` without prior `onComplete` triggers `onError` with `code: "PARSE_ERROR"` (stream ended without result)
  - Unknown event types (e.g., `{"type":"unknown","subtype":"future"}`) are silently skipped, not errors
  - `destroy()` removes all callback references (no memory leak)
  - `ResponseStreamState` is a discriminated union type enforcing valid transitions at compile time
- **Shift-left mitigations**:
  - SL-E3: Partial JSON within a line handled by `JSON.parse` failure path (shift-left E3)
  - SL-STATE: State machine encoded as a TypeScript discriminated union, not prose (shift-left testability gap 1)
  - SL-CONTRACT: `StreamJsonEvent` types validated against known union, preventing silent breakage on Claude Code format changes (R010-01)
- **QCSD quality gates**:
  - QG-FUNC: 100% event coverage; zero dropped tokens (QCSD functionality criterion)
  - QG-PERF: Parser throughput >= 10,000 tokens/second (QCSD performance threshold)
  - QG-MAINT: File under 500 lines (project rules)
- **Estimated complexity**: MEDIUM

---

## Milestone 2: TokenAccumulator -- Debounced Buffer with Backpressure

- **Bounded Context**: Response Delivery
- **Files to create**:
  - `/src/stream-pipeline/token-accumulator.ts` -- `TokenAccumulator` implementation: pushes tokens to internal buffer, flushes on configurable interval (`flushIntervalMs`), respects `minCharsToFlush` and `maxBufferSize` thresholds, supports `finalize()` for final flush with `isFinal: true`, `cancel()` for cleanup. Accepts injectable `Timer` for testability. Implements backpressure: if `onFlush` promise is pending, pauses flush timer until resolved. (~100 lines)
  - `/tests/stream-pipeline/token-accumulator.test.ts` -- Unit tests with fake timers (write BEFORE implementation)
- **Dependencies**: Milestone 0 (`Timer` interface), Milestone 1 (`types.ts`)
- **Acceptance criteria**:
  - Push 100 characters, advance fake timer by `flushIntervalMs` -> `onFlush` called with accumulated text and `isFinal: false`
  - Push `maxBufferSize + 1` characters in one call -> `onFlush` fires immediately (forced flush), no timer wait
  - Push 10 characters (below `minCharsToFlush`), call `finalize()` -> `onFlush` fires with `isFinal: true`
  - Call `cancel()` then advance timer -> `onFlush` never called
  - `peek()` returns current buffer contents without triggering flush
  - If `onFlush` rejects (adapter failure), accumulator does not crash; error is propagated to a configurable error handler, and accumulation continues
  - Backpressure: if `onFlush` takes 3 seconds, no second flush fires during that 3 seconds even if timer fires
  - After `finalize()` or `cancel()`, `jest.getTimerCount()` returns 0 (no leaked timers)
- **Shift-left mitigations**:
  - SL-TIMER: Injectable `Timer` interface addresses shift-left testability gap 3 (timer-dependent behavior)
  - SL-E10: `onFlush` rejection handled gracefully, not as unhandled promise rejection (shift-left E10)
  - SL-BACKPRESSURE: Backpressure signal prevents unbounded memory growth during API outages (shift-left recommendation 4)
- **QCSD quality gates**:
  - QG-FUNC: Flush fires within +/-50ms of `flushIntervalMs` (QCSD functionality threshold)
  - QG-REL: Timer cleanup on cancel/finalize verified; zero leaked `setInterval` handles (QCSD reliability criterion)
  - QG-PERF: Memory per active accumulator under 256 KB (contributes to QCSD 2 MB per stream budget)
- **Estimated complexity**: MEDIUM

---

## Milestone 3: Long Message Splitter

- **Bounded Context**: Response Delivery
- **Files to create**:
  - `/src/stream-pipeline/long-message-splitter.ts` -- `splitLongMessage(text, maxLength)` pure function: splits text at paragraph boundaries (`\n\n`), then sentence boundaries (`. `), then word boundaries (` `). Preserves markdown structure (never splits inside a code block delimited by triple backticks). Returns `string[]`. (~80 lines)
  - `/tests/stream-pipeline/long-message-splitter.test.ts` -- Unit tests
- **Dependencies**: None (pure function, no imports beyond types)
- **Acceptance criteria**:
  - 8000-char text with `\n\n` separators and `maxLength: 4000` -> two chunks, each ending at `\n\n`
  - 5000-char single paragraph with `maxLength: 4000` -> split at last word boundary before 4000
  - Text containing a 500-char code block (triple backticks) that straddles the split point -> code block kept intact in one chunk, split happens before or after the block
  - Text with multi-byte UTF-8 characters (Cyrillic, emoji) -> split at character boundary, never mid-character
  - Text exactly at `maxLength` -> single chunk, no split
  - Empty text -> returns `[""]`
- **Shift-left mitigations**:
  - SL-E6: Multi-byte UTF-8 boundary handling (shift-left E6)
  - SL-MARKDOWN: Markdown structure preservation (QCSD ADR-010 functionality: "split never breaks a code block, heading, or link")
- **QCSD quality gates**:
  - QG-FUNC: Split never breaks a code block, heading, or link (QCSD functionality criterion)
  - QG-PERF: Splitting a 32 KB document completes in under 5ms
- **Estimated complexity**: LOW

---

## Milestone 4: Messenger Stream Adapter Interface and Batch Fallback

- **Bounded Context**: Response Delivery
- **Files to create**:
  - `/src/stream-pipeline/adapters/messenger-stream-adapter.ts` -- `MessengerStreamAdapter` interface and `MessengerStreamConfig` interface. Platform constants for Telegram (4096 chars, 30 msg/s, 1000ms flush), MAX (4096 chars, 30 RPS shared, 1000ms flush), Web (unlimited, 0ms flush), WhatsApp (batch-only). (~50 lines)
  - `/src/stream-pipeline/adapters/batch-fallback-adapter.ts` -- `BatchFallbackAdapter` implementing `MessengerStreamAdapter` for platforms that do not support editing (WhatsApp). `sendTypingIndicator` sends typing; `sendInitialMessage` sends the full text; `editMessage` is a no-op; `finalizeMessage` is a no-op. (~40 lines)
  - `/tests/stream-pipeline/adapters/batch-fallback-adapter.test.ts` -- Unit tests
- **Dependencies**: Milestone 0 (error types)
- **Acceptance criteria**:
  - `MessengerStreamAdapter` interface exposes: `sendTypingIndicator`, `sendInitialMessage`, `editMessage`, `finalizeMessage`, `config`
  - `MessengerStreamConfig` has readonly fields: `platform`, `maxEditsPerSecond`, `supportsTypingIndicator`, `supportsMessageEdit`, `maxMessageLength`, `recommendedFlushIntervalMs`
  - `BatchFallbackAdapter.editMessage()` resolves immediately without API calls
  - `BatchFallbackAdapter.config.supportsMessageEdit` is `false`
  - Platform string literals are a union type: `"telegram" | "max" | "web" | "whatsapp"`
- **Shift-left mitigations**:
  - SL-ADAPTER-HIERARCHY: Defining the interface explicitly as a port in hexagonal architecture prevents the "two parallel adapter hierarchies" risk (shift-left cross-ADR risk ADR-010 + ADR-006)
- **QCSD quality gates**:
  - QG-MAINT: All public interfaces exported from barrel `index.ts` with JSDoc (QCSD maintainability criterion)
- **Estimated complexity**: LOW

---

## Milestone 5: Telegram and MAX Stream Adapters

- **Bounded Context**: Response Delivery
- **Files to create**:
  - `/src/stream-pipeline/adapters/telegram-stream-adapter.ts` -- `TelegramStreamAdapter`: typing indicator with 4s renewal interval, `sendMessage` for initial, `editMessageText` for progress (swallows "message is not modified"), `editMessageText` with Markdown for final. Handles "message to edit not found" by sending a new message. (~90 lines)
  - `/src/stream-pipeline/adapters/max-stream-adapter.ts` -- `MaxStreamAdapter`: typing action, POST for initial, PUT for edits, PUT with format=markdown for final. Adaptive flush interval: increases to 2000ms when rate limit tracker reports >25 RPS. (~80 lines)
  - `/src/stream-pipeline/adapters/web-stream-adapter.ts` -- `WebStreamAdapter`: sends tokens directly via WebSocket frame or SSE event, no message editing needed, real-time delivery. (~60 lines)
  - `/tests/stream-pipeline/adapters/telegram-stream-adapter.test.ts` -- Integration tests with mock Telegram API
  - `/tests/stream-pipeline/adapters/max-stream-adapter.test.ts` -- Integration tests with mock MAX API
  - `/tests/stream-pipeline/adapters/web-stream-adapter.test.ts` -- Unit tests
- **Dependencies**: Milestone 4 (interface), Milestone 0 (error types)
- **Acceptance criteria**:
  - `TelegramStreamAdapter.sendTypingIndicator()` calls `sendChatAction("typing")` and sets a 4s renewal interval
  - `TelegramStreamAdapter.editMessage()` catches and ignores "message is not modified" errors
  - `TelegramStreamAdapter.finalizeMessage()` sends with `parse_mode: "Markdown"`; on edit failure, sends as new message
  - `TelegramStreamAdapter.finalizeMessage()` clears the typing renewal timer
  - `MaxStreamAdapter` increases flush interval to 2000ms when shared RPS > 25 (validated with mock returning 429)
  - `WebStreamAdapter` delivers each token as an individual SSE event or WebSocket frame with zero debounce
  - All adapters accept bot client/connection as constructor injection (not imported globally)
- **Shift-left mitigations**:
  - SL-E1: Telegram adapter handles HTTP 429 by backing off (shift-left E1)
  - SL-E2: If `sendInitialMessage` fails (bot blocked), error propagates cleanly with null messageId guard (shift-left E2)
  - SL-E7: Telegram "message to edit not found" triggers new message send (shift-left E7)
- **QCSD quality gates**:
  - QG-FUNC: `editMessageText` call frequency <= 1/s per chat on Telegram; <= 30 RPS total on MAX (QCSD performance criterion)
  - QG-REL: Timer cleanup verified on every adapter disposal path
  - QG-SEC: No raw subprocess stderr exposed through adapter error messages (R010-07)
- **Estimated complexity**: HIGH

---

## Milestone 6: StreamingResponseHandler -- Pipeline Orchestration

- **Bounded Context**: Response Delivery
- **Files to create**:
  - `/src/stream-pipeline/streaming-response-handler.ts` -- `handleStreamingResponse()` and `handleResponseWithFallback()` functions. Wires StreamParser, TokenAccumulator, and MessengerStreamAdapter. Manages ResponseStream lifecycle via typed state machine. Implements: (1) send typing immediately, (2) wire parser to accumulator, (3) read subprocess stdout via readline, (4) handle completion/error/timeout. 300s hard timeout kills subprocess. Session lock acquisition via `SessionLock` interface. Emits domain events. (~120 lines)
  - `/src/stream-pipeline/session-lock.ts` -- `SessionLock` interface (`acquire(sessionId, timeoutMs) -> LockHandle`) and in-memory implementation with per-session mutex
  - `/src/stream-pipeline/index.ts` -- Barrel export for the entire `@openclaw/stream-pipeline` module
  - `/tests/stream-pipeline/streaming-response-handler.test.ts` -- Integration tests with mock subprocess, mock adapter, fake timers
  - `/tests/stream-pipeline/session-lock.test.ts` -- Unit tests
- **Dependencies**: Milestones 1-5 (all streaming components), Milestone 0 (TenantContext, DomainEventBus, Timer)
- **Acceptance criteria**:
  - `sendTypingIndicator` is called before any content delivery (invariant: Typing Before Content)
  - First flush creates an initial message via `sendInitialMessage`; subsequent flushes call `editMessage`; final flush calls `finalizeMessage` with complete accumulated text
  - 300s timeout kills subprocess (`subprocess.kill()`) and delivers partial text via `finalizeMessage`
  - `handleResponseWithFallback` catches `PARSE_ERROR` from streaming and falls back to buffered batch read
  - Session lock prevents two concurrent ResponseStreams for the same session; second request receives "stream already active" rejection
  - Domain events emitted in order: `ResponseStreamInitiated` -> `TypingIndicatorSent` -> `FirstTokenReceived` -> `ProgressMessageSent` (1..N) -> `ResponseStreamCompleted`
  - On error: `ResponseStreamFailed` emitted; if recoverable with partialText, partial text delivered
  - `messageId` null guard: if `sendInitialMessage` failed, subsequent edit attempts send a new initial message instead of crashing
  - Long messages: when accumulated text approaches `maxMessageLength - 100`, current message is finalized and a new one started
  - Process exit handler: `child.on('exit')` triggers immediate error if no `onComplete` was received, not waiting for 300s timeout (shift-left E4)
- **Shift-left mitigations**:
  - SL-E4: `child.on('exit')` with non-zero code triggers immediate `SUBPROCESS_CRASH` error (shift-left E4)
  - SL-E5: SessionLock interface prevents concurrent streams for same session (shift-left E5, cross-ADR risk with ADR-009)
  - SL-E8: Proxy returning 502/503 before any events -> subprocess exit triggers immediate error path (shift-left E8)
  - SL-INVARIANT: State machine transitions enforced by `transition()` function with exhaustive switch (shift-left recommendation 1)
  - SL-CIRCUIT: Adapter calls wrapped with error handling; N consecutive adapter failures trigger graceful batch delivery of accumulated text (shift-left recommendation 3)
- **QCSD quality gates**:
  - QG-FUNC: Typing indicator sent within 500ms of user message (QCSD functionality criterion)
  - QG-PERF: TTFT under 3 seconds with mock subprocess (QCSD TC-003)
  - QG-REL: 5-minute hard timeout kills subprocess and delivers partial text (QCSD TC-004)
  - QG-REL: Memory per active stream under 2 MB (QCSD performance criterion)
  - QG-MAINT: State machine transitions covered by unit tests for every edge in FSM (QCSD maintainability criterion)
- **Estimated complexity**: HIGH

---

## Milestone 7: CommandParser -- Messenger Text to Training Commands

- **Bounded Context**: User Customization
- **Files to create**:
  - `/src/training-engine/types.ts` -- All training domain types: `TrainingCommand` discriminated union (30 variants), `TrainingResult`, `TrainingSummary`, `ClaudeMdSection` (string literal union), `ResponseStyle`, `DocumentFormat`, `AgentDefinition`, `McpServerConfig`, `HookDefinition`, `SkillDefinition`, `DocumentRef`, `ExportBundle`, `ImportResult`, `ImportConflict`, `ParseError`, `Attachment`
  - `/src/training-engine/command-parser.ts` -- `CommandParser.parse(rawText, attachments?)`: table-driven parser (not if/else chain) matching command patterns to `TrainingCommand` variants. Handles bracket section syntax `[section-name]` with case-insensitive normalization. Returns `ParseError` with Levenshtein-distance-3 suggestions for unrecognized commands. (~150 lines)
  - `/src/training-engine/validators.ts` -- Input validation: rule text sanitization (strip control chars, escape markdown heading injection, block prompt injection patterns like "ignore previous instructions"), URL validation (SSRF private IP check including redirect following), hook handler shell safety (allowlist approach), file size/format validation. (~120 lines)
  - `/tests/training-engine/command-parser.test.ts` -- Unit tests (write BEFORE implementation)
  - `/tests/training-engine/validators.test.ts` -- Unit tests for all security validators
- **Dependencies**: Milestone 0 (error types, TenantContext)
- **Acceptance criteria**:
  - `/train add rule: Always respond in Russian` -> `{ type: 'add_rule', rule: 'Always respond in Russian', section: 'behavioral-rules' }`
  - `/train add rule [security-rules]: Never run rm -rf` -> `{ type: 'add_rule', rule: 'Never run rm -rf', section: 'security-rules' }`
  - `/train add` (no rule text) -> `ParseError` with suggestion `"Did you mean /train add rule: ...?"`
  - `/train add rule:` (colon but no text) -> `ParseError` with message about empty rule
  - `/knowledge add` with attachment -> `{ type: 'add_knowledge', doc: ..., content: ... }`
  - `/tool add https://mcp.example.com --name weather` -> `{ type: 'add_tool', mcp: { url: 'https://mcp.example.com', name: 'weather', transport: 'sse' } }`
  - Section bracket parsing is case-insensitive: `[Domain Knowledge]` normalizes to `'domain-knowledge'`
  - Rule text containing `## Heading` is sanitized: heading markers escaped
  - Rule text containing prompt injection patterns rejected with security error
  - URL `http://169.254.169.254/meta-data` rejected by SSRF validator
  - URL `http://10.0.0.1/mcp` rejected by SSRF validator
  - Hook handler `npm test; curl evil.com` rejected by shell safety validator (semicolons, pipes, backticks, `$()` blocked)
  - Parser is table-driven: adding a new command variant requires adding a row to the pattern table, not modifying control flow
- **Shift-left mitigations**:
  - SL-TYPE-CONFLICT: `ClaudeMdSection` defined once as string literal union in `types.ts`, resolving the type conflict (shift-left testability gap 1)
  - SL-E7-TRAIN: Rule text sanitized to strip markdown heading injection (shift-left E7)
  - SL-CONTRACT-PARSE: Parser works with `NormalizedMessage` (from ADR-006), not raw platform data (shift-left cross-ADR contract ADR-011 + ADR-006)
- **QCSD quality gates**:
  - QG-FUNC: Parser returns `ParseError` with suggestion for malformed input matching within Levenshtein distance 3 (QCSD functionality criterion)
  - QG-SEC: Prompt injection patterns in rule text rejected (R011-01, QCSD TC-006)
  - QG-SEC: SSRF via private IP blocked (R011-02, QCSD TC-007)
  - QG-SEC: Shell injection in hook handler blocked (R011-03, QCSD TC-008)
  - QG-MAINT: Table-driven parser, not if/else chain (QCSD maintainability criterion)
- **Estimated complexity**: HIGH

---

## Milestone 8: ClaudeMdManager -- CLAUDE.md CRUD with Versioning

- **Bounded Context**: User Customization
- **Files to create**:
  - `/src/training-engine/claude-md-manager.ts` -- `ClaudeMdManager` implementation: `load`, `addRule`, `removeRule`, `updateRule`, `listRules`, `render`, `getHistory`, `rollback`. Uses `TenantRepository` for filesystem access (injectable). Version counter is a monotonic integer stored in file header; rollback creates a new version with old content. Rule IDs use a monotonic counter per document (not array position) for identity stability. Optimistic locking via expected version parameter. Size limit enforcement (32 KB after render, 50 rules per section). Emits `RuleAdded`/`RuleRemoved` domain events. (~180 lines)
  - `/src/training-engine/events.ts` -- Training domain event definitions: `RuleAdded`, `RuleRemoved`, `KnowledgeUploaded`, `KnowledgeRemoved`, `ToolRegistered`, `ToolUnregistered`, `StyleChanged`, `AgentCreated`, `ConfigExported`, `ConfigImported`, `HookRegistered`
  - `/tests/training-engine/claude-md-manager.test.ts` -- Unit tests with mock `TenantRepository`
- **Dependencies**: Milestone 0 (TenantContext, TenantRepository, DomainEventBus), Milestone 7 (types.ts, validators.ts)
- **Acceptance criteria**:
  - `addRule("tg_123", "Use Russian", "behavioral-rules")` increments version, adds rule to correct section, writes to repository, emits `RuleAdded` event
  - `addRule` to a section with 50 rules returns `{ success: false, message: 'Maximum 50 rules per section reached.' }`
  - `addRule` causing rendered CLAUDE.md to exceed 32 KB returns size limit error
  - `render(doc)` produces valid markdown: starts with `# CLAUDE.md`, contains version header, sections with `##` headers, rules as bullet points
  - `render()` is deterministic: same `ClaudeMdDocument` always produces identical string
  - Rule containing `## Fake Section\n- injected` renders without creating a false section header
  - `removeRule("tg_123", "rule-behavioral-rules-3")` removes rule; other rule IDs unchanged (rule-4 stays rule-4)
  - `rollback("tg_123", 5)` creates version N+1 with version 5's content; version 5 is not reused
  - `getHistory` returns previous versions from history directory
  - Optimistic locking: `addRule` with `expectedVersion: 5` when current version is 6 returns concurrent modification error
  - Idempotency: adding the exact same rule text twice to the same section adds two separate rules (append semantics, per DDD -- rules have identity)
- **Shift-left mitigations**:
  - SL-E1-TRAIN: Optimistic locking prevents lost writes from concurrent CLAUDE.md mutations (shift-left E1)
  - SL-RULE-ID: Rule IDs use monotonic counter, not array position, resolving the identity stability conflict (shift-left invariant 4 analysis)
  - SL-E4-TRAIN: File corruption from external edits detected by version/hash mismatch on load (shift-left E4)
  - SL-INVARIANT-VERSION: Rollback creates new version (never reuses), verified by test (shift-left invariant 3)
- **QCSD quality gates**:
  - QG-FUNC: Version increments monotonically on every mutation (QCSD functionality criterion)
  - QG-REL: CLAUDE.md rollback restores exact previous content (QCSD TC-021)
  - QG-REL: Concurrent writes serialized via optimistic locking (QCSD reliability criterion)
  - QG-PERF: `/train add rule` round-trip under 500ms (QCSD performance criterion)
  - QG-MAINT: Deterministic rendering enables snapshot testing (QCSD maintainability criterion)
  - QG-SEC: Rule text sanitization prevents markdown injection in rendered output (QCSD security criterion)
- **Estimated complexity**: HIGH

---

## Milestone 9: PersonaManager and MemoryManager

- **Bounded Context**: User Customization
- **Files to create**:
  - `/src/training-engine/persona-manager.ts` -- `PersonaManager` implementation: `setStyle`, `getStyle`, `setLanguage`, `addConstraint`, `removeConstraint`, `getPersona`, `renderPersona`. Reads/writes persona to `persona.json` via `TenantRepository`. Updates CLAUDE.md "Response Style" section via `ClaudeMdManager`. (~100 lines)
  - `/src/training-engine/memory-manager.ts` -- `MemoryManager` implementation: `store`, `search`, `retrieve`, `list`, `delete`, `autoLearn`. Wraps AgentDB (from `@claude-flow/cli`) with tenant-scoped namespace. `autoLearn` uses a pluggable `CorrectionAnalyzer` interface for testability (addresses shift-left "untestable autoLearn" gap). TTL-based cleanup. (~120 lines)
  - `/tests/training-engine/persona-manager.test.ts` -- Unit tests
  - `/tests/training-engine/memory-manager.test.ts` -- Unit tests with mock AgentDB
- **Dependencies**: Milestone 0 (TenantContext, TenantRepository), Milestone 8 (ClaudeMdManager for persona rendering to CLAUDE.md)
- **Acceptance criteria**:
  - `setStyle("tg_123", "formal")` updates persona.json and CLAUDE.md "Response Style" section
  - `getStyle("tg_123")` returns current style from persona.json
  - `addConstraint("tg_123", "Never disclose architecture")` adds to persona constraints and CLAUDE.md "Security Rules" section
  - `store("tg_123", "pref-lang", "Russian", ["preference"])` stores in namespace `tenant-tg_123`
  - `search("tg_123", "language preference")` returns semantically relevant entries
  - `autoLearn` with pluggable `CorrectionAnalyzer`: mock analyzer can be configured to detect/ignore specific patterns
  - Memory entries respect TTL; expired entries not returned by `search` or `list`
  - Tenant isolation: operations scoped by `tenantId`; no cross-tenant leakage
- **Shift-left mitigations**:
  - SL-AUTOLEARN: `autoLearn` uses injectable `CorrectionAnalyzer` interface, making it testable (shift-left testability gap 3)
  - SL-E12: False positive rate controllable via analyzer confidence threshold (shift-left E12)
  - SL-E8-MEM: Tenant ID validation prevents namespace collision (shift-left E8)
- **QCSD quality gates**:
  - QG-PERF: AgentDB semantic search under 200ms for 10K entries (QCSD TC-022)
  - QG-REL: Auto-learn false positive rate under 5% (QCSD TC-032, R011-07)
  - QG-SEC: Memory namespace isolation enforced per tenant
- **Estimated complexity**: MEDIUM

---

## Milestone 10: KnowledgeManager -- Cloud.ru RAG Integration

- **Bounded Context**: User Customization
- **Files to create**:
  - `/src/training-engine/knowledge-manager.ts` -- `KnowledgeManager` implementation: `upload`, `remove`, `list`, `search`, `stats`. Integrates with Cloud.ru Managed RAG API via injectable HTTP client. Upload flow: validate format/size -> send to chunking endpoint -> store `DocumentRef` -> update CLAUDE.md with RAG retrieval instruction. Saga pattern with compensating actions for multi-step upload. (~140 lines)
  - `/tests/training-engine/knowledge-manager.test.ts` -- Integration tests with mock RAG API
- **Dependencies**: Milestone 0 (TenantContext), Milestone 7 (types, validators for format/size), Milestone 8 (ClaudeMdManager for RAG instruction insertion)
- **Acceptance criteria**:
  - `upload("tg_123", "report.pdf", content, "pdf")` validates format and size (reject >50 MB), calls RAG chunking, stores `DocumentRef`, updates CLAUDE.md
  - 60 MB file upload rejected with "File too large. Maximum size is 50 MB."
  - Unsupported format (e.g., `.exe`) rejected
  - Tenant with 100 documents: 101st upload rejected with quota error
  - `remove("tg_123", "doc-abc")` removes from RAG collection and `DocumentRef` store
  - `search("tg_123", "vacation policy")` returns ranked `SearchResult[]` with scores
  - `search("tg_123", "")` returns error or empty results (not all documents)
  - Upload failure at chunking step: no `DocumentRef` stored, no CLAUDE.md modification (saga rollback)
  - `stats("tg_123")` returns collection statistics
  - `KnowledgeUploaded` domain event emitted on successful upload
- **Shift-left mitigations**:
  - SL-E2-TRAIN: RAG chunking timeout handled: partial chunks cleaned up via saga compensating action (shift-left E2)
  - SL-E9: Empty search query returns error with descriptive message (shift-left E9)
  - SL-SAGA: Multi-step upload uses saga pattern with compensating actions (shift-left recommendation 5)
- **QCSD quality gates**:
  - QG-FUNC: `/knowledge add` indexes document; searchable within 30 seconds (QCSD functionality criterion)
  - QG-PERF: 50 MB PDF indexed within 60 seconds (QCSD performance criterion)
  - QG-SEC: File content scanned for malicious payloads (R011-05)
- **Estimated complexity**: HIGH

---

## Milestone 11: ToolRegistry, HookManager, SkillManager

- **Bounded Context**: User Customization
- **Files to create**:
  - `/src/training-engine/tool-registry.ts` -- `ToolRegistry` implementation: `register`, `unregister`, `list`, `test`, `renderMcpConfig`. Health check on registration. URL validation with SSRF prevention (private IP block + redirect following). Tool name collision detection. Max 10 servers per tenant. Generates `mcp-config.json` for Claude Code. (~130 lines)
  - `/src/training-engine/hook-manager.ts` -- `HookManager` implementation: `addHook`, `removeHook`, `listHooks`, `toggleHook`. Shell command sanitization via allowlist. Writes to `hooks.json`. Integrates with Claude Code hook system (`.claude/hooks.json`). (~80 lines)
  - `/src/training-engine/skill-manager.ts` -- `SkillManager` implementation: `addSkill`, `removeSkill`, `listSkills`, `renderSkills`. Writes skill definitions to `/skills/{name}.md`. (~70 lines)
  - `/tests/training-engine/tool-registry.test.ts` -- Unit + integration tests with mock MCP server
  - `/tests/training-engine/hook-manager.test.ts` -- Unit tests
  - `/tests/training-engine/skill-manager.test.ts` -- Unit tests
- **Dependencies**: Milestone 0 (TenantContext, TenantRepository), Milestone 7 (types, validators for SSRF/shell safety)
- **Acceptance criteria**:
  - `register("tg_123", { url: "https://mcp.example.com", name: "weather", transport: "sse" })` performs health check, stores config, generates `mcp-config.json`
  - Registration of `http://169.254.169.254/metadata` rejected (SSRF)
  - Registration of URL that redirects to `http://10.0.0.1/internal` rejected (redirect SSRF)
  - 11th MCP server registration rejected with quota error
  - Duplicate tool name rejected with collision error
  - `test("tg_123", "weather")` returns `HealthCheckResult` with latency, tool count, tool list
  - `addHook("tg_123", { event: "post-task", handler: "npm test", timeout: 30000, enabled: true })` stores hook definition
  - `addHook` with handler `npm test; curl evil.com` rejected (shell injection)
  - `toggleHook("tg_123", "post-task", false)` disables without removing
  - `addSkill` writes skill definition to correct path
  - `ToolRegistered`, `HookRegistered` domain events emitted
- **Shift-left mitigations**:
  - SL-E11: SSRF via redirect detected and blocked (shift-left E11)
  - SL-E5-TOOL: Dead MCP servers logged but not auto-removed; periodic health monitoring marks degraded (shift-left E5)
  - SL-HOOK-SAFETY: Hook handler allowlist prevents arbitrary command execution (shift-left hook handler gap)
  - SL-ADR007-TIER: Tool registration checks user access tier (Restricted tier blocked from `/tool add`) to prevent bypassing ADR-007 tier enforcement (shift-left cross-ADR risk ADR-011 + ADR-007)
- **QCSD quality gates**:
  - QG-FUNC: `/tool add` health-checks before registration; fails if unreachable (QCSD functionality criterion)
  - QG-SEC: MCP URL allowlist enforced; private IPs blocked (QCSD security criterion, R011-02)
  - QG-SEC: Hook commands sanitized for shell injection (QCSD security criterion, R011-03)
  - QG-SEC: Export excludes MCP auth tokens (QCSD security criterion)
- **Estimated complexity**: HIGH

---

## Milestone 12: ConfigPorter -- Export/Import/Reset

- **Bounded Context**: User Customization
- **Files to create**:
  - `/src/training-engine/config-porter.ts` -- `ConfigPorter` implementation: `exportConfig`, `importConfig`, `resetConfig`. Export assembles `ExportBundle` from all managers (read-only); strips auth tokens from MCP configs. Import validates bundle schema (via Zod or JSON Schema), detects conflicts, supports resolution strategies (`keep`/`replace`/`merge`). Reset requires confirmation flag; wipes all tenant data and creates fresh default CLAUDE.md. (~150 lines)
  - `/tests/training-engine/config-porter.test.ts` -- Integration tests
- **Dependencies**: Milestone 8 (ClaudeMdManager), Milestone 9 (PersonaManager, MemoryManager), Milestone 10 (KnowledgeManager), Milestone 11 (ToolRegistry, HookManager, SkillManager)
- **Acceptance criteria**:
  - `exportConfig("tg_123", "json")` returns JSON string containing all rules, persona, hooks, skills, MCP configs (with auth stripped), knowledge refs (not content), memory entries
  - Exported MCP config has `auth: null` or `auth: { type: 'bearer', token: '***' }` (never real tokens)
  - `importConfig("tg_123", bundleJson, "json")` validates schema, imports rules, detects conflicts
  - Import with overlapping rule text: `ImportResult.conflicts` contains the overlap with `resolution` field
  - Import of bundle with MCP servers that have stripped auth: servers imported as "requires re-authentication"
  - Import of bundle with dangling knowledge refs: refs imported as stale with warning
  - `resetConfig("tg_123")` with `confirm: false` returns error "Send /config reset --confirm to proceed"
  - `resetConfig("tg_123")` with `confirm: true` wipes tenant data and creates default CLAUDE.md at version 1
  - `ConfigExported` and `ConfigImported` domain events emitted
  - Malformed JSON bundle rejected with specific validation error (schema validation)
- **Shift-left mitigations**:
  - SL-E3-IMPORT: Malformed bundle schema validated before processing (shift-left E3)
  - SL-E10-IMPORT: Dangling knowledge refs handled with warning, not silent failure (shift-left E10)
  - SL-INVARIANT-EXPORT: Export completeness verified: round-trip export/import produces identical training summary (shift-left invariant 6)
  - SL-E6-CONCURRENT: Import acquires exclusive lock on UserConfiguration aggregate to prevent concurrent mutation (shift-left quality scenario 6)
- **QCSD quality gates**:
  - QG-FUNC: Export/import round-trip lossless for all non-secret configuration (QCSD TC-009)
  - QG-SEC: Export excludes MCP auth tokens and API keys (QCSD security criterion)
  - QG-FUNC: Config reset requires confirmation (QCSD BDD scenario)
- **Estimated complexity**: MEDIUM

---

## Milestone 13: TrainingEngine Orchestrator

- **Bounded Context**: User Customization
- **Files to create**:
  - `/src/training-engine/training-engine.ts` -- `TrainingEngine` implementation: `execute(tenantId, command)` routes to appropriate manager via discriminated union switch. `parse(rawText, attachments)` delegates to `CommandParser`. `summary(tenantId)` aggregates state from all managers. `undo(tenantId, rollbackId)` delegates to `ClaudeMdManager.rollback`. Rate limiting: 10 commands/minute/tenant enforced at `execute()` entry point. Emits domain events through shared `DomainEventBus`. (~130 lines)
  - `/src/training-engine/index.ts` -- Barrel export for `@openclaw/training-engine`
  - `/tests/training-engine/training-engine.test.ts` -- Integration tests with mock managers
- **Dependencies**: All Milestones 7-12
- **Acceptance criteria**:
  - `execute("tg_123", { type: "add_rule", rule: "Use Russian" })` delegates to `ClaudeMdManager.addRule` and returns `TrainingResult`
  - `execute("tg_123", { type: "set_style", style: "formal" })` delegates to `PersonaManager.setStyle`
  - `execute("tg_123", { type: "add_tool", mcp: {...} })` delegates to `ToolRegistry.register`
  - 11th command within 60 seconds returns rate limit error
  - `summary("tg_123")` returns `TrainingSummary` with counts from all managers
  - `undo("tg_123", rollbackId)` rolls back the identified change
  - Domain events emitted through the shared `DomainEventBus`, not a private emitter (QCSD TC-CROSS-005)
  - Training command responses delivered as batch messages, NOT through streaming pipeline (shift-left cross-ADR risk ADR-011 + ADR-010)
- **Shift-left mitigations**:
  - SL-RATE-LIMIT: Rate limiting enforced at engine level, not gateway (shift-left recommendation 5: prevents bypasses via direct API access)
  - SL-CROSS-STREAM: Training responses bypass streaming pipeline (shift-left cross-ADR finding)
- **QCSD quality gates**:
  - QG-FUNC: Command round-trip under 500ms (QCSD performance criterion)
  - QG-REL: Rate limit: 10 training commands/minute/tenant enforced (QCSD performance criterion)
  - QG-MAINT: Each manager independently testable with zero cross-manager imports in unit tests (QCSD maintainability criterion)
- **Estimated complexity**: MEDIUM

---

## Milestone 14: Integration with cli-runner.ts

- **Bounded Context**: Response Delivery + User Customization (integration seam)
- **Files to create**:
  - `/src/agents/cli-runner-streaming.ts` -- Modified `runCliAgent()` integration: resolves `MessengerStreamAdapter` from gateway context, switches `--output-format` to `stream-json`, delegates to `handleResponseWithFallback()`. Legacy batch path preserved when no adapter available. (~60 lines of integration code, modifying existing patterns)
  - `/src/agents/cli-runner-training.ts` -- Training command routing: detects `/train`, `/knowledge`, `/tool`, `/style`, `/agent`, `/hook`, `/skill`, `/export`, `/import`, `/config` prefixes in user messages. Routes to `TrainingEngine.execute()` instead of `runCliAgent()`. Returns training result as batch message. (~50 lines)
  - `/tests/agents/cli-runner-streaming.test.ts` -- Integration tests
  - `/tests/agents/cli-runner-training.test.ts` -- Integration tests
- **Dependencies**: Milestone 6 (streaming handler), Milestone 13 (training engine), existing `cli-runner.ts` and `cli-backends.ts`
- **Acceptance criteria**:
  - Normal messages with a `streamAdapter` available -> streaming pipeline used
  - Normal messages without a `streamAdapter` -> legacy batch path
  - `--output-format stream-json` used when streaming; `--output-format json` when batch
  - Messages starting with `/train`, `/knowledge`, `/tool`, etc. -> routed to `TrainingEngine`, not to Claude Code subprocess
  - Training command responses delivered as single batch messages
  - Tenant workspace (`--cwd`) resolved from `TenantContext` (unified path)
  - `streamAdapter` resolved by gateway layer based on message source platform
- **Shift-left mitigations**:
  - SL-CLI-RUNNER: Integration point is minimal (`if (streamAdapter)` branch) per ADR-010 design (shift-left contract 3)
  - SL-PATH-UNIFIED: `--cwd` resolved from `TenantContext.workspacePath`, eliminating path disagreement (shift-left cross-cutting finding)
  - SL-CACHE: CLAUDE.md not cached in cli-runner; always read fresh by Claude Code subprocess from filesystem (shift-left contract 3 for ADR-011)
- **QCSD quality gates**:
  - QG-FUNC: Streaming pipeline activated for supported platforms; batch fallback for others
  - QG-FUNC: Training commands never reach Claude Code subprocess
  - QG-REL: No regressions in existing batch response path
- **Estimated complexity**: MEDIUM

---

## Dependency Graph

```
Milestone 0: Shared Kernel
  |
  +---> Milestone 1: StreamParser
  |       |
  |       +---> Milestone 2: TokenAccumulator
  |       |       |
  |       |       +---> Milestone 6: StreamingResponseHandler
  |       |                   |
  |       +---> Milestone 3: Long Message Splitter ---+
  |                                                    |
  +---> Milestone 4: Adapter Interface + Batch Fallback
  |       |
  |       +---> Milestone 5: Telegram/MAX/Web Adapters
  |               |
  |               +---> Milestone 6: StreamingResponseHandler ----+
  |                                                                |
  +---> Milestone 7: CommandParser + Validators + Types            |
  |       |                                                        |
  |       +---> Milestone 8: ClaudeMdManager                       |
  |       |       |                                                |
  |       |       +---> Milestone 9: PersonaManager + MemoryManager|
  |       |       |                                                |
  |       |       +---> Milestone 10: KnowledgeManager             |
  |       |       |                                                |
  |       |       +---> Milestone 11: ToolRegistry + Hooks + Skills|
  |       |               |                                        |
  |       |               +---> Milestone 12: ConfigPorter         |
  |       |                       |                                |
  |       +---> Milestone 13: TrainingEngine Orchestrator <--------+
  |               |                                                |
  +---> Milestone 14: Integration with cli-runner.ts <-------------+
```

## Parallel Execution Opportunities

The following milestones can be developed in parallel by independent developers/agents:

**Wave 1** (no dependencies beyond Milestone 0):
- Milestone 1 (StreamParser) and Milestone 7 (CommandParser) -- different bounded contexts, no shared code
- Milestone 3 (Long Message Splitter) and Milestone 4 (Adapter Interface) -- pure function and interface definition

**Wave 2** (after Wave 1):
- Milestone 2 (TokenAccumulator) and Milestone 5 (Telegram/MAX Adapters) -- both depend on Wave 1 outputs but not on each other
- Milestone 8 (ClaudeMdManager) can start as soon as Milestone 7 is done

**Wave 3** (after Wave 2):
- Milestone 6 (StreamingResponseHandler) needs Milestones 1-5
- Milestones 9, 10, 11 can all run in parallel once Milestone 8 is complete (they share ClaudeMdManager but do not depend on each other)

**Wave 4** (after Wave 3):
- Milestone 12 (ConfigPorter) needs Milestones 9-11
- Milestone 13 (TrainingEngine) needs Milestone 12

**Wave 5** (final):
- Milestone 14 (Integration) needs Milestones 6 and 13

**Optimal parallelism schedule:**

| Week | Stream A (Streaming Pipeline) | Stream B (Training Engine) |
|------|-------------------------------|----------------------------|
| 1 | M0: Shared Kernel (collaborative) | M0: Shared Kernel (collaborative) |
| 2 | M1: StreamParser + M3: Splitter + M4: Interface | M7: CommandParser + Validators |
| 3 | M2: TokenAccumulator + M5: Adapters | M8: ClaudeMdManager |
| 4 | M6: StreamingResponseHandler | M9: Persona + Memory, M10: Knowledge, M11: Tools/Hooks/Skills (3 sub-streams) |
| 5 | (buffer / cross-ADR integration tests) | M12: ConfigPorter + M13: TrainingEngine |
| 6 | M14: Integration with cli-runner.ts (collaborative) | M14: Integration with cli-runner.ts (collaborative) |

## Risk Register

| Risk ID | Risk | Probability | Impact | Milestone Affected | Mitigation |
|---------|------|:-----------:|:------:|:------------------:|-----------|
| R-001 | Workspace path disagreement (ADR-008 vs ADR-011) blocks all filesystem operations | High | Critical | M0 | **Must resolve before M0 starts.** Define canonical path in `TenantContext`. Get sign-off from both ADR authors. |
| R-002 | `stream-json` format changes in Claude Code update break StreamParser | Low | High | M1 | Pin Claude Code version in CI. Parser validates event structure and emits `PARSE_ERROR` on unknown format. Maintain format version compatibility tests (R010-01). |
| R-003 | Telegram `editMessageText` rate limit (429) under concurrent users | Medium | Medium | M5, M6 | Adaptive flush interval increases to 2s under load. Circuit breaker on adapter after 3 consecutive 429s. Monitor via `ProgressMessageSent` event count. (R010-02) |
| R-004 | MAX shared 30 RPS limit exhausted by streaming edits | Medium | High | M5, M6 | Adaptive flush interval. Global rate limit tracker shared across all MAX streams. Prioritize new messages over edits. (R010-03) |
| R-005 | CLAUDE.md prompt injection via `/train add rule` | Medium | High | M7, M8 | Rule text sanitization pipeline: strip control chars, block "ignore previous instructions" patterns, escape markdown injection. Allowlist approach for critical patterns. (R011-01) |
| R-006 | MCP server SSRF via `/tool add` with redirect to internal IP | Medium | Critical | M11 | URL validation resolves hostname to IP, blocks private ranges. Follows redirects and validates each hop. Tests with `169.254.169.254` and `10.0.0.0/8`. (R011-02) |
| R-007 | Shell injection via `/hook add` handler | Medium | Critical | M11 | Allowlist of safe commands. Reject semicolons, pipes, backticks, `$()` in handler strings. Restricted-tier users cannot add hooks. (R011-03) |
| R-008 | Concurrent CLAUDE.md writes lose data | Low | Medium | M8 | Optimistic locking with version check. Retry with re-read on conflict. Atomic filesystem writes (temp + rename). (R011-04) |
| R-009 | Subprocess exits with SIGKILL (OOM) and timeout waits 300s for dead process | Low | High | M6 | `child.on('exit')` triggers immediate `SUBPROCESS_CRASH` error, not waiting for timeout. Hard timeout is a safety net, not the primary detection mechanism. (shift-left E4) |
| R-010 | `onFlush` callback rejection from adapter failure causes unhandled promise rejection | Medium | High | M2, M6 | Accumulator wraps `onFlush` in try/catch. Error propagated to configurable error handler. Accumulation continues. Process does not crash. (shift-left E10) |
| R-011 | `ClaudeMdSection` type defined twice with conflicting meanings | High | Medium | M7 | Resolve in Milestone 0/7: define canonical `ClaudeMdSectionId` (string literal union) and `ClaudeMdSectionData` (interface with rules array) as distinct types. (shift-left type conflict) |
| R-012 | Cross-ADR event format mismatch: Cloud.ru `AgentEvent` vs Claude Code `StreamJsonEvent` | High | High | M1, M6 (future ADR-013 integration) | Design `StreamParser` to accept a generic `StreamSource` interface, not just subprocess stdout. Defer `AgentEvent` mapper to ADR-013 milestone but ensure the parser interface supports it. (QCSD cross-ADR TC-CROSS-010) |
| R-013 | Training changes not applied to Cloud.ru remote agents | Medium | Medium | M8, M13 (future ADR-013 integration) | Document limitation clearly. Add TODO for ADR-013 milestone to synchronize CLAUDE.md rules to remote agent `instructions` field. (QCSD TC-CROSS-014) |
| R-014 | Auto-learn stores hallucinated corrections degrading agent behavior | Medium | Low | M9 | Pluggable `CorrectionAnalyzer` with configurable confidence threshold. Conservative default (high threshold). Per-tenant tuning. TTL on auto-learned entries (30 days). (R011-07) |
| R-015 | RAG chunking failure leaves orphaned chunks in Cloud.ru collection | Low | Medium | M10 | Saga pattern with compensating actions: on `storeRef` failure, delete chunks from RAG. On CLAUDE.md update failure, remove `DocumentRef` and chunks. (shift-left E2) |
| R-016 | Export bundle with dangling knowledge references imported by different tenant | Low | Medium | M12 | Import marks dangling refs as stale with warning. User informed that documents must be re-uploaded. (shift-left E10-import) |
