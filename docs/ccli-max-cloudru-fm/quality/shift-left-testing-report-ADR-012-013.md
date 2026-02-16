> **SUPERSEDED:** This document references ADR-006..013 which were deleted during the v2 ADR rewrite (commit e54143f). ADR-001..005 v2 now cover this scope. Retained for historical context only.

# Shift-Left Testing Analysis: ADR-012 & ADR-013 (Level 4 -- Risk Analysis in Design)

**Date:** 2026-02-13
**Analyst:** QA Specialist -- Shift-Left Testing
**Scope:** ADR-012 (Modular Plugin Architecture), ADR-013 (Cloud.ru AI Fabric Agent Integration)
**Method:** Level 4 shift-left testing -- identifying defects, missing error scenarios, and untestable designs before any code is written.

---

## ADR-012: Modular Plugin Architecture

**Bounded Context:** System Composition
**Aggregate:** PluginRegistry / DependencyContainer

---

### 1. Testability Assessment: Score 70/100

| Criterion | Score | Rationale |
|-----------|:-----:|-----------|
| Interface mockability | 19/20 | All eight module interfaces (`MessengerAdapter`, `LLMRouter`, `ToolSandbox`, `TenantManager`, `WorkerPool`, `StreamPipeline`, `TrainingEngine`, `AgentFabric`) are cleanly defined with typed methods. `PluginRegistry` and `DependencyContainer` are abstract interfaces. Excellent mockability. |
| Compile-time invariant enforcement | 9/20 | `ServiceLifetime` is a string enum (good). `Plugin<T>` is generic with typed factory. However, the `DependencyContainer.get<T>(token: string)` uses runtime string tokens -- type safety depends entirely on the caller passing the correct generic parameter. No compile-time guarantee that `get<LLMRouter>("LLMRouter")` returns an `LLMRouter`. |
| Acceptance criteria clarity | 11/20 | Module catalog and dependency graph are well-defined. However, no BDD scenarios, no performance requirements for container resolution, and no formal criteria for plugin lifecycle (what does "failed registration" look like to the caller?). |
| Error path coverage | 13/20 | Risks table identifies 6 risks with mitigations. However, specific error scenarios are missing: what happens when `Plugin.factory()` throws? What if `healthCheck()` times out? What if `dispose()` throws during shutdown? |
| Domain event testability | 18/20 | Twelve domain event types are defined in the `EventBus`. Clear `type` discriminants enable exhaustive testing via event spy patterns. |

**Key Testability Gaps:**

1. **String-based DI tokens lack type safety.** `container.get<T>(token: string)` requires the caller to match the string token to the correct generic type. A typo like `container.get<LLMRouter>("LlmRouter")` will throw at runtime, not compile time. There is no `InjectionToken<T>` abstraction that binds token identity to type identity at the type level.

2. **Circular dependency detection is runtime-only.** The ADR states "circular dependencies are detected and rejected" but provides no mechanism. The `build()` method presumably runs a topological sort, but this is undocumented. There is no typed graph structure or explicit edge declaration -- dependencies are discovered lazily when `factory(container)` calls `container.get()`.

3. **Plugin lifecycle hooks lack error contracts.** `Plugin.healthCheck()` returns `Promise<HealthStatus>` but what if it never resolves? There is no timeout specification. `Plugin.dispose()` returns `Promise<void>` but what if it rejects? The composition root's shutdown sequence may hang or throw.

4. **EventBus handler error semantics are undefined.** `EventBus.on()` registers async handlers, but the ADR does not specify: if a handler throws, does the event propagation stop? Are handlers executed sequentially or concurrently? Are errors swallowed, logged, or rethrown?

5. **`OpenClawContainer.build()` freeze semantics are vague.** The method "validates all dependencies and freezes the container." But `PluginRegistry.register()` allows runtime registration of third-party plugins. Can plugins be registered after `build()`? If yes, the container is not truly frozen. If no, dynamic plugin loading is impossible.

---

### 2. Missing Error Scenarios

| # | Scenario | Current Coverage | Risk |
|---|----------|:----------------:|:----:|
| E1 | `Plugin.factory()` throws during container initialization | Not addressed | HIGH -- one failing plugin could prevent the entire application from starting. No partial-start or degraded mode is defined. |
| E2 | Circular dependency between plugins at runtime (Plugin A's factory calls `container.get("B")`, Plugin B's factory calls `container.get("A")`) | "Detected and rejected" -- but detection mechanism is unspecified | HIGH -- if detection relies on `build()` which resolves lazily, circularity may not be caught until production request. |
| E3 | `PluginRegistry.register()` called with duplicate `id` | "Throws if id already registered" -- but no typed error | MEDIUM -- `Error` vs typed `DuplicatePluginError`. Callers cannot distinguish registration errors from other runtime errors. |
| E4 | `DependencyContainer.createScope()` called after `dispose()` on parent | Not addressed | MEDIUM -- creating a scope from a disposed container could reference stale singletons. |
| E5 | `Plugin.dispose()` throws during shutdown | Not addressed | HIGH -- if dispose of plugin A throws, plugins B-H may not be disposed, leaking resources (DB connections, open sockets). |
| E6 | `EventBus.emit()` with an event type that has no handlers | Not addressed | LOW -- but if event emission is expected to be fire-and-forget, callers need clarity that unhandled events are silently dropped. |
| E7 | `EventBus` handler throws an unhandled exception | Not addressed | HIGH -- async handler rejection in `.on()` callback could crash the process if not caught within the EventBus. |
| E8 | Module version skew: `@openclaw/core` expects `@openclaw/llm-router@2.x` but `1.x` is installed | Risks table mentions version skew | MEDIUM -- no runtime version validation. `PluginDescriptor.version` is available but never checked against required ranges. |
| E9 | `ServiceLifetime.Scoped` service resolved outside of a scope | Not addressed | MEDIUM -- `container.get("ScopedService")` on the root container has undefined behavior. Should it throw? Return a singleton? |
| E10 | Container memory leak from undisposed child scopes | Not addressed | MEDIUM -- per-request scopes that are not `dispose()`d accumulate scoped singletons. No automatic cleanup or scope timeout. |
| E11 | Hot reload of a plugin at runtime (unregister + re-register) while requests are in-flight | Not addressed | HIGH -- in-flight requests holding references to old plugin instances will use stale state. |
| E12 | `healthCheck()` aggregation timeout -- one plugin's health check hangs indefinitely | Not addressed | HIGH -- `PluginRegistry.healthCheck()` returns `Promise<Map<string, HealthStatus>>` but never resolves if one plugin is stuck. |

---

### 3. DDD Invariant Enforcement

**Invariant 1: Module Independence (Zero required internal dependencies)**

- **Enforcement:** "Every `@openclaw/*` package must have zero required internal dependencies."
- **Problem:** This is enforced by `package.json` peer dependencies, not by code. There is no build-time check that prevents `@openclaw/tool-sandbox` from `import {} from "@openclaw/tenant-manager"` as a hard dependency (without peer flag).
- **Recommendation:** CI check: `depcheck` or custom lint rule that scans `import` statements and verifies all `@openclaw/*` imports match declared `peerDependencies`, not `dependencies`.

```typescript
// Recommended CI check (pseudo-code)
for (const pkg of openclawPackages) {
  const imports = scanImports(pkg.srcDir);
  const internalImports = imports.filter(i => i.startsWith('@openclaw/'));
  const declared = Object.keys(pkg.peerDependencies ?? {});
  for (const imp of internalImports) {
    assert(declared.includes(imp), `${pkg.name} imports ${imp} but it is not a peerDependency`);
  }
}
```

**Invariant 2: Interface Stability**

- **Well-defined.** "Consumers depend on interfaces, never on concrete classes."
- **Gap:** The composition root (`composeApplication()`) imports concrete classes (`TelegramAdapter`, `DefaultLLMRouter`, etc.). This is correct for the composition root, but there is no lint rule preventing consumer code from importing concrete classes directly.
- **Test:** Write a lint rule or test that scans `@openclaw/core/composition-root.ts` and asserts it is the only file that imports concrete implementations.

**Invariant 3: Tenant Isolation via DI Scoped Lifetime**

- **Well-defined in principle.** `ServiceLifetime.Scoped` creates per-tenant instances.
- **Gap:** Who creates the scope? The ADR shows `container.createScope(scopeId)` but does not specify when this is called relative to request processing. If the scope is created per-request, who disposes it? Middleware? A try/finally block?
- **Test:** Create a scoped service that increments a counter on construction. Process two requests for different tenants. Assert each tenant gets its own counter instance (both start at 1, not one at 1 and one at 2).

**Invariant 4: No Shared Mutable State**

- **Enforcement:** "Modules communicate through the event bus or through interface method calls."
- **Gap:** The `EventBus` itself is shared mutable state (its handler registry). Multiple modules register handlers concurrently. If `EventBus.on()` is not thread-safe (or rather, not safe for concurrent async calls), handler registration during startup may lose registrations.
- **Test:** Register 100 handlers concurrently using `Promise.all()`. Assert all 100 are registered.

**Invariant 5: Health Propagation**

- **Gap:** The ADR states "every module implements `healthCheck()`" but three of the eight module interfaces (`LLMRouter`, `TenantManager`, `WorkerPool`) do not include `healthCheck()` in their interface definitions. Only `MessengerAdapter`, `LLMProviderAdapter`, and `AgentFabric` have it. The `Plugin<T>` wrapper adds an optional `healthCheck`, but consumers of the raw interface won't see it.
- **Recommendation:** Add `healthCheck(): Promise<HealthStatus>` to every module interface, not just to the `Plugin<T>` wrapper.

**Domain Events:**

All twelve event types are well-defined. They can be tested by subscribing to a mock `EventBus` and asserting emission patterns:
- `message.received` -> `llm.request` -> `llm.response` -> `message.sent` (happy path)
- `llm.request` -> `llm.error` (provider failure)
- `tenant.created` -> initial health check sequence

**Missing domain events:**
1. `plugin.registered` -- when a plugin is registered at runtime
2. `plugin.disposed` -- when a plugin is unregistered
3. `container.scope_created` / `container.scope_disposed` -- for scope lifecycle tracking
4. `healthCheck.completed` -- aggregated health check result

---

### 4. Missing Acceptance Criteria

**BDD Scenarios Needed:**

```gherkin
Scenario: Application starts with all plugins healthy
  Given all eight @openclaw packages are installed
  When composeApplication() is called with valid configuration
  Then all eight plugins are registered in the PluginRegistry
  And container.build() completes without error
  And healthCheck() returns all 8 plugins as "healthy"

Scenario: Application starts with one plugin failing health check
  Given the Cloud.ru AI Fabric endpoint is unreachable
  When composeApplication() is called
  Then 7 plugins register as "healthy"
  And @openclaw/agent-fabric registers as "unhealthy"
  And the system reports overall status as "degraded"
  And requests that require agent-fabric are rejected with a clear error

Scenario: Plugin factory throws during registration
  Given a third-party plugin with a factory that throws TypeError
  When PluginRegistry.register() is called
  Then the registration fails with a typed PluginRegistrationError
  And the error contains the plugin id, version, and cause
  And other plugins are not affected

Scenario: Circular dependency detected at build time
  Given Plugin A depends on Plugin B and Plugin B depends on Plugin A
  When container.build() is called
  Then a CircularDependencyError is thrown
  And the error message includes the dependency cycle path: "A -> B -> A"

Scenario: Scoped service provides per-tenant isolation
  Given TenantManager is registered with ServiceLifetime.Scoped
  When a request for tenant "tg_123" creates a child scope
  And a request for tenant "tg_456" creates a different child scope
  Then each scope resolves a different TenantManager instance
  And modifications in one scope do not affect the other

Scenario: Graceful shutdown disposes all plugins in reverse order
  Given the application is running with 8 registered plugins
  When container.dispose() is called
  Then plugins are disposed in reverse registration order
  And each plugin's dispose() method is called
  And if one dispose() throws, remaining plugins are still disposed
  And the error is logged but does not prevent shutdown

Scenario: Third-party plugin registers at runtime
  Given the application has been built and is running
  When a third-party plugin calls PluginRegistry.register()
  Then the plugin is available via PluginRegistry.resolve()
  And the plugin's healthCheck is included in subsequent health aggregation

Scenario: Event bus delivers events to all handlers
  Given handler A and handler B both subscribe to "llm.response"
  When an "llm.response" event is emitted
  Then both handlers receive the event
  And if handler A throws, handler B still receives the event
  And the error from handler A is logged

Scenario: Module version compatibility check
  Given @openclaw/core requires @openclaw/llm-router >= 2.0.0
  When @openclaw/llm-router@1.5.0 is registered
  Then a VersionMismatchWarning is logged
  And the plugin is registered but marked as "version_mismatch"
```

**Undefined Integration Contracts:**

1. **PluginRegistry <-> DependencyContainer:** Both manage module instances but their relationship is unclear. Does `PluginRegistry.register()` call `DependencyContainer.register()` internally? Or are they parallel systems?
2. **EventBus delivery guarantees:** At-most-once? At-least-once? Exactly-once? For in-process events, at-most-once (fire-and-forget) is typical, but the ADR does not specify.
3. **Plugin lifecycle ordering:** Is there a defined order for `factory()` invocation relative to `build()`? Are all factories called during `build()`, or lazily on first `get()`?
4. **Scope disposal and event bus:** When a child scope is disposed, do event handlers registered by scoped services get unsubscribed? If not, disposed services may receive events and access stale state.

---

### 5. Pre-Implementation Tests

#### Unit Tests (write BEFORE implementation)

1. **`PluginRegistry.register()` stores plugin and it is retrievable via `resolve()`.** Register a plugin with id `"test-plugin"`. Assert `resolve("test-plugin")` returns the factory result.

2. **`PluginRegistry.register()` throws on duplicate id.** Register plugin `"test"`, attempt to register another with same id. Assert a `DuplicatePluginError` is thrown.

3. **`PluginRegistry.unregister()` removes plugin.** Register, then unregister. Assert `has("test")` returns `false` and `resolve("test")` throws.

4. **`PluginRegistry.healthCheck()` aggregates all plugin health statuses.** Register 3 plugins: one healthy, one degraded, one unhealthy. Assert the returned `Map` has 3 entries with correct statuses.

5. **`PluginRegistry.healthCheck()` times out stuck plugins.** Register a plugin whose `healthCheck()` never resolves. Assert that after a timeout (e.g., 5s), the plugin is reported as `{ status: 'unhealthy', reason: 'Health check timed out' }`.

6. **`OpenClawContainer.get()` resolves singleton lifetime correctly.** Register a service as `Singleton` with a factory that returns `new Counter()`. Call `get()` twice. Assert both calls return the same instance.

7. **`OpenClawContainer.get()` resolves transient lifetime correctly.** Register a service as `Transient`. Call `get()` twice. Assert different instances.

8. **`OpenClawContainer.createScope()` resolves scoped lifetime correctly.** Register a service as `Scoped`. Create two child scopes. Assert each scope returns a different instance, but repeated `get()` within the same scope returns the same instance.

9. **`OpenClawContainer.build()` detects circular dependencies.** Register A depending on B, B depending on A. Call `build()`. Assert `CircularDependencyError` is thrown with cycle description.

10. **`OpenClawContainer.dispose()` calls dispose on all singletons.** Register 3 singletons with mock `dispose` functions. Call `container.dispose()`. Assert all 3 mocks were called.

11. **`EventBus.emit()` delivers to all registered handlers.** Register two handlers for `"llm.response"`. Emit event. Assert both handlers received the event.

12. **`EventBus.on()` handler failure does not prevent other handlers from executing.** Register handler A (throws), handler B (succeeds). Emit event. Assert handler B received the event.

#### Integration Tests

1. **Full composition: wire all 8 modules with mock implementations.** Create mock implementations of all 8 interfaces. Call `composeApplication()`. Assert all 8 are resolvable from the container and healthCheck returns all healthy.

2. **Standalone usage: `@openclaw/messenger-adapters` without other modules.** Import `MaxAdapter` directly. Call `onMessage()`, `send()`. Assert no errors related to missing dependencies.

3. **Standalone usage: `@openclaw/llm-router` without other modules.** Create `DefaultLLMRouter` with a mock provider. Call `complete()`. Assert response is received.

4. **Plugin hot-reload: unregister + re-register.** Register plugin v1, resolve it, unregister, register plugin v2, resolve. Assert v2 is returned. Assert in-flight requests on v1 complete normally.

5. **Scope lifecycle: create, use, dispose, attempt use after disposal.** Create a scope, resolve a scoped service, dispose the scope, attempt to resolve from disposed scope. Assert a `ScopeDisposedError` is thrown.

#### E2E Test Scenarios

1. **Full system boot with all real modules.** Start the OpenClaw application with real (but test-configured) module implementations. Assert the health endpoint returns all modules healthy. Send a test message through a Telegram adapter mock and verify end-to-end flow.

2. **Module failure isolation.** Start the system, then kill the Cloud.ru AI Fabric mock endpoint. Assert the system continues to serve requests via Claude Code CLI provider. Assert the health endpoint reports `agent-fabric` as unhealthy and overall status as degraded.

---

### 6. Cross-ADR Integration Risks

| ADR Pair | Integration Risk | Contract Test Needed |
|----------|-----------------|---------------------|
| **ADR-012 + ADR-006** (Messenger Adapters) | ADR-006 defines `MessengerAdapter` as the primary adapter interface. ADR-012 creates `@openclaw/messenger-adapters` package containing `TelegramAdapter`, `MaxAdapter`, `WebAdapter`. Risk: if ADR-006's `MessengerAdapter` interface evolves independently of ADR-012's package, the two diverge. | Contract test: assert that every class in `@openclaw/messenger-adapters` implements the `MessengerAdapter` interface from ADR-006. Run this on every CI build. |
| **ADR-012 + ADR-008** (Multi-Tenant) | ADR-012's `DependencyContainer.createScope(scopeId)` is the mechanism for tenant isolation per ADR-008. Risk: `scopeId` must equal `tenantId`, but nothing enforces this. A developer could pass `requestId` instead of `tenantId`, creating per-request scopes that share tenant state. | Contract test: all middleware that creates scopes uses `TenantContext.tenantId` as the `scopeId`. No other pattern is allowed. |
| **ADR-012 + ADR-010** (Streaming Pipeline) | ADR-012 declares `@openclaw/stream-pipeline` as a Shared Kernel with the core. ADR-010's `StreamJsonEvent` types must be importable from the pipeline package. Risk: if types are defined inside the package but not re-exported from `@openclaw/core`, consumers import directly from the pipeline, creating hidden coupling. | Contract test: verify `StreamJsonEvent` is exported from `@openclaw/core/types`. Assert no consumer code imports directly from `@openclaw/stream-pipeline/types`. |
| **ADR-012 + ADR-013** (AI Fabric Agent Integration) | ADR-012 defines `@openclaw/agent-fabric` as a module with the `AgentFabric` interface. ADR-013 defines `IAgentProvider` in the same package but with a different shape (`execute()` + `stream()` vs ADR-012's `chat()` + `chatStream()`). Risk: two competing interfaces for agent interaction in the same package. | Contract test: assert that `AgentFabric` (ADR-012) is an alias or wrapper around `IAgentProvider` (ADR-013). One interface must be canonical. |
| **ADR-012 + ADR-005** (Model Routing & Fallback) | ADR-012's `@openclaw/llm-router` implements ADR-005's model mapping and fallback strategy. Risk: routing config in ADR-012 (`RoutingConfig.aliases`, `fallbacks`) may conflict with ADR-005's model mapping table if both are loaded. | Contract test: given the ADR-005 model mapping and the ADR-012 routing config, assert that `router.resolveModel("fast")` returns the correct provider and model ID per ADR-005's table. |
| **ADR-012 + ADR-011** (Training Engine) | ADR-012 declares `@openclaw/training-engine` as a Customer-Supplier module. ADR-011 defines `TrainingEngine` with `execute(command)` method. Risk: the training engine's dependency on `TenantManager` is declared as optional (`peerDependency`), but ADR-011's implementation requires tenant context for every operation. Without `TenantManager`, the training engine cannot function. | Contract test: instantiate `TrainingEngine` without `TenantManager`. Assert it throws a clear `MissingDependencyError` rather than a null reference. |

---

### 7. Defect Prevention Recommendations

**Architectural Patterns:**

1. **Typed Injection Tokens.** Replace string-based DI tokens with typed token objects:

```typescript
class InjectionToken<T> {
  constructor(readonly description: string) {}
}

const LLM_ROUTER = new InjectionToken<LLMRouter>('LLMRouter');
const TENANT_MANAGER = new InjectionToken<TenantManager>('TenantManager');

// Usage: container.get(LLM_ROUTER) returns LLMRouter (type-safe)
interface TypedContainer {
  get<T>(token: InjectionToken<T>): T;
  set<T>(token: InjectionToken<T>, value: T): void;
}
```

2. **Topological Sort with Early Validation.** Implement dependency validation at `register()` time, not at `build()` time. Each `ServiceRegistration` should declare its dependency tokens explicitly (not discovered lazily via factory execution):

```typescript
interface ServiceRegistration<T> {
  token: InjectionToken<T>;
  factory: (container: DependencyContainer) => T;
  lifetime: ServiceLifetime;
  dependsOn: InjectionToken<unknown>[]; // explicit declaration
}
```

3. **Health Check Timeout.** Wrap all `healthCheck()` calls in `Promise.race()` with a configurable timeout:

```typescript
async function timedHealthCheck(
  plugin: Plugin<unknown>,
  timeoutMs: number = 5000
): Promise<HealthStatus> {
  return Promise.race([
    plugin.healthCheck?.() ?? { status: 'healthy' },
    new Promise<HealthStatus>((resolve) =>
      setTimeout(() => resolve({ status: 'unhealthy', reason: 'Timed out' }), timeoutMs)
    ),
  ]);
}
```

4. **Shutdown with Error Aggregation.** During `dispose()`, catch errors from individual plugins and continue disposing the rest. Aggregate all errors into a single `AggregateShutdownError`:

```typescript
async function disposeAll(plugins: Plugin<unknown>[]): Promise<void> {
  const errors: Array<{ pluginId: string; error: Error }> = [];
  for (const plugin of plugins.reverse()) {
    try { await plugin.dispose?.(); }
    catch (e) { errors.push({ pluginId: plugin.id, error: e as Error }); }
  }
  if (errors.length > 0) {
    throw new AggregateShutdownError(errors);
  }
}
```

**Runtime Validations:**

1. **Validate plugin `id` format** at registration: `^@openclaw\/[a-z-]+$` for official plugins, `^@[a-z-]+\/[a-z-]+$` for third-party. Reject ids that don't match.
2. **Validate `version` is valid SemVer** at registration. Use `semver.valid()`.
3. **Validate dependency tokens exist** at `build()` time. For each registration, assert all `dependsOn` tokens are registered.
4. **Validate no duplicate event handlers** for the same function reference. Prevent double-registration bugs.
5. **Monitor scope count.** Track the number of active child scopes. Alert if it exceeds a threshold (potential memory leak from undisposed scopes).
6. **Log plugin lifecycle events.** Every `register()`, `resolve()`, `healthCheck()`, `dispose()` call should emit structured log entries with correlation IDs.

---
---

## ADR-013: Cloud.ru AI Fabric Agent Integration

**Bounded Context:** External Agent Integration
**Aggregate:** ExternalAgentRegistry

---

### 1. Testability Assessment: Score 68/100

| Criterion | Score | Rationale |
|-----------|:-----:|-----------|
| Interface mockability | 19/20 | `IAgentProvider` is a clean interface with 5 methods. `HybridOrchestrator`, `McpFederation`, `ICloudRuRagClient` are all mockable. `CircuitBreaker` is a separate class. Strong separation of concerns. |
| Compile-time invariant enforcement | 8/20 | `AgentLocality` and `CloudRuAgentStatus` are string literal unions (good). But `AgentCapability.inputSchema` and `outputSchema` are typed as `JsonSchema` (opaque). `AgentRequest.constraints` uses optional fields -- there's no way to enforce at compile time that `timeoutMs` must be positive. `AgentEvent` discriminated union is well-typed. |
| Acceptance criteria clarity | 11/20 | The startup sequence is well-documented as a numbered tree. But no BDD scenarios, no latency requirements (what is acceptable cold start handling?), no SLA for circuit breaker recovery time. The routing rule `capabilityPattern` is described as "glob" but no glob library is specified. |
| Error path coverage | 12/20 | Circuit breaker pattern is specified. Risks table has 6 entries. But specific HTTP error handling is missing: what does `CloudRuAgentProvider` do on 401 (expired key)? 429 (rate limit)? 500 (server error)? |
| Domain event testability | 18/20 | Seven domain events are defined with clear triggers. `AgentProviderRegistered`, `AgentProviderHealthDegraded`, `McpServerDiscovered` etc. are testable via event spy patterns. |

**Key Testability Gaps:**

1. **`IAgentProvider.stream()` has no cancellation mechanism.** The method returns `AsyncIterable<AgentEvent>` but there is no way for the caller to cancel a stream in progress. If the user disconnects, the Cloud.ru API call continues consuming resources. An `AbortSignal` parameter or `cancel()` method is needed.

2. **`HybridOrchestrator.selectProvider()` routing logic is undocumented.** The selection criteria are listed as comments ("Explicit routing rule", "Provider health", "Locality preference", "Default provider") but the algorithm is not specified. How does "locality preference" work? What is the tie-breaking logic when two providers match the same capability pattern?

3. **`McpFederation` tool name collision resolution is fragile.** The strategy is "prefer unnamespaced if no collision, always register namespaced." But the order of server registration determines which server "wins" the unnamespaced name. If server A is registered before server B, and both have a tool named `search`, server A gets the unnamespaced `search`. But if registration order changes (e.g., server A is slower to health-check), server B wins. This is non-deterministic.

4. **`CloudRuAgentConfig.apiKey` is in the constructor config.** The ADR correctly states "API keys are read from env vars only, never stored in openclaw.json." But the `CloudRuAgentConfig` interface has `readonly apiKey: string`, and the code shows it being passed to the constructor. The invariant is enforced by documentation, not by the type system. Nothing prevents a developer from passing a literal string.

5. **`CircuitBreaker` is not fully specified.** The ADR mentions "3 consecutive failures" to open the breaker but doesn't specify: half-open state behavior, success threshold to close, sliding window vs count-based, timeout for half-open probe. These details are critical for testing.

6. **Cold start handling is unspecified.** Cloud.ru agents with `minInstances=0` have 10-30s cold start. The ADR notes this in consequences but provides no mechanism: no warm-up request, no first-request timeout extension, no user notification ("Agent is waking up...").

---

### 2. Missing Error Scenarios

| # | Scenario | Current Coverage | Risk |
|---|----------|:----------------:|:----:|
| E1 | Cloud.ru API returns 401 Unauthorized (expired or rotated API key) | Not addressed | CRITICAL -- all Cloud.ru providers become unusable until key is refreshed. No automatic key rotation or renewal mechanism. |
| E2 | Cloud.ru API returns 429 Too Many Requests | Rate limits mentioned in risks | HIGH -- 15 req/s per API key. Agent Systems with 5 concurrent sub-tasks could exhaust this in 3 seconds. No per-provider rate limiter in the orchestrator. |
| E3 | Cloud.ru agent status is `FAILED` or `LLM_UNAVAILABLE` during health check | Health check only checks for `RUNNING` or `COOLED` | MEDIUM -- provider is marked unhealthy but error reason is generic. Status `LLM_UNAVAILABLE` means the underlying FM model is down, which should trigger fallback to a different model, not just a different provider. |
| E4 | `HybridOrchestrator.fanOut()` with one subtask that times out while others succeed | `Promise.allSettled()` handles this | MEDIUM -- the caller gets partial results. But there is no specification for: should the orchestrator retry the timed-out subtask? Return partial? Wait indefinitely? |
| E5 | MCP server auto-discovery returns a server with zero tools | Not addressed | LOW -- a server with no tools is useless but not harmful. However, it clutters the tool index and confuses users. |
| E6 | MCP SSE connection drops during `callTool()` execution | Not addressed | HIGH -- the tool call is in-flight, partial result. No retry or timeout. The async MCP JSON-RPC call hangs. |
| E7 | `McpFederation.callTool()` with arguments that fail server-side validation | Not addressed | MEDIUM -- Cloud.ru MCP server returns a JSON-RPC error. The error format and mapping to OpenClaw error types is unspecified. |
| E8 | Cloud.ru Agent System's planner/router decomposes a task into sub-tasks that exceed the system's 5-agent limit | Not addressed | LOW -- this is a Cloud.ru platform limitation. OpenClaw cannot control internal agent system behavior, but should handle the resulting error gracefully. |
| E9 | `HybridOrchestrator.execute()` selects a provider, but the provider becomes unhealthy between selection and execution | Race condition | MEDIUM -- the circuit breaker may not have opened yet. First request to a degraded provider will fail. The orchestrator should retry with a fallback provider. |
| E10 | Network partition: Cloud.ru API is reachable from health check but unreachable from the actual request path (asymmetric failure) | Not addressed | LOW -- health check gives false positive. The circuit breaker eventually opens after request failures, but first few requests fail. |
| E11 | `CloudRuAgentProvider.stream()` SSE response includes events with unknown `type` field | Not addressed | LOW -- the `mapChunkToEvent()` function may throw on unexpected event types. Should be logged and skipped. |
| E12 | Cloud.ru RAG knowledge base index status is `error` | `getIndexStatus()` returns it but no handling specified | MEDIUM -- queries against an errored KB return empty results silently. User expects documents but gets nothing. |

---

### 3. DDD Invariant Enforcement

**Invariant 1: Provider Identity Uniqueness**

- **Enforcement:** "Enforced by `ExternalAgentRegistry.register()`."
- **Format:** `providerId = "cloudru:{projectId}:{agentId}"` for single agents, `"cloudru-system:{projectId}:{agentSystemId}"` for systems.
- **Problem:** The uniqueness constraint is per-process, not persistent. If OpenClaw restarts with a different config that reuses an ID for a different agent, there is no conflict detection.
- **Test:** Register provider `"cloudru:proj1:agent1"`. Attempt to register a second provider with the same ID but different `baseUrl`. Assert rejection with `DuplicateProviderError`.

**Invariant 2: Credential Isolation**

- **Enforcement:** "API keys are always read from environment variables."
- **Problem:** The `CloudRuAgentConfig` interface accepts `apiKey: string` directly. A developer could pass `config.cloudru.apiKey = "sk-..."` from a JSON file. The invariant is unenforceable at the type level.
- **Recommendation:** Remove `apiKey` from the config interface. Replace with `apiKeyEnvVar: string` that specifies which environment variable to read:

```typescript
interface CloudRuAgentConfig {
  readonly projectId: string;
  readonly baseUrl: string;
  readonly apiKeyEnvVar: string;  // e.g., "CLOUDRU_AGENTS_API_KEY"
  readonly authType: 'api_key' | 'access_key';
}
// Constructor reads: process.env[config.apiKeyEnvVar]
```

- **Test:** Attempt to construct `CloudRuAgentProvider` with `apiKeyEnvVar: "NONEXISTENT_VAR"`. Assert it throws `MissingCredentialError` with the var name.

**Invariant 3: Default Provider Required**

- **Well-defined.** "If `routing.defaultProvider` is absent, OpenClaw falls back to `claude-cli`."
- **Test:** Create `HybridOrchestrator` without a `defaultProvider` field. Execute a request with no matching routing rule. Assert the request goes to `claude-cli` provider.

**Invariant 4: Health Before Route**

- **Well-defined.** "The orchestrator never routes to a provider whose circuit breaker is open."
- **Gap:** The circuit breaker opens after 3 consecutive failures, but what about the first 3 requests that hit a dead provider before the breaker opens? The user experiences 3 failures before fallback kicks in.
- **Test:** Set up provider A (dead) and provider B (healthy) with routing preferring A. Send 4 requests. Assert: requests 1-3 fail with provider A, request 4 succeeds with provider B (circuit breaker opened). Consider reducing threshold to 1 for critical paths.

**Invariant 5: MCP Tool Resolution**

- **Well-defined.** "A tool call must resolve to exactly one MCP server."
- **Gap:** The collision resolution strategy (first-registered wins) is non-deterministic across restarts if server registration order depends on network latency of health checks.
- **Test:** Register server A with tool `search`, then server B with tool `search`. Assert: `callTool("search")` goes to server A, `callTool("B:search")` goes to server B. Restart, register B first, then A. Assert: `callTool("search")` now goes to server B. Document this behavior or make it deterministic (e.g., alphabetical by server name).

**Domain Events:**

All seven events are well-defined. The event lifecycle for a healthy provider registration:
1. Boot -> `AgentProviderRegistered` (for each provider)
2. `McpServerDiscovered` (for each auto-discovered MCP server)
3. `KnowledgeBaseReady` (for each RAG KB that transitions to `ready`)
4. Request -> `RoutingRuleMatched` (on every routing decision)

Missing events:
1. `AgentRequest.sent` -- logged when a request is dispatched to a provider (for latency tracking)
2. `AgentRequest.completed` -- logged when response is received (for usage metrics)
3. `CircuitBreaker.opened` / `CircuitBreaker.closed` -- for operational alerting
4. `McpTool.called` / `McpTool.failed` -- for tool usage analytics

---

### 4. Missing Acceptance Criteria

**BDD Scenarios Needed:**

```gherkin
Scenario: Request routes to Cloud.ru agent by capability
  Given a CloudRuAgentProvider registered with capability "code-generation"
  And a routing rule: capability "code-*" -> provider "cloudru-coder"
  When an AgentRequest is sent requiring "code-generation"
  Then the request is dispatched to "cloudru-coder"
  And the response is returned as an AgentResponse

Scenario: Request falls back to claude-cli when Cloud.ru provider is unhealthy
  Given provider "cloudru-coder" has an open circuit breaker (3 consecutive failures)
  And the routing rule has fallback ["claude-cli"]
  When an AgentRequest for "code-generation" is sent
  Then the request is dispatched to "claude-cli"
  And a RoutingRuleMatched event is emitted with fallback=true

Scenario: Cloud.ru agent cold start is handled gracefully
  Given a Cloud.ru agent with minInstances=0 and status "COOLED"
  When an AgentRequest is sent
  Then the request succeeds after 10-30s cold start delay
  And the response includes metadata.coldStart=true
  And no timeout error is raised (timeout extended for COOLED agents)

Scenario: MCP server auto-discovery registers platform tools
  Given Cloud.ru project has 3 managed MCP servers (web-search, code-exec, rag)
  When the startup sequence calls registerCloudRuServers()
  Then 3 MCP server registrations are created
  And all tools from all 3 servers are indexed in McpFederation
  And a McpServerDiscovered event is emitted for each

Scenario: MCP tool name collision uses namespaced resolution
  Given MCP server "web-search" has tool "search"
  And MCP server "rag" also has tool "search"
  When "web-search" is registered first
  Then callTool("search") dispatches to "web-search"
  And callTool("web-search:search") dispatches to "web-search"
  And callTool("rag:search") dispatches to "rag"

Scenario: HybridOrchestrator fan-out distributes sub-tasks
  Given 3 AgentProviders registered with different capabilities
  When fanOut() is called with 3 sub-tasks matching different capabilities
  Then all 3 sub-tasks execute in parallel
  And the result Map contains 3 entries
  And failed sub-tasks have their requestId in the rejected set

Scenario: Cloud.ru API key rotation does not disrupt service
  Given the system is running with API key "key-v1"
  When the environment variable is updated to "key-v2"
  And the system is notified to refresh credentials
  Then subsequent requests use "key-v2"
  And in-flight requests on "key-v1" complete normally

Scenario: RAG knowledge base exposed as MCP tool
  Given a Cloud.ru RAG KB with id "kb-docs-001" and useAsMcpTool=true
  When the startup sequence processes the RAG config
  Then a virtual MCP tool "kb-docs-001:search_documents" is registered
  And agents can call this tool via the McpFederation

Scenario: Circuit breaker opens after consecutive failures
  Given provider "cloudru-coder" is registered and healthy
  When 3 consecutive requests to "cloudru-coder" fail with HTTP 500
  Then the circuit breaker transitions to "open"
  And an AgentProviderHealthDegraded event is emitted
  And subsequent requests are routed to the fallback provider
  When 30 seconds pass (half-open probe interval)
  Then a single request is sent to "cloudru-coder"
  And if it succeeds, the circuit breaker transitions to "closed"
  And an AgentProviderRecovered event is emitted
```

**Undefined Integration Contracts:**

1. **`IAgentProvider.execute()` <-> Cloud.ru OpenAI-compatible API:** The ADR describes the API as "OpenAI-compatible" but does not specify which OpenAI API version (v1?). The request/response mapping is sketched but not formalized. If Cloud.ru adds non-standard fields, the mapping breaks silently.
2. **`McpFederation.dispatchToolCall()` <-> MCP JSON-RPC protocol:** The internal dispatch mechanism is not specified. Is it a raw HTTP POST with JSON-RPC 2.0? Are responses validated against the MCP schema? What happens if the response is malformed?
3. **`CloudRuAgentProvider.buildMessages()` <-> AgentRequest:** The mapping from `AgentRequest` to OpenAI-style `messages[]` is not specified. How is `systemPrompt` handled? Is it prepended as a system message? Is `context.conversationHistory` included?
4. **`HybridOrchestrator` <-> `CircuitBreaker`:** The circuit breaker configuration (`failureThreshold`, `resetTimeout`, `halfOpenRequests`) is referenced but not defined in the config schema.

---

### 5. Pre-Implementation Tests

#### Unit Tests (write BEFORE implementation)

1. **`CloudRuAgentProvider.execute()` sends correct HTTP request.** Mock `HttpClient.post()`. Call `execute(request)`. Assert: URL is `/{projectId}/agents/{agentId}/completions`, body has `messages`, `tools`, `temperature`, `max_tokens`, `stream: false`.

2. **`CloudRuAgentProvider.execute()` maps response to `AgentResponse`.** Mock `HttpClient.post()` returning OpenAI-format response. Assert `AgentResponse.content` equals the assistant message content.

3. **`CloudRuAgentProvider.healthCheck()` returns true for RUNNING status.** Mock API returning `{ status: 'RUNNING' }`. Assert `healthCheck()` returns `true`.

4. **`CloudRuAgentProvider.healthCheck()` returns true for COOLED status.** Mock API returning `{ status: 'COOLED' }`. Assert `healthCheck()` returns `true`.

5. **`CloudRuAgentProvider.healthCheck()` returns false for SUSPENDED status.** Mock API returning `{ status: 'SUSPENDED' }`. Assert `healthCheck()` returns `false`.

6. **`CloudRuAgentProvider.buildAuthHeaders()` uses X-API-Key for api_key type.** Construct with `authType: 'api_key'`. Assert headers contain `{ 'X-API-Key': apiKey }`.

7. **`CloudRuAgentProvider.buildAuthHeaders()` uses Bearer for access_key type.** Construct with `authType: 'access_key'`. Assert headers contain `{ 'Authorization': 'Bearer ...' }`.

8. **`HybridOrchestrator.execute()` routes by capability pattern.** Register two providers. Add routing rule `"code-*" -> provider A`. Send request requiring `"code-review"`. Assert dispatched to provider A.

9. **`HybridOrchestrator.execute()` uses fallback when primary circuit breaker is open.** Open provider A's breaker. Send request. Assert dispatched to fallback provider B.

10. **`HybridOrchestrator.execute()` uses default provider when no rule matches.** Send request with capability `"unknown"`. Assert dispatched to default provider.

11. **`HybridOrchestrator.fanOut()` executes subtasks in parallel.** Mock 3 providers with 100ms delay each. Call `fanOut()` with 3 tasks. Assert total time is ~100ms (parallel), not ~300ms (sequential).

12. **`McpFederation.registerCloudRuServers()` indexes all tools.** Mock API returning 2 servers with 3 tools each. Assert `listAllTools()` returns 6 tools.

13. **`McpFederation.callTool()` dispatches to correct server.** Register 2 servers with different tools. Assert `callTool("tool-from-server-A")` dispatches to server A.

14. **`McpFederation.callTool()` throws `ToolNotFoundError` for unknown tool.** Assert `callTool("nonexistent")` throws with available tool names listed.

15. **`CircuitBreaker` opens after N failures.** Configure threshold=3. Execute 3 failing calls. Assert `breaker.state === 'open'`. Assert next call is rejected without executing.

16. **`CircuitBreaker` transitions to half-open after reset timeout.** Open the breaker. Advance timer past `resetTimeout`. Assert `breaker.state === 'half-open'`. Execute a successful call. Assert `breaker.state === 'closed'`.

#### Integration Tests

1. **Full provider lifecycle: register, health check, execute, dispose.** Create a real `CloudRuAgentProvider` pointing to a mock HTTP server. Register with `ExternalAgentRegistry`. Health check. Execute a request. Dispose. Assert all lifecycle methods complete without error.

2. **MCP federation with mock SSE server.** Start a local SSE server implementing MCP `tools/list` and `tools/call`. Register it via `McpFederation`. List tools. Call a tool. Assert response matches expected output.

3. **Hybrid orchestrator with circuit breaker failover.** Set up provider A (returns 500) and provider B (returns 200). Send requests. Assert first 3 go to A (fail), fourth goes to B (succeeds), circuit breaker on A is open.

4. **Cloud.ru Agent System provider with mock endpoint.** Mock the Agent System completions endpoint. Send a request. Assert the response is correctly mapped through the planner/worker pipeline.

5. **Config validation rejects missing credentials.** Create `AgentFabricConfig` with `cloudru.authType: 'api_key'` but no `CLOUDRU_AGENTS_API_KEY` env var. Assert `config-validator` throws `MissingCredentialError`.

#### E2E Test Scenarios

1. **User message routed to Cloud.ru agent and response delivered.** User sends a message via Telegram. The message requires code generation. `HybridOrchestrator` routes to `CloudRuAgentProvider`. Cloud.ru agent processes and returns response. Response is streamed back to Telegram via the streaming pipeline. Assert the user receives a complete response.

2. **Failover from Cloud.ru to Claude CLI on Cloud.ru outage.** During normal operation, stop the Cloud.ru mock endpoint. Send a message. Assert the circuit breaker opens, request is retried via Claude CLI, and user receives a response (possibly with slightly different quality but no error visible).

---

### 6. Cross-ADR Integration Risks

| ADR Pair | Integration Risk | Contract Test Needed |
|----------|-----------------|---------------------|
| **ADR-013 + ADR-003** (Claude Code CLI as Agent) | ADR-003 defines `runCliAgent()` as the execution path. ADR-013 wraps it in `ClaudeCodeCliProvider`. Risk: the wrapper changes behavior (e.g., adds timeout that conflicts with ADR-003's existing timeout, or loses session ID propagation). | Contract test: `ClaudeCodeCliProvider.execute(request)` produces identical output to direct `runCliAgent(prompt, env)` for the same input. Session IDs, environment variables, and output format must match. |
| **ADR-013 + ADR-004** (Proxy Lifecycle) | ADR-004 manages proxy startup and health. ADR-013's `ClaudeCodeCliProvider.healthCheck()` verifies proxy reachability. Risk: ADR-004's health check and ADR-013's health check may diverge -- ADR-004 checks the proxy process, ADR-013 checks the HTTP endpoint. If the proxy process is alive but the endpoint is unreachable (port conflict), the checks disagree. | Contract test: when ADR-004 reports proxy healthy, ADR-013's provider health check also returns true. When ADR-004 reports proxy unhealthy, ADR-013's provider health check returns false. |
| **ADR-013 + ADR-005** (Model Mapping) | ADR-005 defines model aliases (`"fast"` -> `"cloudru-fm/GLM-4.7-Flash"`). ADR-013 defines `AgentRequest.constraints.temperature` but no `model` field -- the model is configured per-agent on Cloud.ru's side. Risk: a routing rule maps capability to Cloud.ru agent, but the agent's configured model may not match the user's model preference. | Contract test: when a user requests model `"fast"` and the routing rule points to Cloud.ru agent, assert the Cloud.ru agent is configured with the model that `"fast"` resolves to per ADR-005. |
| **ADR-013 + ADR-010** (Streaming Pipeline) | ADR-013's `IAgentProvider.stream()` returns `AsyncIterable<AgentEvent>`. ADR-010's streaming pipeline expects `StreamJsonEvent` from Claude Code's stdout. Risk: the pipeline is tightly coupled to `stream-json` format and cannot consume `AgentEvent` from remote providers. A format adapter is needed. | Contract test: create a `StreamSource` adapter that converts `AsyncIterable<AgentEvent>` to `AsyncIterable<StreamEvent>` (ADR-010 format). Assert that both `ClaudeCodeCliProvider.stream()` and `CloudRuAgentProvider.stream()` can be piped through the same `StreamPipeline`. |
| **ADR-013 + ADR-012** (Plugin Architecture) | ADR-013's `@openclaw/agent-fabric` package defines both the `AgentFabric` interface (ADR-012's module catalog) and `IAgentProvider` (ADR-013's provider contract). Risk: two conceptually different interfaces in the same package with overlapping method names (`chat()` vs `execute()`). Consumers may use the wrong interface. | Contract test: `AgentFabric.chat()` delegates to `HybridOrchestrator.execute()` which dispatches to `IAgentProvider.execute()`. Assert the full delegation chain works end-to-end. |
| **ADR-013 + ADR-007** (Tools & MCP) | ADR-013 federates MCP tools from Cloud.ru managed servers. ADR-007 defines per-tier tool access (Restricted: no tools, Standard: curated, Full: all). Risk: MCP federation makes all Cloud.ru tools available regardless of tier. A Restricted-tier user could access `code-exec` MCP tool via an agent that has it configured. | Contract test: execute an `AgentRequest` from a Restricted-tier tenant. Assert the agent's `tools` parameter does not include any MCP tools. Assert the `ToolSandbox` filters out unauthorized tools before passing to the provider. |

---

### 7. Defect Prevention Recommendations

**Architectural Patterns:**

1. **AbortController for Stream Cancellation.** Pass an `AbortSignal` to all `IAgentProvider` methods to enable caller-initiated cancellation:

```typescript
interface IAgentProvider {
  execute(request: AgentRequest, signal?: AbortSignal): Promise<AgentResponse>;
  stream(request: AgentRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
```

2. **Rate Limiter per Provider.** The orchestrator should enforce per-provider rate limits before dispatching:

```typescript
interface ProviderRateLimit {
  readonly maxRps: number;
  readonly maxConcurrent: number;
  readonly burstAllowance: number;
}

class RateLimitedProvider implements IAgentProvider {
  constructor(
    private readonly inner: IAgentProvider,
    private readonly limits: ProviderRateLimit,
    private readonly limiter: RateLimiter
  ) {}

  async execute(request: AgentRequest): Promise<AgentResponse> {
    await this.limiter.acquire(this.inner.providerId);
    return this.inner.execute(request);
  }
}
```

3. **Cold Start Awareness.** When a provider's last known status is `COOLED`, extend the request timeout:

```typescript
function resolveTimeout(provider: IAgentProvider, baseTimeout: number): number {
  if (provider instanceof CloudRuAgentProvider && provider.lastKnownStatus === 'COOLED') {
    return baseTimeout + 30_000; // extra 30s for cold start
  }
  return baseTimeout;
}
```

4. **MCP Tool Resolution with Deterministic Priority.** Replace first-registered-wins with alphabetical-by-server-name priority:

```typescript
private indexTools(registration: McpServerRegistration): void {
  for (const tool of registration.tools) {
    const existing = this.toolIndex.get(tool.name);
    if (!existing || registration.name < existing.serverName) {
      // Alphabetically earlier server name wins unnamespaced slot
      this.toolIndex.set(tool.name, { serverId: registration.serverId, tool, serverName: registration.name });
    }
    // Always register namespaced
    this.toolIndex.set(`${registration.name}:${tool.name}`, { ... });
  }
}
```

5. **Retry with Exponential Backoff for Transient Errors.** Wrap HTTP calls in a retry layer that distinguishes transient (429, 502, 503) from permanent (400, 401, 404) errors:

```typescript
const TRANSIENT_STATUS_CODES = new Set([429, 502, 503, 504]);

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      if (error instanceof HttpError && !TRANSIENT_STATUS_CODES.has(error.status)) throw error;
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
  throw new Error('Unreachable');
}
```

**Runtime Validations:**

1. **Validate `AgentRequest.constraints`** at system boundary: `timeoutMs > 0`, `maxTokens > 0 && maxTokens <= 128000`, `temperature >= 0 && temperature <= 2`.
2. **Validate Cloud.ru API responses** against expected schema. Use a lightweight runtime validator (e.g., Zod) to parse `OpenAICompletionResponse`. Log and reject malformed responses.
3. **Validate MCP tool arguments** against the tool's `inputSchema` before dispatching to the MCP server. Catch validation errors locally rather than sending invalid data to the server.
4. **Monitor circuit breaker state transitions.** Log every open/close/half-open transition with provider ID, failure count, and recovery time.
5. **Monitor token usage per provider.** Track `AgentResponse.usage.totalTokens` per provider per tenant. Alert when daily consumption exceeds configured thresholds.
6. **Validate `providerId` uniqueness** at registration time with a clear error message listing the conflicting registration.
7. **Sanitize MCP server URLs** against SSRF (per ADR-011 recommendation). Validate that SSE endpoints do not resolve to private IP ranges.
8. **Log all routing decisions** with structured data: `{ requestId, capability, selectedProvider, fallbackUsed, latencyMs }`. Enable debugging of routing issues without code changes.

---
---

## Cross-Cutting Findings (Both ADRs)

### Interface Duplication Between ADR-012 and ADR-013

ADR-012 defines `AgentFabric` interface (section "Module Interface Contracts", interface 8):
- `listAgents()`, `getAgent()`, `createAgent()`, `updateAgent()`, `deleteAgent()`
- `chat()`, `chatStream()`, `delegate()`, `healthCheck()`

ADR-013 defines `IAgentProvider` interface (section 1):
- `execute()`, `stream()`, `listCapabilities()`, `healthCheck()`, `dispose()`

These are two interfaces for agent interaction in the same `@openclaw/agent-fabric` package. `AgentFabric.chat()` and `IAgentProvider.execute()` overlap in purpose. The relationship between them must be clarified:

**Option A:** `AgentFabric` is the high-level management API (CRUD + chat), and `IAgentProvider` is the low-level execution interface. `AgentFabric.chat()` delegates to `HybridOrchestrator.execute()` which dispatches to an `IAgentProvider`.

**Option B:** `AgentFabric` is replaced by `IAgentProvider` + `ExternalAgentRegistry` for all agent interactions.

**Recommendation:** Option A. Document explicitly that `AgentFabric` is the public API for the `@openclaw/agent-fabric` module, while `IAgentProvider` is the internal extension point.

### Shared Types: `TokenUsage` and `ToolCall`

Both ADRs reference `TokenUsage` and `ToolCall` types. ADR-012 defines them in `@openclaw/llm-router/types.ts`. ADR-013 uses them in `AgentResponse.usage` and `AgentEvent`. If ADR-013's `@openclaw/agent-fabric` imports these from `@openclaw/llm-router`, it creates a hard dependency (violating ADR-012's Invariant 1: Module Independence).

**Recommendation:** Extract `TokenUsage`, `ToolCall`, `ToolDefinition`, `ChatMessage`, `HealthStatus`, and other cross-cutting types into a shared types package: `@openclaw/types` (zero dependencies, pure type definitions).

### Circuit Breaker Configuration Gap

ADR-013 mentions `CircuitBreakerConfig` as a parameter of `OrchestratorConfig` but never defines its shape. The following must be specified:

```typescript
interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the breaker */
  failureThreshold: number;       // default: 3
  /** Duration in ms the breaker stays open before transitioning to half-open */
  resetTimeoutMs: number;         // default: 30_000
  /** Number of successful requests in half-open state to close the breaker */
  successThreshold: number;       // default: 1
  /** Sliding window size for failure counting (0 = count-based, no window) */
  windowSizeMs: number;           // default: 60_000
  /** Maximum number of requests to let through in half-open state */
  halfOpenMaxRequests: number;    // default: 1
}
```

### Observability Gaps

Both ADRs define domain events but neither specifies:
- **Event transport:** In-process `EventEmitter`? A shared `EventBus` instance from `@openclaw/core`? Both ADRs should use the same `EventBus` defined in ADR-012.
- **Event schema versioning:** What happens when a new field is added to `AgentProviderRegistered`? Older handlers may break.
- **Distributed tracing:** Requests that traverse multiple providers (fan-out) need a correlation ID that propagates through all events. `AgentRequest.requestId` is a candidate but cross-ADR tracing (ADR-010 streaming events + ADR-013 agent events) requires a shared trace context.

### Missing Error Taxonomy

ADR-012 has no typed error hierarchy. ADR-013 mentions `AgentError` in `AgentEvent` but never defines it. Both need:

```typescript
abstract class OpenClawError extends Error {
  abstract readonly code: string;
  abstract readonly recoverable: boolean;
}

class ProviderUnavailableError extends OpenClawError {
  readonly code = 'PROVIDER_UNAVAILABLE';
  readonly recoverable = true;
  constructor(readonly providerId: string, readonly cause: Error) { super(); }
}

class CircuitBreakerOpenError extends OpenClawError {
  readonly code = 'CIRCUIT_BREAKER_OPEN';
  readonly recoverable = true;
  constructor(readonly providerId: string) { super(); }
}

class ToolNotFoundError extends OpenClawError {
  readonly code = 'TOOL_NOT_FOUND';
  readonly recoverable = false;
  constructor(readonly toolName: string, readonly availableTools: string[]) { super(); }
}

class CredentialMissingError extends OpenClawError {
  readonly code = 'CREDENTIAL_MISSING';
  readonly recoverable = false;
  constructor(readonly envVarName: string) { super(); }
}
```

---

## HTSM v6.3 Quality Characteristics Coverage

| Quality Characteristic | ADR-012 Coverage | ADR-013 Coverage | Gap Analysis |
|----------------------|:----------------:|:----------------:|-------------|
| **Functionality / Correctness** | Typed interfaces ensure compile-time correctness. `build()` validates dependency graph. | `IAgentProvider` contract ensures functional correctness. OpenAI-compatible mapping is specified. | Gap: no runtime schema validation for external API responses. |
| **Functionality / Completeness** | All 8 module interfaces defined. EventBus covers 12 event types. | Provider lifecycle (register, health, execute, stream, dispose) is complete. MCP federation covers 3 source types. | Gap: missing plugin hot-reload, version compatibility checks. |
| **Reliability / Error Handling** | Plugin `dispose()` error handling unspecified. EventBus handler errors unspecified. | Circuit breaker for provider failures. `Promise.allSettled` for fan-out. | Gap: no error taxonomy. No retry strategy for transient HTTP errors. |
| **Reliability / Recoverability** | Container scope `dispose()` enables cleanup. | Circuit breaker half-open state enables recovery. | Gap: no persistent state recovery. If the process restarts, all circuit breaker state is lost. |
| **Performance / Latency** | DI resolution should be O(1) for singletons. No performance requirements stated. | Cold start 10-30s acknowledged but not mitigated. | Gap: no cache for `resolve()`. No warm-up mechanism for COOLED agents. |
| **Performance / Throughput** | Event bus throughput not specified. | Rate limit of 15 req/s per Cloud.ru API key. | Gap: no per-provider rate limiter in orchestrator. |
| **Security / Authentication** | API keys via environment variables only. | `apiKey` in config interface contradicts env-only invariant. | Gap: credential isolation not type-enforced. |
| **Security / Authorization** | Tenant isolation via scoped DI. | Provider routing does not check user's access tier. | Gap: MCP tool access not filtered by ADR-007 tier. |
| **Maintainability / Modularity** | 8 independent packages with zero required internal deps. | Clean separation: providers, orchestration, MCP, RAG, config. | Strong. |
| **Maintainability / Testability** | All interfaces mockable. DI enables test composition. | All interfaces mockable. Providers are injectable. | Gap: string-based DI tokens reduce type safety. EventBus handler semantics undefined. |
| **Portability** | npm packages work in any Node.js environment. | Cloud.ru-specific but behind anti-corruption layer. | Good. Non-Cloud.ru providers implement same `IAgentProvider`. |
| **Operability / Monitoring** | 12 domain events for observability. `healthCheck()` aggregation. | 7 domain events. Health check per provider. | Gap: no structured logging spec. No metrics endpoint. No distributed tracing. |

---

## Risk Storming Heat Map

```
                    PROBABILITY
              Low    Medium    High
         ┌─────────┬─────────┬─────────┐
  High   │ E5-012  │ E11-012 │ E1-013  │
         │ dispose │ hot-rel │ 401-key │
IMPACT   ├─────────┼─────────┼─────────┤
  Medium │ E9-012  │ E2-013  │ E12-012 │
         │ scoped  │ 429-RL  │ hc-hang │
         ├─────────┼─────────┼─────────┤
  Low    │ E6-012  │ E5-013  │ E3-013  │
         │ no-hdlr │ 0-tools │ status  │
         └─────────┴─────────┴─────────┘

Legend (top 6 risks):
  E1-013  : Cloud.ru API key expiration (Critical/High prob)
  E12-012 : Plugin healthCheck() hangs indefinitely (High/Medium prob)
  E11-012 : Hot-reload race with in-flight requests (High/Medium prob)
  E2-013  : Cloud.ru 429 rate limit exhaustion (Medium/Medium prob)
  E5-012  : Plugin dispose() throws during shutdown (High/Low prob)
  E9-012  : Scoped service resolved outside scope (Medium/Low prob)
```

---

## Mutation Testing Strategy (Stryker)

```json
{
  "stryker": {
    "packageManager": "npm",
    "reporters": ["html", "progress", "json"],
    "testRunner": "jest",
    "coverageAnalysis": "perTest",
    "mutate": [
      "src/core/registry.ts",
      "src/core/container.ts",
      "src/core/events.ts",
      "src/agent-fabric/providers/**/*.ts",
      "src/agent-fabric/orchestration/**/*.ts",
      "src/agent-fabric/mcp/**/*.ts"
    ],
    "thresholds": {
      "high": 85,
      "low": 70,
      "break": 65
    },
    "mutator": {
      "excludedMutations": ["StringLiteral"]
    },
    "timeoutMS": 30000
  }
}
```

**Critical mutation targets:**

| File | Mutation Type | Why Critical |
|------|--------------|-------------|
| `container.ts` → `get()` | Remove null check | Could return `undefined` instead of throwing |
| `container.ts` → `build()` | Skip cycle detection | Circular deps reach production |
| `circuit-breaker.ts` → threshold check | Change `>=` to `>` | Breaker never opens (off-by-one) |
| `hybrid-orchestrator.ts` → `selectProvider()` | Skip breaker check | Routes to dead providers |
| `mcp-federation.ts` → `callTool()` | Remove tool existence check | Null reference on missing tool |
| `cloudru-agent-provider.ts` → `healthCheck()` | Return `true` always | Dead agent appears healthy |

---

## Contract Testing (Pact)

### Provider: Cloud.ru AI Agents API

```typescript
// pact/cloudru-agent-provider.pact.ts
import { Pact } from '@pact-foundation/pact';

const provider = new Pact({
  consumer: 'openclaw-agent-fabric',
  provider: 'cloudru-ai-agents-api',
  port: 1234,
});

describe('CloudRuAgentProvider Pact', () => {
  beforeAll(() => provider.setup());
  afterAll(() => provider.finalize());

  it('sends a completions request and receives a response', async () => {
    await provider.addInteraction({
      state: 'agent agent-coder-001 is RUNNING',
      uponReceiving: 'a completions request',
      withRequest: {
        method: 'POST',
        path: '/proj-abc-123/agents/agent-coder-001/completions',
        headers: { 'X-API-Key': 'test-api-key' },
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
          temperature: 0.3,
          max_tokens: 4096,
        },
      },
      willRespondWith: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          id: Matchers.like('chatcmpl-123'),
          choices: [{
            index: 0,
            message: { role: 'assistant', content: Matchers.like('Hello!') },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: Matchers.integer(),
            completion_tokens: Matchers.integer(),
            total_tokens: Matchers.integer(),
          },
        },
      },
    });

    const agent = new CloudRuAgentProvider({
      projectId: 'proj-abc-123',
      agentId: 'agent-coder-001',
      baseUrl: `http://localhost:1234`,
      apiKey: 'test-api-key',
      authType: 'api_key',
    });

    const response = await agent.execute({
      requestId: 'req-1',
      sessionId: 'session-1',
      message: 'Hello',
    });

    expect(response.content).toBeTruthy();
    expect(response.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('returns agent health status', async () => {
    await provider.addInteraction({
      state: 'agent agent-coder-001 is RUNNING',
      uponReceiving: 'a health check request',
      withRequest: {
        method: 'GET',
        path: '/proj-abc-123/agents/agent-coder-001',
        headers: { 'X-API-Key': 'test-api-key' },
      },
      willRespondWith: {
        status: 200,
        body: { status: 'RUNNING' },
      },
    });

    const healthy = await agent.healthCheck();
    expect(healthy).toBe(true);
  });
});
```

### Provider: MCP Server (JSON-RPC)

```typescript
// pact/mcp-federation.pact.ts
it('discovers tools via MCP tools/list', async () => {
  await provider.addInteraction({
    state: 'MCP server has 2 tools',
    uponReceiving: 'a tools/list request',
    withRequest: {
      method: 'POST',
      path: '/mcp/server-001',
      body: { jsonrpc: '2.0', method: 'tools/list', params: {}, id: Matchers.integer() },
    },
    willRespondWith: {
      status: 200,
      body: {
        jsonrpc: '2.0',
        result: {
          tools: [
            { name: 'search', description: Matchers.like('Search documents'), inputSchema: Matchers.like({}) },
            { name: 'retrieve', description: Matchers.like('Retrieve document'), inputSchema: Matchers.like({}) },
          ],
        },
        id: Matchers.integer(),
      },
    },
  });
});
```

---

## Property-Based Testing (fast-check)

```typescript
import * as fc from 'fast-check';

// Property: Container always resolves registered services
fc.assert(
  fc.property(
    fc.array(fc.tuple(fc.string(), fc.anything()), { minLength: 1, maxLength: 50 }),
    (registrations) => {
      const container = new OpenClawContainer('test');
      for (const [token, value] of registrations) {
        container.set(token, value);
      }
      for (const [token, value] of registrations) {
        expect(container.get(token)).toBe(value);
      }
    }
  )
);

// Property: Circuit breaker opens after exactly N failures
fc.assert(
  fc.property(
    fc.integer({ min: 1, max: 10 }), // threshold
    (threshold) => {
      const breaker = new CircuitBreaker({ failureThreshold: threshold, resetTimeoutMs: 5000 });
      for (let i = 0; i < threshold - 1; i++) {
        breaker.recordFailure();
        expect(breaker.state).toBe('closed');
      }
      breaker.recordFailure();
      expect(breaker.state).toBe('open');
    }
  )
);

// Property: MCP tool name collision always has namespaced fallback
fc.assert(
  fc.property(
    fc.array(fc.record({ serverName: fc.string(), toolName: fc.string() }), { minLength: 2, maxLength: 20 }),
    (servers) => {
      const federation = new McpFederation();
      for (const { serverName, toolName } of servers) {
        federation.registerCustomServer(serverName, serverName, { type: 'sse', url: 'http://test' }, [
          { name: toolName, description: '', inputSchema: {} },
        ]);
      }
      // Every tool must be accessible via namespaced name
      for (const { serverName, toolName } of servers) {
        expect(federation.hasNamespacedTool(`${serverName}:${toolName}`)).toBe(true);
      }
    }
  )
);

// Property: Provider routing is deterministic for same input
fc.assert(
  fc.property(
    fc.record({
      capability: fc.string(),
      providers: fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
    }),
    ({ capability, providers }) => {
      const orchestrator = createOrchestrator(providers);
      const request = { requestId: 'r1', sessionId: 's1', message: 'test' };
      const result1 = orchestrator.selectProviderSync(request, capability);
      const result2 = orchestrator.selectProviderSync(request, capability);
      expect(result1).toBe(result2); // Same input -> same provider
    }
  )
);
```

---

## Shift-Left CI/CD Integration

```yaml
# .github/workflows/shift-left-adr-012-013.yml
name: Shift-Left Quality Gate (ADR-012 + ADR-013)

on:
  pull_request:
    paths:
      - 'src/core/**'
      - 'src/agent-fabric/**'
      - 'packages/@openclaw/**'

jobs:
  dependency-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Verify module independence
        run: |
          for pkg in packages/@openclaw/*/; do
            node scripts/check-internal-deps.js "$pkg"
          done
      - name: Verify no circular dependencies
        run: npx madge --circular --extensions ts src/

  contract-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Run Pact contract tests
        run: npm run test:pact
      - name: Publish Pact contracts
        run: npx pact-broker publish pacts/ --broker-base-url $PACT_BROKER_URL

  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Run unit tests with coverage
        run: npm test -- --coverage --coverageThreshold='{"global":{"branches":80,"functions":85,"lines":85}}'

  mutation-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Run Stryker mutation testing
        run: npx stryker run
      - name: Check mutation score
        run: |
          score=$(jq '.schemaVersion' reports/mutation/mutation.json)
          if [ "$score" -lt 65 ]; then exit 1; fi

  property-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Run fast-check property tests
        run: npm run test:property

  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Scan for credential leaks
        run: npx @claude-flow/cli@latest security scan
      - name: Verify env-only credential access
        run: node scripts/verify-no-hardcoded-keys.js
```

---

## Quantified Metrics and KPIs

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Unit test coverage (lines) | >= 85% | Jest `--coverage` |
| Unit test coverage (branches) | >= 80% | Jest `--coverage` |
| Mutation score | >= 65% | Stryker |
| Pact contract coverage | 100% of external API endpoints | Pact broker verification |
| Property tests | >= 10 properties per module | fast-check test count |
| DI resolution time (singleton) | < 1ms | Benchmark with `performance.now()` |
| DI resolution time (scoped) | < 5ms | Benchmark with `performance.now()` |
| Circuit breaker open time | < 1s after threshold failures | Integration test with timer assertions |
| Health check aggregation time | < 10s for all 8 modules | Integration test with `Promise.race()` |
| MCP tool resolution time | < 1ms for indexed lookup | Benchmark |
| Zero required internal deps | 8/8 packages pass | CI `check-internal-deps.js` |
| Circular dependency count | 0 | `madge --circular` |

---

## Summary Scores

| ADR | Testability Score | Critical Missing Error Scenarios | Missing Acceptance Criteria | Pre-Implementation Tests Identified |
|-----|:-----------------:|:-------------------------------:|:--------------------------:|:-----------------------------------:|
| ADR-012 (Plugin Architecture) | **70/100** | 12 | 9 BDD scenarios, 4 contracts | 12 unit, 5 integration, 2 E2E |
| ADR-013 (AI Fabric Integration) | **68/100** | 12 | 9 BDD scenarios, 4 contracts | 16 unit, 5 integration, 2 E2E |

**Overall assessment:** Both ADRs define well-structured, mockable interfaces that enable test-driven development. The primary risks are:

1. **Interface duplication:** `AgentFabric` (ADR-012) and `IAgentProvider` (ADR-013) overlap in the same package. The canonical interface must be clarified before implementation.
2. **Type safety gaps:** String-based DI tokens, runtime-only invariant enforcement, and `apiKey` in config interfaces reduce compile-time safety.
3. **Missing error handling:** Plugin lifecycle errors (factory throw, dispose throw, health check hang), HTTP error codes (401, 429), and MCP connection drops are unspecified.
4. **Cross-ADR integration:** Shared types (`TokenUsage`, `ToolCall`) create implicit coupling. Streaming pipeline format mismatch between CLI and remote providers.
5. **Operational gaps:** No rate limiting in orchestrator, no cold start mitigation, no circuit breaker config schema, no distributed tracing.

**Recommended next steps:**
1. Extract shared types into `@openclaw/types` package to prevent cross-module coupling.
2. Clarify the `AgentFabric` / `IAgentProvider` relationship -- designate one as the public API, the other as the SPI.
3. Define `CircuitBreakerConfig` schema with concrete defaults.
4. Add `AbortSignal` support to all async provider methods for cancellation.
5. Replace string DI tokens with typed `InjectionToken<T>` to catch wiring errors at compile time.
