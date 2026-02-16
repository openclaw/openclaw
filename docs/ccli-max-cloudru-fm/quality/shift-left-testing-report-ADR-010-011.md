> **SUPERSEDED:** This document references ADR-006..013 which were deleted during the v2 ADR rewrite (commit e54143f). ADR-001..005 v2 now cover this scope. Retained for historical context only.

# Shift-Left Testing Analysis: ADR-010 & ADR-011 (Level 4 -- Risk Analysis in Design)

**Date:** 2026-02-13
**Analyst:** QA Specialist -- Shift-Left Testing
**Scope:** ADR-010 (Streaming Response Pipeline), ADR-011 (User Training & Customization via Messenger)
**Method:** Level 4 shift-left testing -- identifying defects, missing error scenarios, and untestable designs before any code is written.

---

## ADR-010: Streaming Response Pipeline

**Bounded Context:** Response Delivery
**Aggregate:** ResponseStream

---

### 1. Testability Assessment: Score 72/100

| Criterion | Score | Rationale |
|-----------|:-----:|-----------|
| Interface mockability | 18/20 | `StreamParser`, `TokenAccumulator`, and `MessengerStreamAdapter` are all interfaces with clear method signatures. `ChildProcess` from Node.js stdlib is mockable via `EventEmitter`. Strong. |
| Compile-time invariant enforcement | 10/20 | The `StreamJsonEvent` discriminated union is well-typed and enables exhaustive switch/case. However, the state machine (`INITIATED -> TYPING_SENT -> STREAMING -> ...`) is described textually, not enforced via types. State transitions are runtime-only. |
| Acceptance criteria clarity | 12/20 | The ADR states "typing indicator within 500ms" and "progressive text within 2-3 seconds" but these are prose, not formal acceptance criteria. There is no BDD-style Given/When/Then. The test plan table lists 10 tests but no expected values for timing assertions. |
| Error path coverage | 14/20 | Four error codes are defined (`PARSE_ERROR`, `TIMEOUT`, `SUBPROCESS_CRASH`, `PROXY_ERROR`), plus a `recoverable` flag. Fallback to batch is specified. Missing: what happens when the messenger adapter itself fails (e.g., Telegram returns 429 during `editMessage`). |
| Domain event testability | 18/20 | Seven domain events are clearly defined with triggers and consumers. These are testable via event spy/mock patterns. |

**Key Testability Gaps:**

1. **State machine is not type-enforced.** The `ResponseStream` aggregate states (`INITIATED`, `TYPING_SENT`, `STREAMING`, `FINALIZING`, `DELIVERED`, `ERRORED`, `FALLBACK_BATCH`) are described in ASCII art but never appear in TypeScript interfaces. There is no `ResponseStreamState` type and no transition function. This means invalid state transitions (e.g., `DELIVERED -> STREAMING`) cannot be caught at compile time and must be tested at runtime.

2. **`handleStreamingResponse` is a 70-line function, not a class.** The orchestration function mixes stream wiring, timeout management, and error handling in a single closure. This makes it difficult to test individual phases in isolation without executing the full pipeline.

3. **Timer-dependent behavior.** `TokenAccumulator` uses `setInterval`/`setTimeout` internally. Tests must use fake timers (`jest.useFakeTimers()`) and advance them manually. The ADR does not specify whether the implementation should accept an injectable clock/timer dependency, which would improve testability.

---

### 2. Missing Error Scenarios

| # | Scenario | Current Coverage | Risk |
|---|----------|:----------------:|:----:|
| E1 | Messenger adapter `editMessage` returns HTTP 429 (rate limited) mid-stream | Not addressed | HIGH -- stream continues pushing tokens but adapter cannot deliver them; tokens accumulate unbounded |
| E2 | Messenger adapter `sendInitialMessage` fails (network error, bot blocked by user) | Not addressed | HIGH -- `messageId` remains `null`, subsequent `editMessage` calls will fail with null reference |
| E3 | Subprocess stdout emits partial JSON line (line split across OS pipe buffer boundaries) | Not addressed | MEDIUM -- `readline` handles this for newline-delimited data, but incomplete JSON within a line is not discussed |
| E4 | Subprocess exits with signal (SIGKILL/SIGTERM from OOM killer) without emitting result event | Partially -- timeout handles it after 300s | HIGH -- 300s is too long to wait for a dead process; `child.on('exit')` should trigger immediate error |
| E5 | Two concurrent messages from same user in same chat (race on session lock) | Invariant 2 mentions "session lock" but no interface for it | MEDIUM -- the ADR references `serialize: true` but ADR-009 supersedes this with a worker pool |
| E6 | Accumulated text exceeds `maxMessageLength` exactly at a multi-byte UTF-8 character boundary | Not addressed | LOW -- `split()` at character count may split a multi-byte character if the platform counts bytes, not chars |
| E7 | `editMessageText` succeeds but Telegram returns a different `message_id` (message was deleted and recreated by Telegram) | Not addressed | LOW -- unlikely but would cause all subsequent edits to target a nonexistent message |
| E8 | `claude-code-proxy` returns HTTP 502/503 before any SSE events are emitted | Not addressed | MEDIUM -- no `onToken` fires, no `onComplete` fires; only timeout catches this after 300s |
| E9 | Web platform SSE/WebSocket connection drops during streaming | Not addressed | MEDIUM -- `WebStreamAdapter` interface is defined but reconnection/resumption semantics are absent |
| E10 | `onFlush` callback throws (adapter failure during flush) | Not addressed | HIGH -- `TokenAccumulator` calls `onFlush` from a timer; unhandled rejection could crash the process |

---

### 3. DDD Invariant Enforcement

**Invariant 1: Single Active Stream per conversation**

- **Current enforcement:** "existing `serialize: true` in `cli-backends.ts` and a per-session mutex."
- **Problem:** ADR-009 supersedes `serialize: true` with a worker pool. The "per-session mutex" is not defined in any interface. There is no `SessionLock` or `Mutex` type.
- **Recommendation:** Define a `SessionLock` interface that the `StreamingResponseHandler` acquires before creating a `ResponseStream`. Write a test that spawns two concurrent requests for the same session and asserts the second receives a "stream already active" rejection.

```typescript
// Recommended type enforcement
interface SessionLock {
  acquire(sessionId: string, timeoutMs: number): Promise<LockHandle>;
}
interface LockHandle {
  release(): void;
  readonly acquired: boolean;
}
```

**Invariant 2: Typing Before Content**

- **Current enforcement:** "The adapter must not throw on typing indicator failure (fire-and-forget)."
- **Problem:** The `sendTypingIndicator` method returns `Promise<void>` -- callers can still `await` and fail on rejection. "Fire-and-forget" is a comment, not a type constraint.
- **Recommendation:** Either change the return type to `void` (synchronous fire-and-forget) or wrap the call in `handleStreamingResponse` with `.catch(() => {})` and test that typing failures do not propagate.

**Invariant 3: Final Message Integrity**

- **Well-defined.** The `finalizeMessage` call receives the complete accumulated text. Testable by asserting the text passed to `finalizeMessage` equals the concatenation of all tokens.
- **Gap:** If the long-message splitter is active, the "final message" is only the last chunk. The invariant should clarify: "the complete response is the ordered set of all finalized messages."

**Invariant 4: Timeout Guarantee (300s)**

- **Well-defined** in the orchestration code with `setTimeout(300_000)`.
- **Gap:** The ADR says "The aggregate must be garbage-collected within 5 minutes of creation" (Aggregate invariant 4), but the timeout is on the handler, not the aggregate. If the handler is GC'd but the subprocess is not killed, the subprocess leaks.
- **Recommendation:** Test that `subprocess.kill()` is called on timeout, not just `parser.destroy()`.

**Invariant 5: Graceful Degradation**

- **Well-defined** in `handleResponseWithFallback`. Testable by feeding non-JSON to the first `parser.feed()` call and asserting fallback path executes.

**Domain Events:**

All seven events are well-defined with clear triggers. They can be tested by subscribing to an event bus mock and asserting emission order: `ResponseStreamInitiated` -> `TypingIndicatorSent` -> `FirstTokenReceived` -> `ProgressMessageSent` (1..N) -> `ResponseStreamCompleted`.

**Missing domain event:** There is no event for "message split due to length limit." This would be valuable for metrics (how often do responses exceed 4096 chars?).

---

### 4. Missing Acceptance Criteria

**BDD Scenarios Needed:**

```gherkin
Scenario: Streaming response delivers progressive updates
  Given a user sends a message via Telegram
  And the Claude Code subprocess emits tokens incrementally
  When 80 characters have accumulated and 1000ms have elapsed
  Then an editMessageText call is made with the accumulated text
  And a "..." suffix is appended to indicate ongoing generation

Scenario: Streaming response falls back to batch on parse failure
  Given a user sends a message via Telegram
  And the Claude Code subprocess outputs non-JSON data
  When the StreamParser receives the first line
  Then the system falls back to batch mode
  And the user receives the full response as a single message
  And no error is visible to the user

Scenario: Streaming response handles timeout
  Given a user sends a message via Telegram
  And the Claude Code subprocess does not emit a result event within 300 seconds
  When the timeout fires
  Then the partial accumulated text is delivered as a final message
  And a ResponseStreamFailed event is emitted
  And the subprocess is killed

Scenario: Long response is split across multiple messages
  Given a user sends a message via Telegram
  And the Claude Code response exceeds 4096 characters
  When the accumulated text approaches 4000 characters
  Then the current message is finalized
  And a new message is sent for the remaining text

Scenario: Typing indicator is sent before content
  Given a user sends a message via any messenger
  When the streaming response handler starts
  Then sendTypingIndicator is called within 500ms
  And no content is delivered before the typing indicator

Scenario: Concurrent stream requests for same session are rejected
  Given a user sends a message and a stream is already active
  When a second message arrives for the same session
  Then the second request is queued or rejected
  And the first stream is not interrupted

Scenario: MAX platform rate limit causes adaptive flush interval
  Given 10 concurrent streaming responses are active on the MAX platform
  And the shared 30 RPS limit is being approached
  When the rate limit tracker detects > 25 RPS usage
  Then the flush interval is increased to 2000ms for all active streams
```

**Undefined Integration Contracts:**

1. **StreamParser <-> ChildProcess stdout:** The contract that stdout emits valid newline-delimited JSON is implicit. There is no schema validation step. If Claude Code changes the `stream-json` format, failures are detected only at runtime.
2. **TokenAccumulator <-> MessengerStreamAdapter:** The `onFlush` callback contract does not specify error handling semantics. What happens if `onFlush` rejects? Retry? Skip? Cancel stream?
3. **StreamingResponseHandler <-> cli-runner.ts:** The integration point is sketched as an `if (streamAdapter)` branch but the `streamAdapter` resolution logic is undefined -- who creates it, how is it injected, and what happens if resolution fails?

---

### 5. Pre-Implementation Tests

#### Unit Tests (write BEFORE implementation)

1. **`StreamParser.feed()` emits `onToken` for valid assistant text events.** Feed `{"type":"assistant","subtype":"text","content":"hello"}` and assert the `onToken` callback receives `"hello"`.

2. **`StreamParser.feed()` emits `onComplete` for result success events.** Feed `{"type":"result","subtype":"success","result":"done","session_id":"s1"}` and assert `onComplete` fires with `CompleteResponse` containing `sessionId: "s1"`.

3. **`StreamParser.feed()` emits `onError` with `PARSE_ERROR` for malformed JSON.** Feed `"not json at all"` and assert `onError` fires with `code: "PARSE_ERROR"`.

4. **`StreamParser.end()` with non-zero exit code emits `onError` with `SUBPROCESS_CRASH`.** Call `end(1)` without a prior `onComplete` event and assert `onError` fires with `code: "SUBPROCESS_CRASH"` and `partialText` containing any accumulated tokens.

5. **`TokenAccumulator` flushes on interval when buffer >= minCharsToFlush.** Push 100 characters, advance fake timer by `flushIntervalMs`, and assert `onFlush` was called with the accumulated text.

6. **`TokenAccumulator` force-flushes at maxBufferSize without waiting for timer.** Push `maxBufferSize + 1` characters in a single `push()` call and assert `onFlush` fires immediately (without timer advance).

7. **`TokenAccumulator.finalize()` flushes remaining buffer with `isFinal: true`.** Push 10 characters (below `minCharsToFlush`), call `finalize()`, and assert `onFlush` fires with `isFinal: true`.

8. **`TokenAccumulator.cancel()` clears timer and does not flush.** Push tokens, call `cancel()`, advance timer, and assert `onFlush` was never called.

9. **`splitLongMessage()` splits at paragraph boundaries.** Given text with `\n\n` separators totaling 8000 chars and `maxLength: 4000`, assert the result is two chunks, each ending at a `\n\n` boundary.

10. **`splitLongMessage()` splits at word boundary when no paragraph break exists.** Given a 5000-char single paragraph, assert the split occurs at a space character, not mid-word.

#### Integration Tests

1. **Full pipeline: mock subprocess -> StreamParser -> TokenAccumulator -> mock MessengerStreamAdapter.** Emit 5 token events with 200ms spacing from a mock `Readable` stream. Assert: (a) `sendTypingIndicator` called first, (b) `sendInitialMessage` called after first flush, (c) `editMessage` called on subsequent flushes, (d) `finalizeMessage` called after result event.

2. **Fallback to batch: mock subprocess emits non-JSON output.** Feed invalid data into the pipeline via `handleResponseWithFallback`. Assert: (a) `handleStreamingResponse` throws `StreamError` with `PARSE_ERROR`, (b) `collectSubprocessOutput` is called, (c) `sendInitialMessage` delivers the batch response.

3. **Telegram adapter integration: mock Telegram Bot API.** Wire `TelegramStreamAdapter` to a mock HTTP server mimicking Telegram Bot API. Assert: (a) `sendChatAction("typing")` is called, (b) `sendMessage` returns a `message_id`, (c) `editMessageText` is called with accumulated text, (d) "message is not modified" errors are silently swallowed.

4. **Timeout kills subprocess and delivers partial text.** Start pipeline with a mock subprocess that never emits a result event. Advance fake timer past 300s. Assert: (a) subprocess `kill()` is called, (b) `finalizeMessage` is called with partial text, (c) `ResponseStreamFailed` event is emitted.

5. **MAX adapter adaptive rate limiting.** Simulate the MAX mock API returning HTTP 429 on `editMessage`. Assert: (a) the adapter retries after a backoff delay, (b) the flush interval is increased.

#### E2E Test Scenarios

1. **Happy path: User sends message in Telegram, receives streaming response.** A real (or realistically mocked) Claude Code subprocess is spawned with `--output-format stream-json`. A test Telegram bot sends a message, and a test client observes: (a) typing indicator appears, (b) message appears and progressively updates, (c) final message contains the complete response with Markdown formatting.

2. **Degraded path: proxy failure mid-stream.** During an active streaming response, the test proxy is killed. Assert: (a) partial text is delivered as a final message, (b) the user sees no error UI, (c) `FallbackToBatch` event is emitted.

---

### 6. Cross-ADR Integration Risks

| ADR Pair | Integration Risk | Contract Test Needed |
|----------|-----------------|---------------------|
| **ADR-010 + ADR-006** (Messenger Adapters) | `MessengerStreamAdapter` is a new interface distinct from ADR-006's `MessengerAdapter`. There is no shared base type. Risk: two parallel adapter hierarchies with inconsistent platform behavior. | Contract test: every platform that has a `MessengerAdapter` (ADR-006) must also have a compatible `MessengerStreamAdapter` (ADR-010). Verify that `platform` identifiers match. |
| **ADR-010 + ADR-009** (Concurrent Requests) | ADR-010 assumes "at most one active ResponseStream per conversation" enforced by a session lock. ADR-009 introduces a worker pool that replaces `serialize: true`. Risk: the worker pool may assign two workers to the same session if the session lock is not implemented. | Contract test: submit two requests for the same `sessionId` to the worker pool. Assert the second is queued, not executed concurrently. |
| **ADR-010 + ADR-008** (Multi-Tenant Session Isolation) | ADR-010 uses `sessionId` but does not define how it maps to `TenantId`. ADR-008 defines `SessionId = "{tenantId}:{conversationId}"`. Risk: the streaming pipeline could accidentally cross tenant boundaries if sessionId parsing is inconsistent. | Contract test: a `ResponseStream` for tenant A cannot deliver messages to tenant B's chat. Verify `chatId` is always resolved from the tenant context, not from the session alone. |
| **ADR-010 + ADR-007** (Tools & MCP) | ADR-010 defines `onToolUse` in the `StreamParser` as "informational -- tools are disabled." ADR-007 enables tools for Standard and Full tiers. Risk: when tools are enabled, `stream-json` will emit `tool_use` and `tool_result` events that interrupt the text stream. The `TokenAccumulator` has no concept of "pause during tool execution." | Contract test: emit a sequence of `text`, `tool_use`, `tool_result`, `text` events. Assert: (a) tool events do not corrupt the accumulated text, (b) token delivery pauses during tool execution, (c) the final text is the concatenation of all `text` events. |
| **ADR-010 + ADR-012** (Plugin Architecture) | ADR-012 defines `@openclaw/stream-pipeline` as a Shared Kernel with the core. Risk: if the streaming protocol types (e.g., `StreamJsonEvent`) are defined inside the pipeline module, consumers in other modules must import from it, creating a coupling point. | Contract test: verify that `StreamJsonEvent` types are re-exported from `@openclaw/core` or a shared types package, not imported directly from `@openclaw/stream-pipeline`. |
| **ADR-010 + ADR-013** (AI Fabric Agents) | ADR-013 introduces remote agents (Cloud.ru AI Fabric) that do not use Claude Code CLI. These agents will not emit `stream-json` events on stdout. Risk: the streaming pipeline is tightly coupled to Claude Code's `stream-json` format and will not work with remote agents. | Contract test: verify that `IAgentProvider.execute()` can return a generic `ReadableStream<AgentEvent>` that both local CLI and remote HTTP providers implement, and that `StreamParser` can adapt to both event formats. |

---

### 7. Defect Prevention Recommendations

**Architectural Patterns:**

1. **State Machine as a Type.** Replace the prose state machine with a typed state machine library or discriminated union pattern:

```typescript
type ResponseStreamState =
  | { status: 'INITIATED' }
  | { status: 'TYPING_SENT'; sentAt: number }
  | { status: 'STREAMING'; messageId: string; tokenCount: number }
  | { status: 'FINALIZING'; messageId: string; totalText: string }
  | { status: 'DELIVERED'; response: CompleteResponse }
  | { status: 'ERRORED'; error: StreamError }
  | { status: 'FALLBACK_BATCH'; partialText: string };

function transition(
  current: ResponseStreamState,
  event: ResponseStreamEvent,
): ResponseStreamState; // Exhaustive switch enforced by TypeScript
```

2. **Injectable Clock.** The `TokenAccumulator` should accept a `Clock` or `Timer` interface for testability:

```typescript
interface Timer {
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}
```

3. **Circuit Breaker on Adapter.** Wrap `MessengerStreamAdapter` calls in a circuit breaker that opens after N consecutive failures (e.g., 3 failed `editMessage` calls). When open, buffer tokens locally and attempt to deliver the complete response as a single message when the circuit half-opens.

4. **Backpressure Signal.** The `TokenAccumulator` should support a backpressure signal from the `onFlush` callback. If `onFlush` is slow (messenger API is overloaded), the accumulator should pause the `StreamParser` (stop calling `feed()`) until the flush completes. Without this, memory grows unbounded during API outages.

**Runtime Validations:**

1. **Validate every `feed()` input** -- attempt `JSON.parse()`, and on failure emit `onError` with `PARSE_ERROR` including the raw line for debugging.
2. **Validate `StreamJsonEvent.type`** against the known discriminated union. Unknown types should be logged and ignored, not cause a crash.
3. **Validate `messageId` is non-null** before calling `editMessage` or `finalizeMessage`. Add a guard that sends a new initial message if `messageId` is unexpectedly null.
4. **Validate accumulated text length** before passing to adapter. If text exceeds `maxMessageLength`, trigger the long-message splitter proactively, not reactively.
5. **Monitor timer cleanup.** On `destroy()`, assert all intervals/timeouts have been cleared. In tests, check for leaked timers using `jest.getTimerCount()`.
6. **Process exit handler.** Register `process.on('exit', ...)` to kill any lingering subprocesses, preventing orphaned Claude Code processes consuming resources.

---
---

## ADR-011: User Training & Customization via Messenger

**Bounded Context:** User Customization
**Aggregate:** UserConfiguration

---

### 1. Testability Assessment: Score 65/100

| Criterion | Score | Rationale |
|-----------|:-----:|-----------|
| Interface mockability | 17/20 | All six manager interfaces (`ClaudeMdManager`, `KnowledgeManager`, `MemoryManager`, `ToolRegistry`, `PersonaManager`, `HookManager`) are clearly defined with typed methods. The `TrainingEngine` orchestrator delegates to them, making it trivially mockable. |
| Compile-time invariant enforcement | 8/20 | `TrainingCommand` is a discriminated union (good), but critical constraints are only runtime: CLAUDE.md max size (32KB), max rules per section (50), max MCP servers (10). These limits are not expressible in TypeScript's type system and must be tested via runtime guards. The `ClaudeMdSection` type is defined twice with conflicting meanings (once as a string literal union, once as an interface name). |
| Acceptance criteria clarity | 10/20 | No BDD scenarios. No latency or performance requirements. The command syntax is documented but there are no formal acceptance criteria for parsing edge cases (e.g., what if a user types `/train add rule:` with no text after the colon?). |
| Error path coverage | 12/20 | Security constraints table lists 10 enforcement points. But error responses are generic (`TrainingResult.success: false` with a `message` string). No typed error codes for the training domain. No specification of what the user sees when a command fails. |
| Domain event testability | 18/20 | Eleven domain events are defined with clear triggers and payloads. Testable via event mock. |

**Key Testability Gaps:**

1. **`ClaudeMdSection` type conflict.** The type `ClaudeMdSection` is defined twice: once in `types.ts` as a string literal union (`'behavioral-rules' | 'domain-knowledge' | ...`) and again in `claude-md-manager.ts` as an interface with `id`, `name`, and `rules` fields. The `ClaudeMdManager.addRule()` method takes `section: ClaudeMdSection` -- which one? This is a compile-time ambiguity that will cause implementation confusion.

2. **Rule ID stability invariant is fragile.** Invariant 4 states "Removing rule 3 does not renumber rule 4 to rule 3." But the rule ID format is `rule-{section}-{index}`. If the index is the insertion order, this works. If the index is the position in the array, removal and re-insertion could create collisions. The ADR does not specify how `{index}` is generated -- monotonic counter? UUID? Array position?

3. **`autoLearn` is untestable as specified.** The `MemoryManager.autoLearn()` method "analyzes the conversation for explicit corrections" but provides no interface for the analysis logic. What NLP/heuristic is used? How do we test that "No, I meant..." triggers a correction entry but "No, thank you" does not? Without a pluggable analyzer interface, this is a black box.

4. **Filesystem dependency.** The `ClaudeMdManager` reads/writes files from `/data/tenants/{tenantId}/CLAUDE.md`. Tests must either use a real filesystem (slow, flaky) or the manager must accept an injectable filesystem abstraction. Neither is specified.

5. **`HookDefinition.handler` is a shell command string.** Testing hook registration requires validating shell command safety (no injection). The ADR says "No shell injection in hook commands" but does not specify the sanitization approach (allowlist? regex? AST parse?).

---

### 2. Missing Error Scenarios

| # | Scenario | Current Coverage | Risk |
|---|----------|:----------------:|:----:|
| E1 | Concurrent `/train add rule` commands from the same tenant (race condition on CLAUDE.md file write) | Not addressed | HIGH -- two writes interleave, one is lost. Version counter may skip or duplicate. |
| E2 | User uploads a 50MB PDF that fails during RAG chunking (Cloud.ru service timeout) | Not addressed | MEDIUM -- partial chunks in the RAG collection; `DocumentRef` stored but unusable. |
| E3 | `/import` command with a malformed JSON/YAML bundle | Only `ImportResult.conflicts` is defined | MEDIUM -- no `ParseError` for the bundle itself; schema validation not specified. |
| E4 | CLAUDE.md file is manually edited or deleted on disk while the engine is running | Not addressed | MEDIUM -- in-memory version counter diverges from filesystem state. |
| E5 | MCP server health check succeeds at registration but the server goes offline permanently afterward | Invariant 5 says "subsequent failures are logged but do not auto-remove" | LOW -- but accumulated dead servers pollute the tool registry and confuse users. |
| E6 | `/config reset --confirm` is issued while another training command is in flight | Not addressed | MEDIUM -- reset and add interleave; the add may write to the reset file. |
| E7 | User sends `/train add rule: <script>alert('xss')</script>` (markdown injection via rendered CLAUDE.md) | Security table mentions "Rule text sanitization" but no spec for what is sanitized | MEDIUM -- CLAUDE.md is markdown; injected HTML may execute in contexts where it is rendered (e.g., web dashboard). |
| E8 | AgentDB memory namespace collision if `tenantId` contains special characters | Not addressed | LOW -- tenant IDs like `tg_123` are safe, but future platforms might introduce characters that conflict with namespace delimiters. |
| E9 | `/knowledge search` with an empty query string | Not addressed | LOW -- should return an error or all documents? |
| E10 | Export bundle references documents that have been deleted from RAG | `knowledgeRefs` are "references only; not file content" | MEDIUM -- importing this bundle creates dangling references. |
| E11 | User registers an MCP server URL that redirects to an internal IP (SSRF via redirect) | Security table mentions "MCP URL allowlist, private IP block" but no mention of redirect following | HIGH -- the initial URL passes the allowlist, but the redirect targets `169.254.169.254` or `10.0.0.x`. |
| E12 | Auto-learn stores incorrect corrections (user says "No, I don't want that" meaning rejection, not correction) | Not addressed | MEDIUM -- false positive corrections degrade agent behavior over time. |

---

### 3. DDD Invariant Enforcement

**Invariant 1: Tenant Isolation**

- **Enforcement:** "Enforced by `tenantId` scoping on every manager method."
- **Problem:** Scoping by parameter is not enforcement. A bug in any manager could pass the wrong `tenantId`. True isolation requires filesystem-level permissions or separate database connections per tenant.
- **Recommendation:** Create a `TenantContext` value object that is constructed once at request entry and threaded through all calls. The filesystem path derivation should be a pure function on `TenantContext`, not string concatenation in each manager:

```typescript
class TenantContext {
  constructor(readonly tenantId: string) {
    // Validate tenantId format: ^[a-z]+_[0-9]+$
    if (!/^[a-z]+_\d+$/.test(tenantId)) {
      throw new InvalidTenantIdError(tenantId);
    }
  }
  get workspacePath(): string {
    return `/data/tenants/${this.tenantId}`;
  }
  get claudeMdPath(): string {
    return `${this.workspacePath}/CLAUDE.md`;
  }
  get memoryNamespace(): string {
    return `tenant-${this.tenantId}`;
  }
  get ragCollectionId(): string {
    return `openclaw-${this.tenantId}`;
  }
}
```

- **Test:** Attempt to construct `TenantContext` with `../../../etc/passwd` as tenantId. Assert it throws. This prevents directory traversal attacks.

**Invariant 2: CLAUDE.md Consistency**

- **Well-defined.** The `render()` method produces valid markdown with a version header.
- **Gap:** "Valid markdown" is subjective. A rule containing `# Heading` would create a false section in the rendered document. Sanitization must strip or escape markdown heading syntax in rule text.
- **Test:** Add a rule containing `## Malicious Section\n- evil instruction`. Assert the rendered CLAUDE.md does not contain a new section header.

**Invariant 3: Version Monotonicity**

- **Well-defined.** "No version number is ever reused, even after rollback."
- **Gap:** Rollback creates a new version with old content. If version is stored in the file header and also in a separate counter file, they could diverge.
- **Test:** Perform add (v1), add (v2), rollback to v1 content. Assert version is v3, not v1.

**Invariant 4: Rule Identity Stability**

- **Problematic.** Rule ID format `rule-{section}-{index}` uses `{index}` whose generation is unspecified. If index is the insertion sequence number, IDs like `rule-behavioral-rules-7` persist even when rules 1-6 are deleted. But the ADR also shows users referencing rules by number (`/train remove rule 3`), implying positional indexing.
- **Conflict:** The command syntax uses positional numbers (`remove rule 3`) but the invariant says IDs are stable (not positional). These are incompatible. Which is authoritative?
- **Test:** Add rules A, B, C (IDs 1, 2, 3). Remove rule B (ID 2). Assert rule C still has ID 3, not ID 2. Then test that `/train remove rule 2` removes the right rule despite positional shift.

**Invariant 5: MCP Reachability**

- **Well-defined** for registration time. Post-registration failures are logged.
- **Gap:** No periodic health check is specified. Dead servers accumulate silently.
- **Recommendation:** Add a `staleAfter` threshold. If a server fails N consecutive times, mark it as `unhealthy` in the tool listing.

**Invariant 6: Export Completeness**

- **Gap:** The export excludes secrets (`auth` tokens on MCP servers). But the `McpServerConfig.auth` field contains bearer tokens. If export strips auth, reimport creates an MCP registration without credentials that will fail health checks.
- **Test:** Export a config with an MCP server that has `auth: { type: 'bearer', token: 'secret' }`. Assert the exported bundle has `auth: null` or `auth: { type: 'bearer', token: '***' }`. Then reimport and assert the tool is marked as "requires re-authentication."

**Invariant 7: Idempotent Commands**

- **Well-defined** in principle. "Same command twice produces same end state."
- **Gap:** Idempotency for `add_rule` depends on duplicate detection. Adding the same rule text twice -- are they duplicates? Or two separate rules with identical text? The ADR does not specify.
- **Test:** Execute `{ type: 'add_rule', rule: 'Use Russian' }` twice. Assert only one rule exists (idempotent) OR assert two rules exist (append semantics). Whichever is chosen, document it.

---

### 4. Missing Acceptance Criteria

**BDD Scenarios Needed:**

```gherkin
Scenario: User adds a behavioral rule via Telegram
  Given a tenant "tg_12345" with an existing CLAUDE.md at version 5
  When the user sends "/train add rule: Always respond in Russian"
  Then the rule "Always respond in Russian" is added to the "behavioral-rules" section
  And the CLAUDE.md version is incremented to 6
  And the previous version 5 is stored in history
  And the user receives "Rule added to Behavioral Rules (v6). N rules total"
  And a RuleAdded domain event is emitted

Scenario: User exceeds maximum rules per section
  Given a tenant with 50 rules in the "behavioral-rules" section
  When the user sends "/train add rule: One more rule"
  Then the command is rejected
  And the user receives "Maximum 50 rules per section reached. Remove a rule first."
  And the CLAUDE.md version is NOT incremented

Scenario: User uploads a PDF for knowledge base
  Given a tenant with 5 existing knowledge documents
  When the user sends "/knowledge add" with a 10MB PDF attachment
  Then the PDF is chunked into N chunks
  And the chunks are indexed in the tenant's RAG collection
  And a DocumentRef is stored in the UserConfiguration aggregate
  And the user receives "Uploaded report.pdf: N chunks indexed (doc ID: xxx)"

Scenario: User uploads a file exceeding size limit
  Given a tenant
  When the user sends "/knowledge add" with a 60MB file
  Then the command is rejected
  And the user receives "File too large. Maximum size is 50 MB."

Scenario: User registers an MCP server
  Given a tenant with 3 registered MCP servers
  When the user sends "/tool add https://mcp.example.com/api --name my-api"
  Then the system performs a health check on the URL
  And the MCP server is registered with discovered tools
  And the user receives "Registered my-api with N tools: tool1, tool2"

Scenario: MCP server registration fails health check
  Given a tenant
  When the user sends "/tool add https://unreachable.example.com --name bad-api"
  And the health check fails with a connection timeout
  Then the registration is rejected
  And the user receives "Could not reach bad-api: connection timed out"

Scenario: User exports and reimports configuration
  Given a tenant with 10 rules, 3 knowledge docs, and 2 MCP servers
  When the user sends "/export json"
  Then the user receives a JSON file attachment
  And the JSON contains all rules, knowledge refs (not content), persona, hooks
  And the JSON does NOT contain MCP auth tokens
  When a different tenant imports this JSON via "/import"
  Then all rules are imported
  And knowledge refs are imported as stale references
  And MCP servers are imported without auth (marked as "requires setup")

Scenario: Config reset requires confirmation
  Given a tenant with an active configuration
  When the user sends "/config reset" without --confirm
  Then the user receives "This will delete all training data. Send /config reset --confirm to proceed."
  And no data is modified

Scenario: Concurrent training commands are serialized
  Given a tenant
  When two "/train add rule" commands arrive simultaneously
  Then both rules are added
  And the version is incremented twice (not once)
  And no data is lost

Scenario: SSRF prevention on MCP server registration
  Given a tenant
  When the user sends "/tool add https://evil.com/redirect-to-internal --name bad"
  And the URL redirects to http://169.254.169.254/latest/meta-data/
  Then the registration is rejected
  And the user receives "URL resolves to a private IP address. Registration blocked."
```

**Undefined Integration Contracts:**

1. **CommandParser <-> Messenger Bot:** The parser receives `rawText` but the syntax for section identifiers (e.g., `[domain-knowledge]`) is informally specified. What if the user writes `[Domain Knowledge]` (capitalized, with space)? Case sensitivity and normalization rules are absent.
2. **KnowledgeManager <-> Cloud.ru Managed RAG API:** The integration assumes a REST API for chunking and indexing but no OpenAPI contract or error response schema is specified.
3. **TrainingEngine <-> cli-runner.ts:** The ADR states "every training change takes effect on the very next message" but does not specify cache invalidation. If `cli-runner.ts` caches the CLAUDE.md content or the MCP config, stale state will be served.
4. **HookManager <-> Claude Code hooks:** The hook `handler` is a "shell command or script path" but the mechanism for injecting user-defined hooks into Claude Code's hook system is not specified. Does it write to `.claude/hooks.json`? Environment variables?

---

### 5. Pre-Implementation Tests

#### Unit Tests (write BEFORE implementation)

1. **`CommandParser.parse()` correctly parses `/train add rule: text` into `{ type: 'add_rule', rule: 'text', section: 'behavioral-rules' }`.** Verify default section is `'behavioral-rules'` when no section bracket is provided.

2. **`CommandParser.parse()` correctly parses `/train add rule [security-rules]: text` into `{ type: 'add_rule', rule: 'text', section: 'security-rules' }`.** Verify section extraction from bracket syntax.

3. **`CommandParser.parse()` returns `ParseError` for malformed input.** Input: `/train add`. Assert: `{ type: 'parse_error', message: ..., suggestion: 'Did you mean /train add rule: ...?' }`.

4. **`ClaudeMdManager.addRule()` rejects when section has 50 rules.** Pre-populate 50 rules, attempt to add the 51st. Assert: `{ success: false, message: 'Maximum 50 rules...' }`.

5. **`ClaudeMdManager.addRule()` increments version monotonically.** Add a rule, assert version is N+1. Rollback, assert version is N+2 (not N).

6. **`ClaudeMdManager.render()` produces valid markdown with version header.** Render a document with rules in multiple sections. Assert: output starts with `# CLAUDE.md`, contains `## Behavioral Rules`, and all rules appear as bullet points.

7. **`ClaudeMdManager.render()` sanitizes rule text containing markdown headings.** Add rule `## Fake Section\n- injected`. Assert rendered output does not contain a `## Fake Section` heading.

8. **`ToolRegistry.register()` rejects URLs resolving to private IP ranges.** Pass `http://10.0.0.1/mcp`. Assert rejection with SSRF error.

9. **`ToolRegistry.register()` rejects when tenant already has 10 MCP servers.** Pre-register 10 servers, attempt 11th. Assert rejection.

10. **`ConfigPorter.exportConfig()` strips auth tokens from MCP server configs.** Export a config with `auth: { type: 'bearer', token: 'secret123' }`. Assert exported JSON has `auth` redacted or nullified.

#### Integration Tests

1. **Full training lifecycle: add rule, verify CLAUDE.md on disk, remove rule, verify history.** Use a temporary directory. Execute `add_rule`, read the file, assert content. Execute `remove_rule`, read history directory, assert previous version exists.

2. **Knowledge upload to mock RAG endpoint.** Mock the Cloud.ru Managed RAG API. Upload a text file. Assert: (a) chunking request is sent, (b) `DocumentRef` is stored, (c) `KnowledgeUploaded` event is emitted, (d) CLAUDE.md is updated with RAG retrieval instruction.

3. **Import config with conflicts.** Create a tenant with existing rules. Import a bundle that has overlapping rules. Assert: (a) `ImportResult.conflicts` lists the overlaps, (b) `resolution: 'keep'` preserves existing, (c) `resolution: 'replace'` overwrites.

4. **Concurrent training commands do not lose data.** Send 10 `add_rule` commands in parallel for the same tenant. Assert: (a) all 10 rules are present, (b) version is original + 10, (c) no file corruption.

5. **MCP server health check integration.** Start a local HTTP server implementing basic MCP `tools/list`. Register it via `ToolRegistry`. Assert health check passes and tools are listed.

#### E2E Test Scenarios

1. **User trains bot via Telegram and observes changed behavior.** (a) User sends `/train add rule: Always respond in Russian`. (b) User sends "Hello". (c) Assert agent responds in Russian. (d) User sends `/train remove rule 1`. (e) User sends "Hello". (f) Assert agent responds in English (or default).

2. **User uploads a document and queries it.** (a) User sends `/knowledge add` with a text file about "company vacation policy." (b) User asks "What is the vacation policy?" (c) Assert agent response includes information from the uploaded document, demonstrating RAG retrieval.

---

### 6. Cross-ADR Integration Risks

| ADR Pair | Integration Risk | Contract Test Needed |
|----------|-----------------|---------------------|
| **ADR-011 + ADR-008** (Multi-Tenant Session Isolation) | ADR-008 defines `TenantId` as `"tg_{telegram_user_id}"` and workspace as `/var/openclaw/tenants/{tenantId}/workspace`. ADR-011 defines tenant workspace as `/data/tenants/{tenantId}/`. **Path disagreement.** Which is canonical? If both modules derive paths independently, files will be written to different directories. | Contract test: `TenantContext.claudeMdPath` resolves to the same path that `runCliAgent()` uses for `--cwd`. Assert paths match for 5 sample tenant IDs. |
| **ADR-011 + ADR-007** (Tools & MCP) | ADR-011 lets users register MCP servers via `/tool add`. ADR-007 defines a three-tier tool access model (Restricted/Standard/Full). Risk: a Restricted-tier user can register an MCP server via training commands, bypassing ADR-007's tier enforcement. | Contract test: a user with `AccessTier = 'restricted'` sends `/tool add https://...`. Assert the command is rejected with "Tool registration requires Standard or Full access." |
| **ADR-011 + ADR-013** (AI Fabric Agents) | ADR-011 defines `/agent create` for custom agents. ADR-013 defines `IAgentProvider` and `ExternalAgentRegistry` for Cloud.ru AI Fabric agents. Risk: two parallel agent registration systems with no unified registry. A user-created agent via ADR-011 and a Cloud.ru agent via ADR-013 could have the same name, causing routing conflicts. | Contract test: register an agent named "coder" via `/agent create` (ADR-011) and via AI Fabric (ADR-013). Assert a unique constraint violation or namespace separation. |
| **ADR-011 + ADR-010** (Streaming Pipeline) | ADR-011's training commands produce immediate text responses (not streamed). Risk: the streaming pipeline (ADR-010) is applied to ALL responses including training confirmations, causing unnecessary message editing for a simple "Rule added" response. | Contract test: execute a `/train add rule` command. Assert the response is delivered as a single batch message, not via the streaming pipeline. |
| **ADR-011 + ADR-006** (Messenger Adapters) | ADR-011 defines command syntax (`/train`, `/knowledge`, `/tool`, etc.) parsed from messenger text. ADR-006 defines `NormalizedMessage` as the platform-agnostic message format. Risk: attachment handling differs by platform (Telegram sends `document` objects; MAX sends `attachment` objects). The `CommandParser` must work with `NormalizedMessage`, not raw platform data. | Contract test: parse `/knowledge add <attachment>` from both a Telegram `NormalizedMessage` and a MAX `NormalizedMessage`. Assert both produce the same `TrainingCommand` with identical `Attachment` objects. |
| **ADR-011 + ADR-012** (Plugin Architecture) | ADR-012 defines `@openclaw/training-engine` as a Customer-Supplier module. Risk: the training engine depends on `@openclaw/core` for tenant resolution, `@claude-flow/cli` for AgentDB, and Cloud.ru RAG API. If any dependency changes its interface, the training engine breaks silently. | Contract test: define interface contracts for `@openclaw/core.resolveTenant()` and `@claude-flow/cli.memory.store()`. Run contract tests on every CI build to detect breaking changes. |

---

### 7. Defect Prevention Recommendations

**Architectural Patterns:**

1. **CQRS for Training Commands.** Separate the command (write) path from the query (read) path. Training mutations go through `TrainingEngine.execute()` which writes to disk and emits events. Queries (`list_rules`, `list_tools`, `show_config`) read from a cached in-memory projection. This prevents file I/O contention on reads and enables event-sourced audit logs.

2. **Optimistic Locking on CLAUDE.md.** Each `TrainingCommand` should carry the expected version. If the file version on disk does not match, the command fails with `"Concurrent modification detected. Please retry."` This prevents lost writes from concurrent commands (error scenario E1).

```typescript
interface VersionedCommand {
  command: TrainingCommand;
  expectedVersion: number; // Must match current CLAUDE.md version
}
```

3. **Command Sanitization Pipeline.** All rule text, hook commands, and MCP URLs should pass through a sanitization pipeline before storage:

```
raw input -> trim whitespace -> strip control characters ->
  validate max length -> escape markdown injection ->
  check URL allowlist (for URLs) -> check shell safety (for hooks)
```

4. **Repository Pattern for Filesystem.** Abstract filesystem operations behind a `TenantRepository` interface:

```typescript
interface TenantRepository {
  readClaudeMd(tenantId: string): Promise<string>;
  writeClaudeMd(tenantId: string, content: string, version: number): Promise<void>;
  readJson<T>(tenantId: string, filename: string): Promise<T>;
  writeJson<T>(tenantId: string, filename: string, data: T): Promise<void>;
}
```

This enables in-memory implementations for unit tests and filesystem implementations for integration tests.

5. **Saga Pattern for Multi-Step Commands.** Commands like `/knowledge add` involve multiple steps (download, validate, chunk, index, store ref, update CLAUDE.md). If step 5 fails, steps 1-4 must be rolled back. Implement this as a saga with compensating actions:

```
download -> validate -> chunk -> index -> storeRef -> updateClaudeMd
   |           |          |        |         |
   v           v          v        v         v
 (noop)    (noop)    (delete    (remove    (rollback
                      chunks)   from RAG)   version)
```

**Runtime Validations:**

1. **Validate `tenantId` format** at the system boundary (gateway). Reject any ID not matching `^[a-z]+_\d+$`. This prevents directory traversal (`../../etc/passwd`) and namespace injection.
2. **Validate CLAUDE.md size after render.** Before writing, check that `render(doc).length <= 32768`. Reject the command if adding a rule would exceed the limit.
3. **Validate MCP URLs against SSRF.** Resolve the hostname to an IP address. Reject if the IP falls in private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `127.0.0.0/8`). Also reject after following redirects.
4. **Validate hook handler strings.** Use an allowlist of safe commands (e.g., `npm test`, `npm run build`). Reject arbitrary shell commands unless the user has Full access tier (ADR-007).
5. **Rate limit training commands.** Enforce the 10 commands/minute limit per tenant at the `TrainingEngine.execute()` entry point, not at the gateway. This prevents bypasses via direct API access.
6. **Validate import bundle schema.** Use a JSON Schema or Zod schema to validate the `ExportBundle` structure before processing. Reject malformed bundles with specific error messages.
7. **Monitor CLAUDE.md file integrity.** On load, compute a SHA-256 hash and compare against the stored hash (ADR-008 defines `ClaudeMdHash`). If they differ, the file was modified externally -- log a warning and reconcile.

---
---

## Cross-Cutting Findings (Both ADRs)

### Shared Type Namespace Collision

Both ADRs define types that will coexist in the `@openclaw` namespace:
- ADR-010: `MessengerStreamAdapter`, `MessengerStreamConfig`
- ADR-011: `McpServerConfig`, `HookDefinition`, `AgentDefinition`
- ADR-006: `MessengerAdapter`, `NormalizedMessage`

There is no shared types package defined. ADR-012 mentions a bounded context map but does not define a `@openclaw/types` or `@openclaw/core-types` package. Recommendation: define a shared kernel package for cross-module types before implementation begins.

### Workspace Path Inconsistency

- ADR-008: `/var/openclaw/tenants/{tenantId}/workspace`
- ADR-011: `/data/tenants/{tenantId}/`

These are different paths. If ADR-010's streaming pipeline resolves the subprocess working directory from ADR-008's path, but ADR-011's training engine writes CLAUDE.md to ADR-011's path, Claude Code will not find the training data. This must be resolved before implementation.

### Missing Global Error Taxonomy

Neither ADR defines error codes that integrate with a system-wide error taxonomy. ADR-010 defines `StreamError.code` with 4 values. ADR-011 uses `TrainingResult.success: boolean` with a freeform `message`. For cross-module error handling (e.g., a streaming response that fails because CLAUDE.md is corrupted), a unified error hierarchy is needed.

### Observability Gaps

Both ADRs define domain events but neither specifies:
- How events are transported (in-process EventEmitter? Message queue? Shared bus?)
- Event schema versioning (what happens when a new field is added to `RuleAdded`?)
- Correlation IDs linking a user request to all events it generates across ADR-010 and ADR-011

---

## Summary Scores

| ADR | Testability Score | Critical Missing Error Scenarios | Missing Acceptance Criteria | Pre-Implementation Tests Identified |
|-----|:-----------------:|:-------------------------------:|:--------------------------:|:-----------------------------------:|
| ADR-010 (Streaming) | **72/100** | 10 | 7 BDD scenarios, 3 contracts | 10 unit, 5 integration, 2 E2E |
| ADR-011 (Training) | **65/100** | 12 | 10 BDD scenarios, 4 contracts | 10 unit, 5 integration, 2 E2E |

**Overall assessment:** Both ADRs have well-defined interfaces that enable mock-first testing. The primary risks are (1) missing runtime error handling for adapter/API failures, (2) state machine and invariant logic that exists only in prose, not in types, (3) cross-ADR path and type inconsistencies that will surface during integration, and (4) security validations (SSRF, shell injection, markdown injection) that are mentioned but not specified precisely enough to implement and test against.

**Recommended next step:** Resolve the workspace path inconsistency between ADR-008 and ADR-011 before writing any code. Then create a `@openclaw/core-types` shared kernel package with `TenantContext`, error taxonomy, and domain event infrastructure.
