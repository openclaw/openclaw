> **SUPERSEDED:** This document references ADR-006..013 which were deleted during the v2 ADR rewrite (commit e54143f). ADR-001..005 v2 now cover this scope. Retained for historical context only.

# Implementation Milestones: ADR-012 & ADR-013

## Current State

- **No source code exists.** The `/src` directory has not been created. All design is in ADR documents.
- ADR-012 defines 8 independent npm packages under `@openclaw/*` scope with typed interfaces, a DI container, plugin registry, and event bus.
- ADR-013 defines `IAgentProvider` polymorphism (Claude Code CLI, Cloud.ru Agent, Cloud.ru Agent System), `HybridOrchestrator`, `McpFederation`, and Cloud.ru RAG integration.
- Shift-left report identifies 24 missing error scenarios, 18 BDD acceptance criteria, and 28 pre-implementation unit tests across both ADRs.
- QCSD report establishes performance thresholds (DI resolution < 1ms, event dispatch < 0.5ms, provider selection < 5ms) and 38 consolidated test cases.
- **Critical gap:** ADR-012's `AgentFabric` interface and ADR-013's `IAgentProvider` interface overlap in the same package. Must be reconciled before implementation.
- **Critical gap:** Shared types (`TokenUsage`, `ToolCall`, `HealthStatus`) are referenced by multiple packages but have no home. Must be extracted to prevent cross-module coupling.

## Goal State

- All 8 `@openclaw/*` packages implemented as bounded contexts under `/src` with typed interfaces, zero required internal dependencies, and independent testability.
- Plugin system is THE core extensibility mechanism: framework-agnostic lifecycle (load/init/start/stop/unload), typed DI, event bus, capability declarations.
- AI Fabric integration is ONE plugin implementing `IAgentProvider` -- not hardcoded into core.
- `HybridOrchestrator` routes requests to any registered `IAgentProvider` by capability pattern with circuit breaker failover.
- `McpFederation` aggregates tools from Cloud.ru managed servers, marketplace servers, and custom servers.
- All shift-left mitigations applied: typed injection tokens, health check timeouts, shutdown error aggregation, AbortSignal cancellation, per-provider rate limiting.
- Test coverage >= 85% lines, >= 80% branches. Mutation score >= 65%.
- `npm run build` succeeds. `npm test` passes. `npm run lint` clean.

---

## Milestone 1: Shared Types Package (`@openclaw/types`)

- **Bounded Context**: Cross-Cutting / Shared Kernel
- **Files to create**:
  - `/src/types/src/index.ts` -- barrel export
  - `/src/types/src/health.ts` -- `HealthStatus`, `HealthCheckable` interface
  - `/src/types/src/tokens.ts` -- `TokenUsage`, `ToolCall`, `ToolDefinition`, `ToolCallResult`
  - `/src/types/src/messages.ts` -- `ChatMessage`, `ContentBlock` (shared by LLM router + agent fabric)
  - `/src/types/src/errors.ts` -- `OpenClawError` base class, `ProviderUnavailableError`, `CircuitBreakerOpenError`, `ToolNotFoundError`, `CredentialMissingError`, `DuplicatePluginError`, `CircularDependencyError`, `ScopeDisposedError`, `VersionMismatchError`
  - `/src/types/src/events.ts` -- `DomainEvent` discriminated union (all 12 from ADR-012 + 7 from ADR-013 + 4 missing: `plugin.registered`, `plugin.disposed`, `circuit_breaker.opened`, `circuit_breaker.closed`)
  - `/src/types/src/json-schema.ts` -- `JsonSchema` type alias
  - `/src/types/package.json`
  - `/src/types/tsconfig.json`
  - `/tests/types/health.test.ts`
  - `/tests/types/errors.test.ts`
- **Dependencies**: None. This package has zero dependencies -- it is pure TypeScript type definitions and lightweight value objects.
- **Acceptance criteria**:
  - All types compile without errors under `strict: true`.
  - `HealthStatus` is a discriminated union with `status` field supporting `healthy`, `degraded`, `unhealthy`.
  - `OpenClawError` base class has `code: string` and `recoverable: boolean` properties.
  - Error classes provide structured context (e.g., `ToolNotFoundError` includes `availableTools: string[]`).
  - `DomainEvent` union has exhaustive type checking -- `switch` on `type` field is complete.
  - Package exports are clean -- `import { TokenUsage, HealthStatus } from '@openclaw/types'` works.
  - Zero runtime dependencies in `package.json`.
- **Shift-left mitigations**:
  - SL-012-E3: Typed `DuplicatePluginError` (not generic `Error`) so callers can distinguish registration errors.
  - SL-012/013-CROSS: Shared types prevent implicit coupling between modules importing from each other.
  - SL-013-E1: `CredentialMissingError` includes `envVarName` for actionable error messages.
- **QCSD quality gates**:
  - Q-012-Maintainability: "Published interfaces in `types.ts` follow semver" -- this is the canonical types package.
  - All files < 500 lines.
- **Estimated complexity**: LOW

---

## Milestone 2: Plugin Core -- DI Container (`@openclaw/core` Part 1)

- **Bounded Context**: System Composition / Plugin Lifecycle
- **Files to create**:
  - `/src/core/src/index.ts` -- barrel export
  - `/src/core/src/injection-token.ts` -- `InjectionToken<T>` class (typed DI tokens replacing string tokens)
  - `/src/core/src/container.ts` -- `DependencyContainer` interface, `OpenClawContainer` implementation with `ServiceLifetime` enum, topological sort, cycle detection, scoped resolution
  - `/src/core/src/container-errors.ts` -- container-specific error handling (re-exports from `@openclaw/types`)
  - `/src/core/package.json`
  - `/src/core/tsconfig.json`
  - `/tests/core/injection-token.test.ts`
  - `/tests/core/container.test.ts` -- 12 unit tests per shift-left report section 5
  - `/tests/core/container-scoped.test.ts` -- scope lifecycle tests
  - `/tests/core/container-circular.test.ts` -- circular dependency detection tests
- **Dependencies**: `@openclaw/types` (peer dependency for `HealthStatus`, error types)
- **Acceptance criteria**:
  - `InjectionToken<T>` binds token identity to type identity at compile time: `container.get(LLM_ROUTER)` returns `LLMRouter` type without manual generic annotation.
  - `ServiceRegistration<T>` declares `dependsOn: InjectionToken<unknown>[]` for explicit dependency declaration (not lazy discovery).
  - `container.build()` runs topological sort and throws `CircularDependencyError` with cycle path string (e.g., "A -> B -> A") when circular dependencies exist.
  - `Singleton` lifetime: two `get()` calls return same instance.
  - `Transient` lifetime: two `get()` calls return different instances.
  - `Scoped` lifetime: same scope returns same instance; different scopes return different instances.
  - `container.dispose()` calls dispose on all singletons in reverse registration order. If one dispose throws, remaining disposals continue. `AggregateShutdownError` thrown with all collected errors.
  - `container.createScope()` after `container.dispose()` throws `ScopeDisposedError`.
  - Resolving a `Scoped` service from root container throws descriptive error (not undefined behavior).
  - `container.get()` for unregistered token throws with token description in error message.
  - Container resolution < 1ms for singletons (benchmark test).
  - Scoped container creation < 0.1ms (benchmark test).
- **Shift-left mitigations**:
  - SL-012-Gap1: Typed `InjectionToken<T>` replaces string-based tokens. No more `container.get<LLMRouter>("LlmRouter")` typo risk.
  - SL-012-Gap2: Explicit `dependsOn` in `ServiceRegistration` enables cycle detection at `register()` time, not lazy `build()` time.
  - SL-012-E4: `createScope()` after `dispose()` on parent throws `ScopeDisposedError`.
  - SL-012-E5: Shutdown with error aggregation pattern from shift-left recommendations.
  - SL-012-E9: Scoped service resolved outside scope throws descriptive error.
  - SL-012-E10: Track active scope count. Log warning when count exceeds configurable threshold (potential leak).
- **QCSD quality gates**:
  - Q-012-Functionality: "DI container resolves all 8 modules without error at startup" -- validated by composition test in Milestone 8.
  - Q-012-Functionality: "Circular dependency detected and rejected at build time."
  - Q-012-Performance: "Container resolution < 1ms for singleton services."
  - Q-012-Performance: "Scoped container creation < 0.1ms."
  - Q-012-Security: "Third-party plugins cannot access other plugin internals" -- only declared dependencies resolvable.
  - R012-05: DI resolution overhead benchmark.
  - R012-07: Plugin accessing undeclared dependency throws.
- **Estimated complexity**: HIGH

---

## Milestone 3: Plugin Core -- Registry, Event Bus, Lifecycle (`@openclaw/core` Part 2)

- **Bounded Context**: System Composition / Plugin Lifecycle
- **Files to create**:
  - `/src/core/src/registry.ts` -- `PluginRegistry` interface + implementation with typed `Plugin<T>` registration, health aggregation with timeout, `list()`, `unregister()`
  - `/src/core/src/plugin.ts` -- `Plugin<T>` interface, `PluginDescriptor`, `PluginMetadata`, plugin lifecycle hooks: `onLoad`, `onInit`, `onStart`, `onStop`, `onUnload`
  - `/src/core/src/event-bus.ts` -- `EventBus` interface + `InProcessEventBus` implementation with configurable handler execution mode (sequential for audit, concurrent for performance), handler error isolation, `off()` cleanup
  - `/src/core/src/lifecycle-manager.ts` -- `PluginLifecycleManager` orchestrating load -> init -> start -> stop -> unload sequence across all registered plugins with topological ordering
  - `/tests/core/registry.test.ts` -- 6 unit tests per shift-left report (register, duplicate, unregister, healthCheck with timeout, list)
  - `/tests/core/event-bus.test.ts` -- 4 unit tests (emit to all, handler error isolation, off unsubscribe, concurrent safe registration)
  - `/tests/core/lifecycle-manager.test.ts` -- lifecycle ordering tests, partial-start on failure, graceful shutdown
  - `/tests/core/plugin.test.ts` -- plugin validation (id format, semver version, dependency token existence)
- **Dependencies**: `@openclaw/types` (peer), Milestone 2 (`container.ts`)
- **Acceptance criteria**:
  - `PluginRegistry.register()` throws `DuplicatePluginError` on duplicate `id`.
  - `PluginRegistry.register()` validates: `id` matches `^@[a-z-]+\/[a-z-]+$`, `version` is valid semver, all dependency tokens exist in container.
  - `PluginRegistry.healthCheck()` wraps each plugin's `healthCheck()` in `Promise.race()` with configurable timeout (default 5s). Timed-out plugins report `{ status: 'unhealthy', reason: 'Health check timed out after 5000ms' }`.
  - `EventBus.emit()` delivers to all registered handlers. If handler A throws, handler B still receives the event. Error from A is logged (not swallowed silently, not rethrown).
  - `EventBus.on()` is safe for concurrent calls -- 100 concurrent `Promise.all()` registrations all succeed.
  - `EventBus.off()` removes handler. Subsequent emits do not invoke it.
  - Plugin lifecycle: `load` -> `init` (dependency resolution) -> `start` (begin accepting requests) -> `stop` (drain in-flight) -> `unload` (cleanup). This is the npm-like lifecycle.
  - `PluginLifecycleManager.startAll()`: starts plugins in topological dependency order. If plugin A depends on B, B starts before A.
  - `PluginLifecycleManager.stopAll()`: stops plugins in reverse topological order.
  - If one plugin's `start()` fails, already-started plugins continue running. System reports `degraded`.
  - Domain events `plugin.registered` and `plugin.disposed` emitted through event bus.
  - Event bus dispatch < 0.5ms with 10 handlers (benchmark test).
- **Shift-left mitigations**:
  - SL-012-E1: `Plugin.factory()` throwing during init is caught; other plugins not affected; system starts in degraded mode.
  - SL-012-E6: Unhandled events (no handlers) are silently dropped -- documented behavior.
  - SL-012-E7: EventBus handler exceptions caught per-handler; error logged with plugin id and event type.
  - SL-012-E8: Plugin version registered in `PluginDescriptor`; version range checks emit `VersionMismatchWarning` (not blocking).
  - SL-012-E12: Health check timeout via `Promise.race()`.
  - SL-012-Gap4: EventBus handler error semantics explicitly defined: concurrent execution, per-handler catch, errors logged.
  - SL-012-Gap5: Post-`build()` plugin registration supported through `PluginRegistry.register()` which adds to a separate dynamic registry (not the frozen container). Dynamic plugins use `Transient` or `Singleton` lifetime in a child scope.
- **QCSD quality gates**:
  - Q-012-Functionality: "Plugin registry health check aggregates all module statuses."
  - Q-012-Functionality: "Event bus delivers events to all registered handlers."
  - Q-012-Reliability: "Event bus handler failure does not crash emitter."
  - Q-012-Reliability: "Plugin unregistration cleans up resources."
  - Q-012-Performance: "Event bus dispatch < 0.5ms for synchronous emit."
  - R012-01: Interface stability via semver validation.
  - R012-04: Event bus audit -- handler registration logged.
  - R012-06: Plugin disposal deadlock prevention via timeout.
- **Estimated complexity**: HIGH

---

## Milestone 4: Agent Provider Interface & Claude Code CLI Provider

- **Bounded Context**: External Agent Integration (Agent Fabric domain)
- **Files to create**:
  - `/src/agent-fabric/src/index.ts` -- barrel export
  - `/src/agent-fabric/src/interfaces/agent-provider.ts` -- `IAgentProvider`, `AgentRequest`, `AgentResponse`, `AgentEvent`, `AgentCapability`, `AgentConstraints`, `AgentLocality`
  - `/src/agent-fabric/src/interfaces/agent-registry.ts` -- `IAgentProviderRegistry` interface (register, unregister, list, get by id)
  - `/src/agent-fabric/src/providers/claude-code-cli-provider.ts` -- `ClaudeCodeCliProvider implements IAgentProvider` wrapping CLI execution with session management
  - `/src/agent-fabric/src/registry/external-agent-registry.ts` -- `ExternalAgentRegistry` aggregate root with provider uniqueness invariant
  - `/src/agent-fabric/src/config/agent-fabric-config.ts` -- `AgentFabricConfig` type with `apiKeyEnvVar` (not raw `apiKey`)
  - `/src/agent-fabric/src/config/config-validator.ts` -- validates config at load time, enforces credential isolation invariant
  - `/src/agent-fabric/package.json`
  - `/src/agent-fabric/tsconfig.json`
  - `/tests/agent-fabric/providers/claude-code-cli-provider.test.ts` -- mock subprocess tests
  - `/tests/agent-fabric/registry/external-agent-registry.test.ts` -- uniqueness, list, health check delegation
  - `/tests/agent-fabric/config/config-validator.test.ts` -- missing credentials, invalid config rejection
- **Dependencies**: `@openclaw/types` (peer), `@openclaw/core` (peer, for plugin registration)
- **Acceptance criteria**:
  - `IAgentProvider` interface has 5 methods: `execute(request, signal?)`, `stream(request, signal?)`, `listCapabilities()`, `healthCheck()`, `dispose()`. All async methods accept optional `AbortSignal`.
  - `ClaudeCodeCliProvider` implements `IAgentProvider` with `type: 'local'`.
  - `ClaudeCodeCliProvider.execute()` spawns Claude Code CLI subprocess with `--output-format json`, `--session-id`, and environment variables from config. Returns parsed `AgentResponse`.
  - `ClaudeCodeCliProvider.stream()` wraps `execute()` with single `done` event (CLI does not support streaming per ADR-003).
  - `ClaudeCodeCliProvider.healthCheck()` verifies claude binary exists on PATH and proxy endpoint is reachable.
  - `ExternalAgentRegistry` enforces unique `providerId`. Duplicate registration throws `DuplicatePluginError`.
  - `AgentFabricConfig.cloudru.apiKeyEnvVar` replaces raw `apiKey` field. Constructor reads `process.env[config.apiKeyEnvVar]`. Missing env var throws `CredentialMissingError`.
  - Config validator rejects configs containing inline API key values (regex scan for key patterns).
  - `IAgentProvider` contract test suite: define a shared test that any provider implementation must pass (execute returns `AgentResponse` with required fields, healthCheck returns boolean, dispose does not throw). Run against `ClaudeCodeCliProvider`.
- **Shift-left mitigations**:
  - SL-013-Gap1: `AbortSignal` on all async methods for stream cancellation.
  - SL-013-Gap4: `apiKeyEnvVar` replaces `apiKey` -- credential isolation enforced by type system.
  - SL-013-Inv1: Provider identity uniqueness enforced by `ExternalAgentRegistry.register()`.
  - SL-013-Inv2: Credential isolation enforced at config load time with validation.
  - SL-013-E1: Missing/expired API key throws `CredentialMissingError` with env var name.
- **QCSD quality gates**:
  - Q-013-Functionality: "IAgentProvider polymorphism: ClaudeCodeCli passes contract test suite."
  - Q-013-Security: "API keys never stored in openclaw.json."
  - Q-013-Security: "CLOUDRU_AGENTS_API_KEY read from environment only."
  - Q-013-Maintainability: "Anti-corruption layer isolates Cloud.ru API changes."
  - Q-013-Maintainability: "Config schema validated at load time with descriptive errors."
  - R013-04: API key not present in config file or log output.
- **Estimated complexity**: MEDIUM

---

## Milestone 5: Circuit Breaker & Hybrid Orchestrator

- **Bounded Context**: External Agent Integration / Orchestration
- **Files to create**:
  - `/src/agent-fabric/src/orchestration/circuit-breaker.ts` -- `CircuitBreaker` with states (closed, open, half-open), `CircuitBreakerConfig` (failureThreshold, resetTimeoutMs, successThreshold, windowSizeMs, halfOpenMaxRequests)
  - `/src/agent-fabric/src/orchestration/rate-limiter.ts` -- `RateLimiter` per-provider with token bucket algorithm, `ProviderRateLimit` config
  - `/src/agent-fabric/src/orchestration/routing-rules.ts` -- `RoutingRule` matching with glob patterns, priority ordering, fallback chains
  - `/src/agent-fabric/src/orchestration/hybrid-orchestrator.ts` -- `HybridOrchestrator` composing multiple `IAgentProvider` with routing, circuit breakers, rate limiting, fan-out
  - `/tests/agent-fabric/orchestration/circuit-breaker.test.ts` -- 6 tests: open after N failures, half-open after timeout, close on success, count-based vs window-based, concurrent request handling
  - `/tests/agent-fabric/orchestration/rate-limiter.test.ts` -- token bucket tests, burst allowance, concurrent acquire
  - `/tests/agent-fabric/orchestration/routing-rules.test.ts` -- glob matching, priority, no-match fallback
  - `/tests/agent-fabric/orchestration/hybrid-orchestrator.test.ts` -- routing by capability, fallback on circuit break, default provider, fan-out parallel execution timing
- **Dependencies**: `@openclaw/types` (peer), Milestone 4 (`IAgentProvider`)
- **Acceptance criteria**:
  - `CircuitBreaker` implements 3 states: `closed` (normal), `open` (rejecting), `half-open` (probing).
  - Opens after `failureThreshold` consecutive failures (default 3).
  - Transitions to half-open after `resetTimeoutMs` (default 30000ms).
  - Closes after `successThreshold` successful requests in half-open state (default 1).
  - In half-open state, allows at most `halfOpenMaxRequests` concurrent probes.
  - Emits domain events: `circuit_breaker.opened`, `circuit_breaker.closed` through event bus.
  - `RateLimiter` enforces `maxRps` and `maxConcurrent` per provider. Excess requests queue (up to configurable depth) or reject.
  - `RoutingRule.capabilityPattern` uses `minimatch` glob matching (e.g., `code-*` matches `code-generation`, `code-review`).
  - `HybridOrchestrator.execute()` selection criteria in priority order: (1) explicit routing rule match, (2) circuit breaker state (skip open), (3) rate limit availability, (4) default provider.
  - `HybridOrchestrator.fanOut()` executes subtasks in parallel. Returns `Map<requestId, AgentResponse>`. Failed subtasks have their requestId absent from the map (not throwing). Timing: 3 tasks at 100ms each complete in ~100ms total.
  - Provider selection latency < 5ms (benchmark test).
  - Circuit breaker open time < 1s after threshold failures (integration test).
- **Shift-left mitigations**:
  - SL-013-Gap2: `HybridOrchestrator.selectProvider()` algorithm fully specified and tested.
  - SL-013-Gap5: `CircuitBreakerConfig` fully specified with all 5 fields and defaults.
  - SL-013-E2: Per-provider rate limiter prevents 429 from Cloud.ru (15 req/s per API key).
  - SL-013-E9: Race between selection and execution mitigated by retry with next fallback on circuit-break during execution.
  - SL-013-Inv4: Health Before Route -- orchestrator never routes to provider with open circuit breaker.
- **QCSD quality gates**:
  - Q-013-Functionality: "HybridOrchestrator routes by capability glob."
  - Q-013-Functionality: "Circuit breaker opens after 3 consecutive failures."
  - Q-013-Reliability: "Cloud.ru outage degrades to local-only execution."
  - Q-013-Reliability: "Rate limit 15 req/s enforced per Cloud.ru API key."
  - Q-013-Reliability: "Fan-out partial failures: successful sub-tasks returned."
  - Q-013-Performance: "Provider selection latency < 5ms."
  - R013-03: Rate limit under fan-out tested.
  - R013-06: Circuit breaker flapping tested (alternating success/failure).
- **Estimated complexity**: HIGH

---

## Milestone 6: Cloud.ru Agent Providers

- **Bounded Context**: External Agent Integration / Cloud.ru Anti-Corruption Layer
- **Files to create**:
  - `/src/agent-fabric/src/http/http-client.ts` -- typed HTTP client with retry (transient errors: 429, 502, 503, 504), timeout, AbortSignal support, header redaction in logs
  - `/src/agent-fabric/src/http/sse-parser.ts` -- SSE stream parser for Cloud.ru streaming responses
  - `/src/agent-fabric/src/providers/cloudru-agent-provider.ts` -- `CloudRuAgentProvider implements IAgentProvider` with `execute()`, `stream()` via SSE, `healthCheck()` (RUNNING/COOLED = healthy), cold-start timeout extension
  - `/src/agent-fabric/src/providers/cloudru-agent-system-provider.ts` -- `CloudRuAgentSystemProvider implements IAgentProvider` for multi-agent systems
  - `/src/agent-fabric/src/providers/cold-start-handler.ts` -- detects COOLED status and extends timeout, emits "agent warming up" metadata
  - `/tests/agent-fabric/providers/cloudru-agent-provider.test.ts` -- 7 unit tests per shift-left (execute mapping, healthCheck for RUNNING/COOLED/SUSPENDED, auth headers, response mapping)
  - `/tests/agent-fabric/providers/cloudru-agent-system-provider.test.ts` -- capabilities union, completions endpoint
  - `/tests/agent-fabric/http/http-client.test.ts` -- retry on transient errors, no retry on 400/401, timeout, AbortSignal
  - `/tests/agent-fabric/http/sse-parser.test.ts` -- parse valid SSE, handle malformed chunks, unknown event types logged and skipped
- **Dependencies**: `@openclaw/types` (peer), Milestone 4 (`IAgentProvider`, config)
- **Acceptance criteria**:
  - `CloudRuAgentProvider.execute()` sends POST to `/{projectId}/agents/{agentId}/completions` with OpenAI-compatible body. Maps response to `AgentResponse`.
  - `CloudRuAgentProvider.stream()` sends same request with `stream: true`. Parses SSE chunks into `AgentEvent` sequence. Unknown event types logged and skipped (not thrown).
  - `CloudRuAgentProvider.healthCheck()` returns `true` for `RUNNING` and `COOLED` status, `false` for all others.
  - Auth headers: `api_key` type -> `X-API-Key` header. `access_key` type -> `Authorization: Bearer` header.
  - Cold start: when last known status is `COOLED`, request timeout extended by 30s. Response metadata includes `coldStart: true`.
  - `CloudRuAgentSystemProvider` wraps Agent System completions endpoint. `listCapabilities()` returns union of member agent capabilities.
  - HTTP client retries transient errors (429, 502, 503, 504) with exponential backoff (1s, 2s, 4s). Does NOT retry 400, 401, 404.
  - HTTP client redacts `Authorization` and `X-API-Key` headers in all log output.
  - SSE parser handles incomplete chunks across TCP packet boundaries.
  - Contract test suite passes for both `CloudRuAgentProvider` and `CloudRuAgentSystemProvider`.
  - All 3 provider implementations pass the shared `IAgentProvider` contract test from Milestone 4.
- **Shift-left mitigations**:
  - SL-013-Gap6: Cold start handling with timeout extension and user notification.
  - SL-013-E1: 401 error -> `CredentialMissingError` with actionable message (key rotation needed).
  - SL-013-E2: 429 -> retry with backoff, queued by rate limiter from Milestone 5.
  - SL-013-E3: Status `FAILED`/`LLM_UNAVAILABLE` reported with specific reason in health status.
  - SL-013-E11: Unknown SSE event types logged and skipped, not thrown.
  - SL-013-Inv2: Auth headers never logged. Verified by test scanning log output.
- **QCSD quality gates**:
  - Q-013-Functionality: "IAgentProvider polymorphism: 3 implementations pass same test suite."
  - Q-013-Reliability: "Cold start handling within 30 seconds."
  - Q-013-Performance: "Streaming from Cloud.ru agent: TTFT < 5 seconds."
  - Q-013-Security: "Cloud.ru auth headers not logged at any log level."
  - Q-013-Maintainability: "Each provider independently testable with HTTP mocks."
  - R013-01: API version isolation via adapter.
  - R013-02: Cold start timeout extension.
- **Estimated complexity**: HIGH

---

## Milestone 7: MCP Federation & RAG Client

- **Bounded Context**: External Agent Integration / Tool Management
- **Files to create**:
  - `/src/agent-fabric/src/mcp/mcp-federation.ts` -- `McpFederation` with tool registry, namespaced collision resolution (deterministic: alphabetical by server name), `callTool()`, `listAllTools()`
  - `/src/agent-fabric/src/mcp/cloudru-mcp-discovery.ts` -- auto-discovery of Cloud.ru managed MCP servers via API, filtering by RUNNING/AVAILABLE status
  - `/src/agent-fabric/src/mcp/mcp-transport-adapter.ts` -- SSE and stdio MCP transport adapters implementing JSON-RPC 2.0 `tools/list` and `tools/call`
  - `/src/agent-fabric/src/mcp/mcp-url-validator.ts` -- URL blocklist validation (private IPs, localhost) for SSRF prevention
  - `/src/agent-fabric/src/rag/cloudru-rag-client.ts` -- `ICloudRuRagClient` implementation with KB listing, search, index status
  - `/tests/agent-fabric/mcp/mcp-federation.test.ts` -- tool indexing, collision resolution, callTool dispatch, ToolNotFoundError, unregister cleanup
  - `/tests/agent-fabric/mcp/cloudru-mcp-discovery.test.ts` -- discovery with mock API, filtering by status, handling 503 during discovery
  - `/tests/agent-fabric/mcp/mcp-transport-adapter.test.ts` -- JSON-RPC request/response, malformed response handling
  - `/tests/agent-fabric/mcp/mcp-url-validator.test.ts` -- private IP rejection, localhost rejection, valid URL acceptance
  - `/tests/agent-fabric/rag/cloudru-rag-client.test.ts` -- search, KB listing, index status polling
- **Dependencies**: `@openclaw/types` (peer), Milestone 4 (config), Milestone 6 (HTTP client)
- **Acceptance criteria**:
  - `McpFederation.registerCloudRuServers()` fetches servers from `GET /{projectId}/mcpServers`, filters by RUNNING/AVAILABLE, indexes all tools.
  - Tool name collision resolution is deterministic: alphabetically earlier server name wins unnamespaced slot. Namespaced variant (`server:tool`) always registered.
  - `McpFederation.callTool()` resolves tool name to server and dispatches JSON-RPC `tools/call`. Throws `ToolNotFoundError` with available tool names if tool not found.
  - `McpFederation.listAllTools()` returns all tools across all servers.
  - Unregistering a server removes all its tools from the index. Verified by `listAllTools()`.
  - MCP URL validator rejects: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0`, `localhost`. Accepts all other URLs.
  - `ICloudRuRagClient.searchKnowledgeBase()` returns ranked results with scores.
  - Auto-discovery handles Cloud.ru API returning 503: logs warning, boots with local providers only, retries in background.
  - MCP tool resolution < 1ms for indexed lookup (benchmark test).
  - 500 tools across 50 servers: resolution < 5ms (performance test per QCSD).
  - `McpServerDiscovered` event emitted for each discovered server.
- **Shift-left mitigations**:
  - SL-013-Gap3: Tool name collision resolution is deterministic (alphabetical), not first-registered-wins.
  - SL-013-E5: Server with zero tools: registered but logged as warning.
  - SL-013-E6: SSE connection drop during `callTool()`: timeout + retry.
  - SL-013-E7: Server-side validation error mapped to typed `McpToolCallError`.
  - SL-013-Inv5: MCP tool resolution to exactly one server. Ambiguous calls require namespaced form.
  - SL-013-E12: RAG KB with status `error`: `searchKnowledgeBase()` returns empty results with warning log, not silent.
  - SSRF prevention: URL blocklist per ADR-011 recommendation (R011-02).
- **QCSD quality gates**:
  - Q-013-Functionality: "McpFederation handles tool name collisions with namespacing."
  - Q-013-Functionality: "MCP auto-discovery populates tool index on startup."
  - Q-013-Performance: "MCP tool call round-trip < 2 seconds for managed servers."
  - Q-013-Security: "MCP server registration validates URL against blocklist."
  - R013-05: MCP server unavailability handled gracefully.
  - R013-08: Tool name collision deterministic resolution.
- **Estimated complexity**: HIGH

---

## Milestone 8: Agent Fabric Plugin Assembly & Composition Root

- **Bounded Context**: System Composition (wiring) + External Agent Integration (packaging)
- **Files to create**:
  - `/src/agent-fabric/src/plugin.ts` -- `AgentFabricPlugin` implementing `Plugin<AgentFabric>` interface from `@openclaw/core`. Wraps all Milestone 4-7 components. Exposes `AgentFabric` as the public API that delegates to `HybridOrchestrator` for `chat()`/`chatStream()`.
  - `/src/agent-fabric/src/agent-fabric.ts` -- `AgentFabric` implementation: `listAgents()` -> `ExternalAgentRegistry.list()`, `chat()` -> `HybridOrchestrator.execute()`, `chatStream()` -> `HybridOrchestrator` + provider `stream()`, `healthCheck()` -> aggregated provider health
  - `/src/agent-fabric/src/startup.ts` -- startup sequence: load config, init CLI provider, init Cloud.ru providers, auto-discover MCP, register RAG KBs, build orchestrator
  - `/src/core/src/composition-root.ts` -- `composeApplication()` function wiring all modules via DI container. Uses typed `InjectionToken` for all registrations. This is the ONLY file that imports concrete implementations.
  - `/src/core/src/tokens.ts` -- all `InjectionToken` instances exported as constants (e.g., `AGENT_FABRIC`, `EVENT_BUS`, `PLUGIN_REGISTRY`)
  - `/tests/agent-fabric/agent-fabric.test.ts` -- AgentFabric delegates to orchestrator, listAgents delegates to registry
  - `/tests/agent-fabric/plugin.test.ts` -- plugin lifecycle (load, init, start, stop, unload)
  - `/tests/agent-fabric/startup.test.ts` -- startup sequence with mock Cloud.ru API
  - `/tests/core/composition-root.test.ts` -- wires all 8 modules with mock implementations, all resolve, healthCheck aggregated
  - `/tests/core/integration/full-boot.test.ts` -- full boot with stub implementations of all 8 interfaces (E2E-style integration)
- **Dependencies**: All previous milestones
- **Acceptance criteria**:
  - `AgentFabric` is the PUBLIC API of the `@openclaw/agent-fabric` package. It provides management operations (`listAgents`, `createAgent`, etc.) AND request execution (`chat`, `chatStream`).
  - `IAgentProvider` is the INTERNAL SPI (Service Provider Interface) -- the extension point for new agent backends.
  - `AgentFabric.chat(agentId, message, threadId?)` delegates to `HybridOrchestrator.execute()` with appropriate `AgentRequest`.
  - `AgentFabric.chatStream()` returns `AsyncIterable<StreamChunk>` by piping through provider `stream()`.
  - Agent Fabric registers as a `Plugin<AgentFabric>` with the `PluginRegistry`. Its lifecycle:
    - `onLoad`: validate config
    - `onInit`: create providers, register with `ExternalAgentRegistry`
    - `onStart`: run health checks, auto-discover MCP, build orchestrator
    - `onStop`: drain in-flight requests
    - `onUnload`: dispose all providers
  - Composition root wires all 8 module tokens. All resolve correctly.
  - Health check aggregation: if agent-fabric is unhealthy, system reports `degraded` (not crashed).
  - Full boot integration test: compose application with stub implementations, send test request through `AgentFabric.chat()`, verify response flows end-to-end.
  - Lint rule or test: ONLY `composition-root.ts` imports concrete implementations. All other files import interfaces.
- **Shift-left mitigations**:
  - SL-012/013-CROSS: `AgentFabric` vs `IAgentProvider` duplication resolved: AgentFabric = public API, IAgentProvider = SPI.
  - SL-012-Gap3: Clarified PluginRegistry <-> DependencyContainer relationship: PluginRegistry manages plugin lifecycle, DependencyContainer manages service resolution. PluginRegistry calls `container.register()` internally.
  - SL-013-Inv3: Default provider required -- composition root validates `routing.defaultProvider` references a registered provider (falls back to `claude-cli`).
  - SL-012-BDD: "Application starts with all plugins healthy" scenario tested.
  - SL-012-BDD: "Application starts with one plugin failing health check" scenario tested (agent-fabric unhealthy -> system degraded).
- **QCSD quality gates**:
  - Q-012-Functionality: "DI container resolves all 8 modules without error at startup."
  - Q-012-Functionality: "Scoped containers provide tenant isolation."
  - Q-012-Reliability: "Module disposal executes in reverse dependency order."
  - Q-012-Security: "No shared mutable state between modules."
  - Q-012-Maintainability: "Each @openclaw/* package has zero required internal dependencies."
  - Q-012-Maintainability: "Package structure convention followed by all 8 modules."
  - TC-CROSS-007: Register 3 IAgentProvider implementations as plugins; orchestrator routes correctly.
  - TC-CROSS-009: Circuit breaker reset on provider re-registration.
- **Estimated complexity**: HIGH

---

## Milestone 9: Streaming Adapter Bridge (ADR-010 x ADR-013)

- **Bounded Context**: Cross-Cutting / Stream Pipeline Integration
- **Files to create**:
  - `/src/agent-fabric/src/streaming/agent-event-mapper.ts` -- `AgentEventToStreamEventMapper` converting `AgentEvent` (ADR-013) to `StreamEvent` (ADR-012's `@openclaw/stream-pipeline`). Maps: `content_delta` -> `text_delta`, `tool_call_start/result` -> `tool_use_start/end`, `usage` -> `metadata`, `done` -> `done`, `error` -> `error`.
  - `/src/agent-fabric/src/streaming/remote-stream-source.ts` -- `RemoteStreamSource implements StreamSource` wrapping any `IAgentProvider.stream()` output through the mapper. Produces `StreamEvent` sequence consumable by the existing pipeline.
  - `/tests/agent-fabric/streaming/agent-event-mapper.test.ts` -- 1:1 token fidelity for 10,000 tokens, all event type mappings covered, unknown event types yield null (skipped)
  - `/tests/agent-fabric/streaming/remote-stream-source.test.ts` -- integration with mock provider stream, backpressure handling, AbortSignal cancellation
- **Dependencies**: `@openclaw/types` (peer), Milestone 4 (`AgentEvent`), `@openclaw/stream-pipeline` types (peer)
- **Acceptance criteria**:
  - Every `AgentEvent` type maps to exactly one `StreamEvent` type (or is skipped with log).
  - 10,000 tokens streamed through mapper arrive with zero loss and zero duplication.
  - `RemoteStreamSource.read()` returns `AsyncIterable<StreamEvent>` compatible with `StreamPipeline.pipe()`.
  - `RemoteStreamSource.cancel()` propagates `AbortSignal` to the underlying provider stream.
  - Both local CLI provider (single `done` event) and remote Cloud.ru provider (incremental `content_delta` events) produce valid `StreamEvent` sequences through the mapper.
  - Typing indicator remains active during remote provider cold start (TTFT up to 5s).
  - Error mapping: Cloud.ru 503 -> `StreamEvent { type: 'error', code: 'PROVIDER_UNAVAILABLE', message: '...' }`.
- **Shift-left mitigations**:
  - TC-CROSS-010: AgentEvent-to-StreamEvent mapper preserves token fidelity.
  - TC-CROSS-011: End-to-end streaming from remote provider to messenger mock.
  - TC-CROSS-012: SSE connection drop mid-stream delivers accumulated tokens.
  - TC-CROSS-013: Typing indicator correct for both local and remote latency profiles.
- **QCSD quality gates**:
  - Cross-ADR 6.4: "Event format mismatch" risk mitigated.
  - Cross-ADR 6.4: "Latency differential" risk mitigated.
  - Cross-ADR 6.4: "Error semantics" normalized.
  - TC-028: Streaming pipeline works with both local and remote providers.
- **Estimated complexity**: MEDIUM

---

## Milestone 10: CI/CD, Quality Gates & Package Tooling

- **Bounded Context**: Cross-Cutting / Build Infrastructure
- **Files to create**:
  - `/src/tsconfig.base.json` -- shared TypeScript config with `strict: true`
  - `/src/tsconfig.json` -- project references for all packages
  - `/package.json` -- root workspace config (npm workspaces or Turborepo)
  - `/scripts/check-internal-deps.js` -- CI script validating zero required internal dependencies (all `@openclaw/*` imports match `peerDependencies`)
  - `/scripts/verify-no-hardcoded-keys.js` -- scans source for credential patterns
  - `/config/jest.config.ts` -- shared Jest config with coverage thresholds
  - `/config/stryker.config.json` -- mutation testing config targeting critical files
  - `/config/.eslintrc.json` -- lint rules including 500-line file limit
- **Dependencies**: All previous milestones (validates entire codebase)
- **Acceptance criteria**:
  - `npm run build` compiles all packages without errors.
  - `npm test` passes all unit + integration tests. Coverage >= 85% lines, >= 80% branches.
  - `npm run lint` returns zero errors. Files < 500 lines enforced.
  - `check-internal-deps.js`: all 8 packages pass zero-required-internal-deps check.
  - `npx madge --circular --extensions ts src/` returns zero circular dependencies.
  - `verify-no-hardcoded-keys.js`: no credential patterns in source files.
  - Mutation testing (Stryker) score >= 65% on critical files (container, circuit breaker, orchestrator, MCP federation, providers).
  - Package exports are clean: `import { ... } from '@openclaw/core'`, `import { ... } from '@openclaw/agent-fabric'`, `import { ... } from '@openclaw/types'` all work.
- **Shift-left mitigations**:
  - SL-012-Inv1: Module independence verified by CI script.
  - SL-012-Inv2: Interface stability enforced by semver lint.
  - SL-013-Inv2: Credential isolation verified by key scanning script.
  - Full shift-left CI/CD pipeline from report: dependency check, contract tests, unit tests, mutation tests, property tests, security scan.
- **QCSD quality gates**:
  - All Q-012-Maintainability criteria verified.
  - All R012-02 (circular deps) verified.
  - Mutation score threshold from QCSD: >= 65%.
  - Coverage thresholds from QCSD: >= 85% lines, >= 80% branches.
- **Estimated complexity**: MEDIUM

---

## Dependency Graph

```
Milestone 1: Shared Types (@openclaw/types)
    |
    +-- Milestone 2: DI Container (@openclaw/core Part 1)
    |       |
    |       +-- Milestone 3: Registry, Event Bus, Lifecycle (@openclaw/core Part 2)
    |               |
    |               +-- Milestone 8: Composition Root & Assembly
    |
    +-- Milestone 4: Agent Provider Interface & CLI Provider
    |       |
    |       +-- Milestone 5: Circuit Breaker & Orchestrator
    |       |       |
    |       |       +-- Milestone 8: Composition Root & Assembly
    |       |
    |       +-- Milestone 6: Cloud.ru Agent Providers
    |       |       |
    |       |       +-- Milestone 7: MCP Federation & RAG
    |       |       |       |
    |       |       |       +-- Milestone 8: Composition Root & Assembly
    |       |       |
    |       |       +-- Milestone 8: Composition Root & Assembly
    |       |
    |       +-- Milestone 9: Streaming Adapter Bridge
    |
    +-- Milestone 10: CI/CD & Quality Gates (depends on ALL milestones)
```

**Critical path**: 1 -> 2 -> 3 -> 8 -> 10 (Plugin infrastructure must be solid before wiring)

**Longest chain**: 1 -> 4 -> 6 -> 7 -> 8 -> 10 (6 milestones)

---

## Parallel Execution Opportunities

The following milestones can execute in parallel once their dependencies are met:

### Wave 1 (no dependencies)
- **Milestone 1**: Shared Types -- standalone, blocks everything else

### Wave 2 (after Milestone 1)
- **Milestone 2**: DI Container -- core infrastructure, independent of agent-fabric
- **Milestone 4**: Agent Provider Interface -- domain types, independent of core

### Wave 3 (after Wave 2)
- **Milestone 3**: Registry + Event Bus (after M2)
- **Milestone 5**: Circuit Breaker + Orchestrator (after M4)
- **Milestone 6**: Cloud.ru Providers (after M4)

### Wave 4 (after Wave 3)
- **Milestone 7**: MCP Federation + RAG (after M6)
- **Milestone 9**: Streaming Adapter Bridge (after M4, can start once `AgentEvent` types exist)

### Wave 5 (after Wave 4)
- **Milestone 8**: Composition Root & Assembly (after M3, M5, M6, M7)

### Wave 6 (after Wave 5)
- **Milestone 10**: CI/CD & Quality Gates (after all milestones)

**Maximum parallelism**: 3 concurrent milestones in Waves 2 and 3.

**Optimal timeline with 2-3 developers**: Waves 2-4 in parallel cut the 10-milestone sequence down to approximately 6 sequential work units.

---

## Risk Register

| Risk ID | Description | Probability | Impact | Affected Milestones | Mitigation |
|---------|-------------|:-----------:|:------:|:-------------------:|------------|
| R-IMPL-01 | Typed `InjectionToken<T>` adds complexity to DI container implementation beyond the simpler string-token approach | Medium | Medium | M2 | Start with string tokens internally, wrap in `InjectionToken<T>` facade. If TypeScript type inference proves insufficient, fall back to string tokens with a `TokenMap` type for compile-time checks. |
| R-IMPL-02 | Plugin lifecycle (load/init/start/stop/unload) is over-engineered for initial delivery; most plugins need only init and dispose | Medium | Low | M3 | Implement full lifecycle but make all hooks optional. Start with `onInit` and `onDispose` as the minimum viable lifecycle. Add other hooks as needed. |
| R-IMPL-03 | Cloud.ru AI Agents API documentation gaps (MCP server configuration, Agent System completions) delay provider implementation | High | Medium | M6, M7 | Build against mock API first. Use Pact contract tests to pin expected API behavior. Iterative discovery when real API access is available. |
| R-IMPL-04 | Circular dependency between `@openclaw/agent-fabric` and `@openclaw/stream-pipeline` (streaming adapter needs both) | Medium | High | M9 | The streaming adapter lives in `agent-fabric` and depends on stream-pipeline types via peer dependency. No circular dep -- agent-fabric depends on stream-pipeline (peer), not vice versa. Validated by CI `madge` check. |
| R-IMPL-05 | Performance thresholds (DI resolution < 1ms, event dispatch < 0.5ms) may not be achievable with full topological sort and health timeout wrapping | Low | Medium | M2, M3 | Topological sort runs once at `build()` time, not on every `get()`. Singletons are cached after first resolution. Benchmarks validate early in M2. |
| R-IMPL-06 | Post-build plugin registration (for dynamic agent addition via `/agent create`) conflicts with container freeze semantics | Medium | High | M3, M8 | Implement a `DynamicPluginRegistry` layer on top of the frozen container. Dynamic plugins get a child scope, not root container mutation. The frozen container is for startup-time modules; the dynamic registry is for runtime extensions. |
| R-IMPL-07 | Shared types package (`@openclaw/types`) becomes a "god package" accumulating unrelated types | Medium | Low | M1 | Keep types narrowly scoped to cross-module contracts only. Module-internal types stay in their own package's `types.ts`. Review M1 scope at each milestone. |
| R-IMPL-08 | `AgentFabric` public API duplicates `IAgentProvider` methods, confusing consumers | Medium | Medium | M8 | Document clearly: `AgentFabric` = management + execution API for consumers. `IAgentProvider` = SPI for plugin developers adding new backends. Different audiences, different interfaces. |
| R-IMPL-09 | MCP federation deterministic collision resolution (alphabetical) surprises users who expect registration-order semantics | Low | Low | M7 | Document the resolution strategy in JSDoc and README. Provide `listAllTools()` with server attribution so users can inspect which server owns the unnamespaced name. |
| R-IMPL-10 | Test infrastructure setup (Stryker, Pact, fast-check) delays Milestone 10 significantly | Medium | Low | M10 | Start test infrastructure in M1 (basic Jest setup). Add Stryker and Pact incrementally. Pact tests can run against the mock APIs already built in M6-M7. |

---

## Appendix: File Tree Summary

```
/src
  /types                          # @openclaw/types (Milestone 1)
    /src
      index.ts
      health.ts
      tokens.ts
      messages.ts
      errors.ts
      events.ts
      json-schema.ts
    package.json
    tsconfig.json

  /core                           # @openclaw/core (Milestones 2, 3, 8)
    /src
      index.ts
      injection-token.ts          # M2
      container.ts                # M2
      container-errors.ts         # M2
      registry.ts                 # M3
      plugin.ts                   # M3
      event-bus.ts                # M3
      lifecycle-manager.ts        # M3
      composition-root.ts         # M8
      tokens.ts                   # M8
    package.json
    tsconfig.json

  /agent-fabric                   # @openclaw/agent-fabric (Milestones 4-9)
    /src
      index.ts                    # M4
      agent-fabric.ts             # M8
      plugin.ts                   # M8
      startup.ts                  # M8
      /interfaces
        agent-provider.ts         # M4
        agent-registry.ts         # M4
        types.ts                  # M4
      /providers
        claude-code-cli-provider.ts      # M4
        cloudru-agent-provider.ts        # M6
        cloudru-agent-system-provider.ts # M6
        cold-start-handler.ts            # M6
      /orchestration
        circuit-breaker.ts        # M5
        rate-limiter.ts           # M5
        routing-rules.ts          # M5
        hybrid-orchestrator.ts    # M5
      /mcp
        mcp-federation.ts         # M7
        cloudru-mcp-discovery.ts  # M7
        mcp-transport-adapter.ts  # M7
        mcp-url-validator.ts      # M7
      /rag
        cloudru-rag-client.ts     # M7
      /config
        agent-fabric-config.ts    # M4
        config-validator.ts       # M4
      /registry
        external-agent-registry.ts # M4
      /streaming
        agent-event-mapper.ts     # M9
        remote-stream-source.ts   # M9
    package.json
    tsconfig.json

/tests
  /types
    health.test.ts                # M1
    errors.test.ts                # M1
  /core
    injection-token.test.ts       # M2
    container.test.ts             # M2
    container-scoped.test.ts      # M2
    container-circular.test.ts    # M2
    registry.test.ts              # M3
    event-bus.test.ts             # M3
    lifecycle-manager.test.ts     # M3
    plugin.test.ts                # M3
    composition-root.test.ts      # M8
    /integration
      full-boot.test.ts           # M8
  /agent-fabric
    agent-fabric.test.ts          # M8
    plugin.test.ts                # M8
    startup.test.ts               # M8
    /providers
      claude-code-cli-provider.test.ts      # M4
      cloudru-agent-provider.test.ts        # M6
      cloudru-agent-system-provider.test.ts # M6
    /orchestration
      circuit-breaker.test.ts     # M5
      rate-limiter.test.ts        # M5
      routing-rules.test.ts       # M5
      hybrid-orchestrator.test.ts # M5
    /mcp
      mcp-federation.test.ts      # M7
      cloudru-mcp-discovery.test.ts # M7
      mcp-transport-adapter.test.ts # M7
      mcp-url-validator.test.ts   # M7
    /rag
      cloudru-rag-client.test.ts  # M7
    /config
      config-validator.test.ts    # M4
    /registry
      external-agent-registry.test.ts # M4
    /streaming
      agent-event-mapper.test.ts  # M9
      remote-stream-source.test.ts # M9

/scripts
  check-internal-deps.js          # M10
  verify-no-hardcoded-keys.js     # M10

/config
  jest.config.ts                  # M10
  stryker.config.json             # M10
  .eslintrc.json                  # M10
```

**Total source files**: 33 (under `/src`)
**Total test files**: 31 (under `/tests`)
**Total milestones**: 10
**Estimated complexity distribution**: 1 LOW, 3 MEDIUM, 6 HIGH
