> **SUPERSEDED:** This document references ADR-006..013 which were deleted during the v2 ADR rewrite (commit e54143f). ADR-001..005 v2 now cover this scope. Retained for historical context only.

# Implementation Milestones: ADR-006 & ADR-007

## Document Metadata

| Field | Value |
|-------|-------|
| **Date** | 2026-02-13 |
| **Status** | DRAFT |
| **ADRs Implemented** | ADR-006 (Multi-Messenger Adapter Architecture), ADR-007 (Claude Code Tools & MCP Enablement) |
| **Methodology** | SPARC-GOAP (Specification, Pseudocode, Architecture, Refinement, Completion) |
| **Shift-Left Issues Addressed** | F006-01 through F006-10, F007-01 through F007-10, E006-01 through E006-10, E007-01 through E007-10 |
| **QCSD Quality Gates** | Functionality, Reliability, Security (P0); Performance, Maintainability (P1) |
| **Risk Register Coverage** | R006-1 through R006-7, R007-1 through R007-7, X-078-1 through X-078-5, X-068-1 through X-068-3 |

---

## Current State (what exists now)

```yaml
current_state:
  messenger_integration: none
  adapter_abstraction: none
  message_normalization: none
  platform_support: []
  rate_limiting: none
  circuit_breakers: none
  webhook_handling: none
  tool_access_model: "globally disabled (cli-runner.ts:82-83 injects 'Tools are disabled')"
  mcp_integration: none
  sandbox_isolation: none
  access_tiers: none
  audit_logging: none
  kill_switch: none
  workspace_isolation: none
  mcp_config_generation: none
  src_directory: "does not exist yet"
```

## Goal State (what we're building)

```yaml
goal_state:
  messenger_integration:
    architecture: "Hexagonal (Ports and Adapters)"
    platforms: ["telegram", "max"]
    extensible_to: ["web", "api", "whatsapp"]
  adapter_abstraction:
    port_interface: IMessengerAdapter
    factory: IMessengerAdapterFactory
    router: MessageRouter
  message_normalization:
    inbound: NormalizedMessage, NormalizedCallback
    outbound: OutboundMessage, DeliveryReceipt
    value_objects: Attachment, InlineKeyboard, InlineButton
  platform_support:
    telegram: "grammy SDK, webhook + long-polling, 30 msg/s global"
    max: "@maxhub/max-bot-api, webhook + long-polling, 30 RPS per bot"
  resilience:
    rate_limiting: "Token bucket per adapter, per-chat (Telegram)"
    circuit_breakers: "5 failures -> open, 30s -> half-open"
    retry: "3 attempts, exponential backoff (1s, 2s, 4s)"
  tool_access_model: "Three-tier (restricted/standard/full) per-user"
  mcp_integration: "Cloud.ru MCP Registry servers via --mcp-config"
  sandbox_isolation: "Docker/gVisor per-user workspace"
  access_tiers:
    restricted: "No tools (backward-compat with ADR-003)"
    standard: "MCP + WebSearch + WebFetch, sandboxed"
    full: "All Claude Code tools, full MCP"
  audit_logging: "ToolAuditEntry for every invocation"
  kill_switch: "Global revert to restricted tier"
  workspace_isolation: "Per-user /tmp/openclaw/workspaces/${userId}"
  domain_events: "Typed events for all state transitions"
  test_coverage: ">80% unit, >70% integration"
```

---

## Dependency DAG

```
M1 (Shared Kernel: Types & Value Objects)
  |
  +---> M2 (Messenger Core: Port Interfaces & Router)
  |       |
  |       +---> M4 (Telegram Adapter)
  |       |
  |       +---> M5 (MAX Adapter)
  |       |
  |       +---> M6 (Adapter Resilience: Rate Limiter, Circuit Breaker, Retry)
  |
  +---> M3 (Tool Sandbox Core: Tier Resolution & Directives)
          |
          +---> M7 (MCP Configuration & Server Bindings)
          |
          +---> M8 (Sandbox Enforcement & Workspace Isolation)
          |
          +---> M9 (Audit Logging & Kill Switch)

M4 + M5 + M6 ---> M10 (Adapter Integration & Validation Tests)

M7 + M8 + M9 ---> M11 (Tool Sandbox Integration & CLI Runner Modification)

M10 + M11 ---> M12 (Cross-Bounded-Context Integration: Identity Resolution & E2E)
```

---

## Milestone 1: Shared Kernel -- Types, Value Objects & Domain Events

- **Bounded Context**: Shared Kernel (consumed by both Messenger Integration and Agent Execution contexts)
- **SPARC Phase**: Specification
- **Files to create**:
  - `/src/shared-kernel/types/messenger-platform.ts` -- `MessengerPlatform` type union (`'telegram' | 'max' | 'web' | 'api'`)
  - `/src/shared-kernel/types/result.ts` -- `Result<T, E>` discriminated union type (`{ ok: true; value: T } | { ok: false; error: E }`)
  - `/src/shared-kernel/types/branded.ts` -- Branded type utilities (`TelegramChatId`, `MaxChatId`, `PlatformUserId`, `SessionId`, `TenantId`)
  - `/src/shared-kernel/value-objects/normalized-message.ts` -- `NormalizedMessage` interface with `validateNormalizedMessage()` factory
  - `/src/shared-kernel/value-objects/normalized-callback.ts` -- `NormalizedCallback` interface with validation
  - `/src/shared-kernel/value-objects/outbound-message.ts` -- `OutboundMessage`, `OutboundAttachment`, `InlineKeyboard`, `InlineButton` interfaces with `validateOutboundMessage()`
  - `/src/shared-kernel/value-objects/delivery-receipt.ts` -- `DeliveryReceipt` interface
  - `/src/shared-kernel/value-objects/attachment.ts` -- `Attachment` interface, `AttachmentType` union, `validateAttachment()`
  - `/src/shared-kernel/value-objects/adapter-error.ts` -- `AdapterError` interface, `AdapterErrorCode` union
  - `/src/shared-kernel/value-objects/adapter-config.ts` -- `AdapterConfig` interface with `validateAdapterConfig()`
  - `/src/shared-kernel/value-objects/access-tier.ts` -- `AccessTierConfig` interface, `AccessTier` union type (`'restricted' | 'standard' | 'full'`)
  - `/src/shared-kernel/value-objects/connection-status.ts` -- `ConnectionStatus` type, `ConnectionEvent` type, `transitionConnectionStatus()` pure function state machine
  - `/src/shared-kernel/events/messenger-events.ts` -- `MessengerDomainEvent` discriminated union (MESSAGE_RECEIVED, MESSAGE_SENT, DELIVERY_FAILED, CALLBACK_RECEIVED, ADAPTER_STARTED, ADAPTER_STOPPED, ADAPTER_ERROR, RATE_LIMIT_ENTERED, RATE_LIMIT_CLEARED, CIRCUIT_BREAKER_OPENED, CIRCUIT_BREAKER_CLOSED)
  - `/src/shared-kernel/events/tool-sandbox-events.ts` -- `ToolSandboxDomainEvent` discriminated union (TIER_RESOLVED, SANDBOX_CREATED, TOOL_INVOKED, TOOL_DENIED, MCP_SERVER_CONNECTED, MCP_SERVER_FAILED, SANDBOX_VIOLATION, SESSION_TERMINATED, KILL_SWITCH_ACTIVATED, KILL_SWITCH_DEACTIVATED, WORKSPACE_CREATED, WORKSPACE_CLEANED_UP)
  - `/src/shared-kernel/events/event-emitter.ts` -- Typed `DomainEventEmitter<T>` interface (not Node.js EventEmitter; a typed contract)
  - `/src/shared-kernel/index.ts` -- Barrel export
- **Dependencies**: None (starting point)
- **Acceptance criteria**:
  - All value object interfaces have `readonly` fields and use `ReadonlyArray` for collections
  - `validateNormalizedMessage()` rejects messages with neither `text` nor `attachments` (E006-01)
  - `validateNormalizedMessage()` rejects messages with `timestamp` in the future
  - `validateNormalizedMessage()` validates `id` is a valid UUID v4
  - `validateOutboundMessage()` rejects messages with neither `text` nor `attachments`
  - `validateAdapterConfig()` rejects empty `token`, missing `webhookUrl` when transport is `'webhook'`, and non-HTTPS webhook URLs
  - `InlineButton.callbackData` validation enforces <= 64 bytes (UTF-8) limit (E006-04)
  - `transitionConnectionStatus('disconnected', 'activate')` returns `null` (invalid transition)
  - `transitionConnectionStatus('active', 'pause')` returns `'paused'`
  - `transitionConnectionStatus('active', 'rate_limit')` returns `'rate_limited'`
  - `transitionConnectionStatus('rate_limited', 'clear')` returns `'active'`
  - `Result<T, E>` type compiles and forces callers to check `.ok` before accessing `.value`
  - Branded types prevent mixing `TelegramChatId` with `MaxChatId` at compile time
  - All domain event types compile and are exhaustively switchable
  - 100% of validation functions have corresponding test cases
- **Shift-left mitigations**:
  - E006-01: Empty message rejection via `validateNormalizedMessage()`
  - E006-04: Callback data byte-length validation
  - E006-10: `ConnectionStatus` state machine as pure function (prevents invalid transitions)
  - E007-01: `AccessTierConfig` validated at construction time
  - Section 3.2 (both ADRs): Domain events formally typed instead of implicit
- **QCSD quality gates**:
  - HTSM Functionality: All value objects immutable (readonly fields)
  - HTSM Security: No secrets or tokens in any type definition
  - HTSM Maintainability: Zero circular dependencies between files
  - Test coverage: 100% of validation functions
- **Estimated complexity**: MEDIUM

---

## Milestone 2: Messenger Core -- Port Interfaces, Factory & Router

- **Bounded Context**: Messenger Integration
- **SPARC Phase**: Architecture
- **Files to create**:
  - `/src/messenger/core/adapter.interface.ts` -- `IMessengerAdapter` port interface (platform, displayName, start, stop, isHealthy, sendMessage, sendTypingIndicator, editMessage, deleteMessage, onMessage, onCallback, onError)
  - `/src/messenger/core/adapter-factory.ts` -- `IMessengerAdapterFactory` interface + `MessengerAdapterFactory` implementation with `register()`, `create()`, `getSupportedPlatforms()`
  - `/src/messenger/core/router.ts` -- `MessageRouter` class with `registerAdapter()`, `onMessage()`, `onCallback()`, `startAll()`, `stopAll()`, `getAdapter()`. Includes: try/catch boundary around `messageHandler` (F006-03), `sendMessage` failure handling with dead-letter logging (F006-04), `Promise.allSettled()` in `startAll()` (F006-05), and domain event emission
  - `/src/messenger/core/messenger-connection.ts` -- `MessengerConnection` aggregate with `ConnectionIdentity` branded type (`${platform}:${platformUserId}:${platformChatId}`), status transitions via `transitionConnectionStatus()`
  - `/src/messenger/core/index.ts` -- Barrel export for core module
- **Dependencies**: M1 (Shared Kernel)
- **Acceptance criteria**:
  - `IMessengerAdapter` compiles as a fully typed interface; no `any` types
  - `MockMessengerAdapter` (see M2 testing below) implements `IMessengerAdapter` with zero type errors
  - `MessengerAdapterFactory.create()` throws on unregistered platform
  - `MessengerAdapterFactory.getSupportedPlatforms()` returns exactly the set of registered platforms
  - `MessageRouter.registerAdapter()` wires `onMessage`, `onCallback`, `onError` handlers
  - `MessageRouter` catches handler exceptions and does not propagate to adapter (F006-03): test with a handler that throws, assert adapter continues operating
  - `MessageRouter` handles `sendMessage` failure after handler success: logs to dead-letter, emits `MESSAGE_DELIVERY_FAILED` event (F006-04)
  - `MessageRouter.startAll()` uses `Promise.allSettled()` (not `Promise.all()`), returns array of results so caller knows which adapters started and which failed (F006-05)
  - `MessageRouter.stopAll()` uses `Promise.allSettled()` and resolves even if adapters throw during stop
  - `ConnectionIdentity` is a branded string type; duplicate connections for same tuple rejected
  - `MessengerConnection.status` transitions enforced via `transitionConnectionStatus()`
  - Router emits domain events: `ADAPTER_STARTED`, `ADAPTER_STOPPED`, `MESSAGE_RECEIVED`, `MESSAGE_SENT`
- **Shift-left mitigations**:
  - F006-03: Router wraps handler calls in try/catch
  - F006-04: Dead-letter mechanism for failed deliveries after successful handler
  - F006-05: `startAll()` uses `Promise.allSettled()` instead of `Promise.all()`
  - Section 2.2 E006-06: Router handles messages arriving during `stop()` gracefully
  - Section 4.2: `onMessage` handler signature returns `Promise<OutboundMessage>` in router (not `Promise<void>`) to resolve the inconsistency flagged in the shift-left report
- **QCSD quality gates**:
  - HTSM Functionality: Adapter factory registration correctness
  - HTSM Reliability: Adapter isolation -- one adapter crash does not affect another (R006-5, invariant 2)
  - HTSM Maintainability: New adapter implementable in < 500 LOC without modifying core
  - Test mock completeness: `MockMessengerAdapter` covers 100% of `IMessengerAdapter` methods
- **Estimated complexity**: MEDIUM

---

## Milestone 3: Tool Sandbox Core -- Tier Resolution, Directives & CLI Args

- **Bounded Context**: Agent Execution
- **SPARC Phase**: Architecture
- **Files to create**:
  - `/src/tool-sandbox/access-tier.ts` -- `resolveAccessTier(userContext, instanceConfig, killSwitchConfig)` pure function. Implements: kill switch check first (invariant 7), self-hosted override, admin role, API key scopes, authenticated default, anonymous fallback. Includes `UserContext` and `InstanceConfig` interface definitions.
  - `/src/tool-sandbox/tool-directive.ts` -- `buildToolAccessDirective(tier, allowedTools)` pure function. Returns tier-specific system prompt injection strings.
  - `/src/tool-sandbox/cli-args.ts` -- `buildClaudeCliArgs(tier, mcpConfig, sessionId, message)` pure function. Returns structured `ClaudeCliArgs` object with base args, tool args, and optional MCP config path.
  - `/src/tool-sandbox/sandbox-config.ts` -- `SandboxConfig` interface (DeepReadonly), `SANDBOX_DEFAULTS` for restricted/standard/full tiers, `validateSandboxConfig()` with path traversal prevention and writable-under-rootDir check
  - `/src/tool-sandbox/resource-quota.ts` -- `ResourceQuota` interface (referenced in ADR-007 aggregate but never defined -- filling the gap per E007-10)
  - `/src/tool-sandbox/index.ts` -- Barrel export
- **Dependencies**: M1 (Shared Kernel -- specifically `AccessTierConfig`, `Result` types)
- **Acceptance criteria**:
  - `resolveAccessTier()` returns `restricted` for anonymous user (U007-01)
  - `resolveAccessTier()` returns `full` for admin user (U007-02)
  - `resolveAccessTier()` returns `full` for self-hosted instance regardless of user (U007-03)
  - `resolveAccessTier()` returns `restricted` when kill switch active, even for admin (U007-04)
  - `resolveAccessTier()` returns `standard` for authenticated user with `tools` API key scope
  - `resolveAccessTier()` returns `standard` for authenticated user when `defaultAuthenticatedTier` not set
  - `resolveAccessTier()` is a pure function: same inputs always produce same outputs
  - `buildToolAccessDirective()` returns `'Tools are disabled...'` for restricted (U007-05)
  - `buildToolAccessDirective()` lists allowed tools for standard tier (U007-06)
  - `buildToolAccessDirective()` returns empty string for full tier (U007-07)
  - `buildClaudeCliArgs()` includes `--allowed-tools ''` for restricted tier (U007-10)
  - `buildClaudeCliArgs()` includes `--allowed-tools 'mcp__*,WebSearch,WebFetch'` for standard tier
  - `buildClaudeCliArgs()` skips `--mcp-config` when MCP server list is empty (E007-04)
  - `validateSandboxConfig()` rejects `rootDir` containing `..` segments (E007-07)
  - `validateSandboxConfig()` rejects `writablePaths` outside `rootDir`
  - `validateSandboxConfig()` rejects `maxMemoryMB` <= 0
  - `ResourceQuota` interface is defined and exported
  - All functions are pure (no side effects, no I/O)
  - Edge case: user with both admin role AND tools API key scope resolves to `full` (E007-01)
  - Edge case: self-hosted + anonymous resolves to `full` (E007-02) -- documented as intentional behavior with security note
- **Shift-left mitigations**:
  - F007-02: Document that `--dangerously-skip-permissions` is always included and why; add code comment
  - F007-08: Test that `--allowed-tools ''` on restricted tier behaves as expected (empty allowlist)
  - E007-01 through E007-03: All edge cases tested explicitly
  - E007-10: `ResourceQuota` type defined (was missing from ADR-007)
  - Section 3.3: All value object validations implemented
- **QCSD quality gates**:
  - HTSM Functionality: Correct tier for all 5 user contexts
  - HTSM Functionality: Kill switch supremacy (invariant 7)
  - HTSM Security: Sandbox path traversal prevention
  - HTSM Performance: Tier resolution pure function (no I/O, < 1ms)
  - Test coverage: 3 tiers x 4 functions = 12 minimum test suites
- **Estimated complexity**: MEDIUM

---

## Milestone 4: Telegram Adapter

- **Bounded Context**: Messenger Integration
- **SPARC Phase**: Refinement (TDD)
- **Files to create**:
  - `/src/messenger/adapters/telegram/telegram-adapter.ts` -- `TelegramAdapter implements IMessengerAdapter`. Uses `grammy` SDK. Webhook + long-polling transport. Lifecycle: constructor -> `start()` -> process messages -> `stop()`.
  - `/src/messenger/adapters/telegram/telegram-normalizer.ts` -- `normalizeTelegramMessage(ctx: Context): Result<NormalizedMessage, AdapterError>`. Handles: text, caption, photo, document, video, audio, voice, sticker (convert to photo on unsupported), contact, location. Returns `Result` type (F006-02: partial normalization failure returns error, not exception).
  - `/src/messenger/adapters/telegram/telegram-denormalizer.ts` -- `denormalizeTelegramKeyboard(keyboard: InlineKeyboard): TelegramInlineKeyboardMarkup`. `denormalizeTelegramMessage(msg: OutboundMessage): TelegramSendParams`. Handles: parse mode mapping (plain/markdown/html), keyboard with both callback + URL buttons, text truncation at 4096 chars with "..." suffix (E006-02, E006-03).
  - `/src/messenger/adapters/telegram/telegram-webhook-auth.ts` -- Webhook signature verification middleware. Validates `X-Telegram-Bot-Api-Secret-Token` header (F006-01). Returns 403 for unsigned requests.
  - `/src/messenger/adapters/telegram/telegram-deduplicator.ts` -- `TelegramDeduplicator` class. Tracks `(platform, update_id)` in TTL cache (5min). Skips duplicate webhook deliveries (F006-07).
  - `/src/messenger/adapters/telegram/index.ts` -- Barrel export
- **Dependencies**: M1 (Shared Kernel), M2 (Core Interfaces)
- **Acceptance criteria**:
  - TelegramAdapter implements all `IMessengerAdapter` methods with zero type errors
  - `normalizeTelegramMessage()` correctly normalizes plain text message (U006-01): platform=telegram, chatId=String(chat.id), userId=String(from.id), text, timestamp from date*1000
  - `normalizeTelegramMessage()` extracts photo attachment with fileId and size (U006-02): uses largest PhotoSize
  - `normalizeTelegramMessage()` returns `Result.error` for unknown attachment types (F006-02 mitigation: partial failure returns error, not throw)
  - `denormalizeTelegramKeyboard()` preserves both callback and URL buttons (U006-03)
  - `denormalizeTelegramMessage()` truncates text > 4096 chars to 4093 + "..." (E006-03)
  - `denormalizeTelegramMessage()` passes text of exactly 4096 chars unchanged (E006-02)
  - `denormalizeTelegramMessage()` enforces callbackData <= 64 bytes; truncates excess
  - Webhook auth middleware rejects unsigned requests with 403 (F006-01, TC-SEC-002)
  - Deduplicator skips duplicate `update_id` values within 5-minute window (F006-07)
  - `sendMessage()` returns `DeliveryReceipt` with `success: false` on SDK error (never throws)
  - `start()` resolves within 5s; `stop()` drains in-flight messages within 10s
  - Token never appears in logs, error messages, or serialized `NormalizedMessage` metadata
  - `sticker` message normalized with type `'sticker'` and `mimeType` `'image/webp'`
  - `replyTo` maps `reply_to_message.message_id` to string
  - metadata includes `chatType`, `username`, `firstName`, `languageCode`
- **Shift-left mitigations**:
  - F006-01: Webhook signature verification implemented
  - F006-02: Partial normalization failure via `Result` type (no exceptions)
  - F006-07: Deduplication of webhook retries
  - E006-02/E006-03: Message length boundary handling
  - E006-04: Callback data byte-length enforcement
  - E006-08: Attachment size validation (reject > 50MB document, > 10MB photo)
  - E006-09: Invalid `replyTo` handled gracefully (SDK 400 caught and returned as failed receipt)
- **QCSD quality gates**:
  - HTSM Functionality: 100% normalization fidelity for all supported Telegram message types
  - HTSM Security: Webhook authentication enforced; tokens never in logs (R006-4)
  - HTSM Performance: Normalization < 1ms per message
  - HTSM Reliability: `sendMessage` never throws (returns `DeliveryReceipt` with `success: false`)
- **Estimated complexity**: HIGH

---

## Milestone 5: MAX Adapter

- **Bounded Context**: Messenger Integration
- **SPARC Phase**: Refinement (TDD)
- **Files to create**:
  - `/src/messenger/adapters/max/max-adapter.ts` -- `MaxAdapter implements IMessengerAdapter`. Uses `@maxhub/max-bot-api` SDK. Webhook + long-polling transport. 30 RPS per bot token.
  - `/src/messenger/adapters/max/max-normalizer.ts` -- `normalizeMaxMessage(update: MaxUpdate): Result<NormalizedMessage, AdapterError>`. Handles: text, attachments (document, photo, video, audio, contact, location). Maps `msg.recipient.chatId` (UUID string) and `msg.sender.userId`. Maps `msg.link.type === 'reply'` to `replyTo`.
  - `/src/messenger/adapters/max/max-denormalizer.ts` -- `denormalizeMaxKeyboard(keyboard: InlineKeyboard): MaxInlineKeyboard`. Strips URL buttons (MAX unsupported). `denormalizeMaxMessage(msg: OutboundMessage): MaxSendParams`. Strips markdown with `stripUnsupportedMarkdown()`. Handles empty keyboard rows after URL-button removal (E006-05).
  - `/src/messenger/adapters/max/max-webhook-auth.ts` -- HMAC-based webhook signature verification for MAX (F006-01 equivalent for MAX platform).
  - `/src/messenger/adapters/max/index.ts` -- Barrel export
- **Dependencies**: M1 (Shared Kernel), M2 (Core Interfaces)
- **Acceptance criteria**:
  - MaxAdapter implements all `IMessengerAdapter` methods with zero type errors
  - `normalizeMaxMessage()` correctly maps `msg.recipient.chatId` to NormalizedMessage.chatId
  - `normalizeMaxMessage()` correctly maps `msg.sender.userId` to NormalizedMessage.userId
  - `normalizeMaxMessage()` maps `msg.link.type === 'reply'` to `replyTo: msg.link.mid`
  - `denormalizeMaxKeyboard()` strips URL buttons (U006-04): given 2 callback + 1 URL, result has 2 buttons
  - `denormalizeMaxKeyboard()` handles case where ALL buttons are URL buttons: returns `undefined` (no keyboard) instead of empty array (E006-05)
  - `denormalizeMaxMessage()` strips markdown: `"**bold** and \`code\`"` becomes `"bold and code"` (U006-05)
  - `denormalizeMaxMessage()` handles edge cases: nested markdown, unclosed markers, empty string
  - `denormalizeMaxMessage()` maps `callbackData` to MAX `payload` field (128-byte limit on MAX, but use 64-byte common limit)
  - Webhook auth verifies HMAC signature (F006-01 MAX equivalent)
  - `sendMessage()` returns `DeliveryReceipt` with `success: false` on SDK error
  - `start()` resolves within 5s; `stop()` drains within 10s
  - Sticker messages (unsupported on MAX) normalized with type `'photo'` as fallback
  - Token never in logs or metadata
- **Shift-left mitigations**:
  - F006-01: MAX webhook HMAC verification
  - F006-02: Partial normalization failure via `Result` type
  - E006-05: Empty keyboard rows after URL-button removal handled
  - E006-10: Sticker -> photo conversion for MAX
  - R006-1: SDK version pinned; HTTP fixtures recorded for integration tests
- **QCSD quality gates**:
  - HTSM Functionality: 0 errors thrown for unsupported feature fallback
  - HTSM Functionality: Capability degradation correctness (URL buttons dropped, markdown stripped)
  - HTSM Reliability: Adapter isolation from other adapters
  - HTSM Maintainability: SDK version pinned in package.json
- **Estimated complexity**: HIGH

---

## Milestone 6: Adapter Resilience -- Rate Limiter, Circuit Breaker, Retry

- **Bounded Context**: Messenger Integration
- **SPARC Phase**: Refinement (TDD)
- **Files to create**:
  - `/src/messenger/resilience/token-bucket-rate-limiter.ts` -- `TokenBucketRateLimiter implements RateLimiter`. Constructor: `(capacity: number, refillRatePerSec: number)`. Methods: `tryAcquire(): boolean`, `acquire(timeoutMs?: number): Promise<void>`, `get available(): number`. Internal: timestamp-based token calculation, async queue with timeout.
  - `/src/messenger/resilience/circuit-breaker.ts` -- `CircuitBreaker` class. States: CLOSED, OPEN, HALF_OPEN. Config: `threshold: number` (default 5), `resetMs: number` (default 30000). Methods: `execute<T>(fn: () => Promise<T>): Promise<T>`, `get state(): CircuitState`. Emits domain events: `CIRCUIT_BREAKER_OPENED`, `CIRCUIT_BREAKER_CLOSED`.
  - `/src/messenger/resilience/retry-handler.ts` -- `withRetry<T>(fn: () => Promise<T>, config: ResilienceConfig): Promise<T>`. Implements exponential backoff (1s, 2s, 4s). Skips retry on non-retryable errors (AdapterError.retryable === false). Classifies HTTP 4xx as non-retryable, 5xx as retryable.
  - `/src/messenger/resilience/message-queue.ts` -- `BoundedMessageQueue` class. Bounded capacity (default 1000 per adapter). FIFO ordering. `enqueue()`, `dequeue()`, `get depth(): number`, `get isFull(): boolean`. Drains at rate limiter pace. Emits `RATE_LIMIT_ENTERED` / `RATE_LIMIT_CLEARED` events.
  - `/src/messenger/resilience/resilient-adapter-wrapper.ts` -- `ResilientAdapterWrapper implements IMessengerAdapter`. Wraps any `IMessengerAdapter` with rate limiter + circuit breaker + retry + bounded queue. Decorator pattern preserving the port interface.
  - `/src/messenger/resilience/index.ts` -- Barrel export
- **Dependencies**: M1 (Shared Kernel), M2 (Core Interfaces)
- **Acceptance criteria**:
  - Token bucket: 30 calls to `tryAcquire()` return true, 31st returns false (U006-08)
  - Token bucket: `acquire(5000)` resolves when token becomes available after refill (U006-09)
  - Token bucket: refill accuracy within 5% tolerance at configured RPS
  - Circuit breaker: CLOSED -> OPEN after 5 consecutive failures
  - Circuit breaker: OPEN -> HALF_OPEN after 30s timeout
  - Circuit breaker: HALF_OPEN -> CLOSED after 1 success; HALF_OPEN -> OPEN after 1 failure
  - Circuit breaker: 3 failures then 2 successes keeps breaker CLOSED (threshold is 5) (R006-5)
  - Retry handler: retries 3 times with 1s, 2s, 4s delays
  - Retry handler: does NOT retry when `AdapterError.retryable === false`
  - Retry handler: classifies HTTP 4xx as non-retryable
  - Bounded queue: rejects `enqueue()` when full (capacity 1000)
  - Bounded queue: maintains FIFO ordering (F006-08 mitigation)
  - `ResilientAdapterWrapper` preserves `IMessengerAdapter` interface; callers cannot distinguish from unwrapped adapter
  - Message queue drain time: queued messages drain at configured RPS within 5% tolerance
  - Domain events emitted: `RATE_LIMIT_ENTERED` when queue starts filling, `RATE_LIMIT_CLEARED` when queue empties
  - Rate limiter metrics exported: current queue depth, tokens available, requests throttled
- **Shift-left mitigations**:
  - L006-01: Bounded queue prevents unbounded memory growth under sustained rate limiting
  - L006-02: HTTP 429 handling with Retry-After header parsing
  - L006-03: Circuit breaker half-open state behavior specified and tested
  - L006-04: Inbound rate limiting on webhook handler (defense against flood)
  - F006-08: Message ordering maintained via FIFO queue
  - E006-07: Concurrent `sendMessage` calls queued and drained without drops
- **QCSD quality gates**:
  - HTSM Reliability: Circuit breaker at 5 failures; auto-recovery
  - HTSM Reliability: Rate limiter accuracy within 5%
  - HTSM Performance: Sustain 30 msg/s per adapter without queue overflow
  - HTSM Performance: Memory < 50 MB resident per adapter idle
  - Observability: Queue depth, token count, throttle count exported as metrics
- **Estimated complexity**: HIGH

---

## Milestone 7: MCP Configuration & Server Bindings

- **Bounded Context**: Agent Execution
- **SPARC Phase**: Refinement (TDD)
- **Files to create**:
  - `/src/tool-sandbox/mcp/mcp-server-config.ts` -- `MCPServerConfig` interface with `validateMCPServerConfig()`. Validates: non-empty URL, HTTPS for SSE/HTTP transports, non-empty `exposedTools`, `requestsPerMinute > 0`, `tokenEnvVar` in allowlist.
  - `/src/tool-sandbox/mcp/mcp-config-builder.ts` -- `buildMCPConfig(tier, availableServers, userEnv): MCPConfigManifest`. Pure function. Filters servers by tier rank. Maps stdio servers to `command` field, SSE/HTTP servers to `url` field. Resolves auth tokens from `userEnv` via allowlisted `tokenEnvVar`.
  - `/src/tool-sandbox/mcp/mcp-config-manifest.ts` -- `MCPConfigManifest` interface. JSON schema matching Claude Code `--mcp-config` expected format.
  - `/src/tool-sandbox/mcp/safe-env-resolver.ts` -- `SafeEnvResolver` class. Allowlisted env vars only (`CLOUDRU_API_KEY`, `TELEGRAM_BOT_TOKEN`, `MAX_BOT_TOKEN`, etc.). `resolve(envVarName: string): Result<string, string>`. Rejects arbitrary env var names (F007-03 mitigation).
  - `/src/tool-sandbox/mcp/rate-limit-config.ts` -- `RateLimitConfig` interface with `validateRateLimitConfig()`.
  - `/src/tool-sandbox/mcp/index.ts` -- Barrel export
- **Dependencies**: M1 (Shared Kernel), M3 (Tool Sandbox Core -- `AccessTierConfig`)
- **Acceptance criteria**:
  - `buildMCPConfig()` with standard tier includes restricted + standard servers, excludes full servers (U007-08)
  - `buildMCPConfig()` with full tier includes all servers
  - `buildMCPConfig()` with restricted tier returns empty `mcpServers` object
  - `buildMCPConfig()` sets `command` field for stdio transport, `url` + `transport` for SSE (U007-09)
  - `SafeEnvResolver.resolve('DATABASE_URL')` returns error (not in allowlist) (F007-03)
  - `SafeEnvResolver.resolve('CLOUDRU_API_KEY')` returns value from env
  - `validateMCPServerConfig()` rejects empty URL, non-HTTPS SSE URL, empty `exposedTools`, `requestsPerMinute <= 0`
  - `validateRateLimitConfig()` rejects negative `requestsPerMinute`, negative `maxConcurrent`
  - `MCPConfigManifest` JSON output matches Claude Code `--mcp-config` schema
  - Edge case: two MCP servers with same tool name detected and warned (E007-06)
  - Edge case: empty MCP server list for standard tier produces no `--mcp-config` flag (E007-04)
- **Shift-left mitigations**:
  - F007-03: `SafeEnvResolver` allowlist prevents arbitrary env var injection
  - E007-04: Empty server list handled gracefully
  - E007-06: Tool name collision detection
  - Section 3.3: All MCP value object validations implemented
- **QCSD quality gates**:
  - HTSM Functionality: MCP config generation correct for all 3 tiers
  - HTSM Security: `tokenEnvVar` restricted to allowlist
  - HTSM Maintainability: Pure functions, zero I/O
- **Estimated complexity**: MEDIUM

---

## Milestone 8: Sandbox Enforcement & Workspace Isolation

- **Bounded Context**: Agent Execution
- **SPARC Phase**: Refinement (TDD)
- **Files to create**:
  - `/src/tool-sandbox/workspace/workspace-manager.ts` -- `WorkspaceManager` class. `create(userId: string, sessionId: string): Promise<WorkspacePaths>`. Creates per-user workspace at `/tmp/openclaw/workspaces/${userId}/${sessionId}/`. Subdirectories: `scratch/`, `mcp-data/`, `.session/`. Sets permissions `0o700`. Emits `WORKSPACE_CREATED` event. Per-session subdirectory prevents concurrent workspace race (X-078-2, F007-09).
  - `/src/tool-sandbox/workspace/workspace-cleanup.ts` -- `WorkspaceCleanup` class. `cleanup(sessionId: string): Promise<void>`. Removes session workspace directory. Also removes MCP config file from `/tmp/openclaw/mcp-configs/`. TTL-based cleanup for orphaned directories (F007-01, R007-5). Emits `WORKSPACE_CLEANED_UP` event.
  - `/src/tool-sandbox/workspace/mcp-config-writer.ts` -- `MCPConfigWriter` class. `write(sessionId: string, config: MCPConfigManifest): Promise<string>`. Writes to `/tmp/openclaw/mcp-configs/${sessionId}.json` with permissions `0o600`. Returns file path. Signs config with HMAC for tamper detection.
  - `/src/tool-sandbox/workspace/path-validator.ts` -- `validateWorkspacePath(path: string, rootDir: string): boolean`. Rejects `..` segments, symlinks outside root, and paths not under `rootDir`. Used by sandbox enforcement.
  - `/src/tool-sandbox/workspace/index.ts` -- Barrel export
- **Dependencies**: M1 (Shared Kernel), M3 (Tool Sandbox Core -- `SandboxConfig`)
- **Acceptance criteria**:
  - `WorkspaceManager.create()` creates correct directory structure with `0o700` permissions
  - `WorkspaceManager.create()` uses `${userId}/${sessionId}` path (not just `${userId}`) to prevent concurrent session race (F007-09, QCSD X-089-1)
  - `WorkspaceCleanup.cleanup()` removes session workspace and MCP config file
  - `WorkspaceCleanup` has TTL-based scanner for orphaned directories (files older than 1 hour)
  - `MCPConfigWriter.write()` creates file with `0o600` permissions
  - `MCPConfigWriter.write()` HMAC-signs config content
  - `validateWorkspacePath()` rejects `../../etc/passwd` (E007-07, TC-SEC-001)
  - `validateWorkspacePath()` rejects symlinks pointing outside root
  - `validateWorkspacePath()` accepts valid paths under rootDir
  - Workspace path consistent between sandbox config and tenant isolation (X-078-2 coordination)
  - Concurrent `create()` calls for same user + different sessions succeed independently (F007-09)
- **Shift-left mitigations**:
  - F007-01: MCP config file cleaned up on session end AND orphan scanner for crashes
  - F007-09: Per-session workspace subdirectory prevents concurrent creation race
  - E007-07: Path traversal prevention via `validateWorkspacePath()`
  - R007-5: TTL-based cleanup for orphaned files
  - X-078-2: Workspace path aligned with tenant isolation scheme
- **QCSD quality gates**:
  - HTSM Security: Sandbox escape resistance via path validation
  - HTSM Security: MCP config files have restricted permissions (0o600)
  - HTSM Reliability: Orphan cleanup prevents disk fill (R007-5)
  - HTSM Functionality: Workspace provisioning < 500ms
- **Estimated complexity**: MEDIUM

---

## Milestone 9: Audit Logging & Kill Switch

- **Bounded Context**: Agent Execution
- **SPARC Phase**: Refinement (TDD)
- **Files to create**:
  - `/src/tool-sandbox/audit/audit-logger.ts` -- `AuditLogger` class. `log(entry: ToolAuditEntry): Promise<void>`. Writes audit entry to storage. `logDenied(sessionId, userId, tier, toolName, reason): Promise<void>`. Fail-closed: if audit write fails, tool execution result is discarded (invariant 6). Truncates `toolInput` to max 10KB before storage. Validates `duration_ms >= 0`.
  - `/src/tool-sandbox/audit/audit-entry.ts` -- `ToolAuditEntry` interface. Includes: timestamp, sessionId, userId, tier, toolName, toolInput, toolOutput (truncated preview), duration_ms, success, error.
  - `/src/tool-sandbox/audit/audit-middleware.ts` -- `withAudit<T>(logger: AuditLogger, context: AuditContext, fn: () => Promise<T>): Promise<T>`. Wraps tool invocations. Records start time, calls fn, records end time, writes audit entry. On audit write failure: discards tool result, returns error.
  - `/src/tool-sandbox/kill-switch/kill-switch.ts` -- `KillSwitch` class. `activate(reason, activatedBy): void`. `deactivate(): void`. `get isActive(): boolean`. `get config(): KillSwitchConfig`. Emits `KILL_SWITCH_ACTIVATED` / `KILL_SWITCH_DEACTIVATED` events.
  - `/src/tool-sandbox/kill-switch/kill-switch-config.ts` -- `KillSwitchConfig` interface. `toolsKillSwitch: boolean`, `killSwitchReason?: string`, `killSwitchActivatedAt?: string` (ISO 8601 validated), `killSwitchActivatedBy?: string`.
  - `/src/tool-sandbox/audit/index.ts` -- Barrel export
  - `/src/tool-sandbox/kill-switch/index.ts` -- Barrel export
- **Dependencies**: M1 (Shared Kernel), M3 (Tool Sandbox Core)
- **Acceptance criteria**:
  - `AuditLogger.log()` writes `ToolAuditEntry` with all required fields
  - `AuditLogger.log()` truncates `toolInput` to max 10KB
  - `AuditLogger.log()` validates `duration_ms >= 0`
  - `withAudit()` records timing around tool invocations
  - `withAudit()` writes audit entry for successful tool calls with `success: true`
  - `withAudit()` writes audit entry for failed tool calls with `success: false` and error message
  - `withAudit()` on audit write failure: discards tool result, returns error (fail-closed, invariant 6)
  - `KillSwitch.activate()` sets `isActive = true`, records reason, timestamp, activator
  - `KillSwitch.activate()` emits `KILL_SWITCH_ACTIVATED` event
  - `KillSwitch.deactivate()` sets `isActive = false`, emits `KILL_SWITCH_DEACTIVATED` event
  - Kill switch `killSwitchActivatedAt` validated as ISO 8601 (E007-09-adjacent)
  - Integration with `resolveAccessTier()`: when kill switch active, all tiers resolve to restricted (tested in M3 but wired here)
  - Edge case: kill switch activated with empty reason string still functions (E007-09)
  - Audit entries for denied tool calls include reason for denial (BDD: "Denied tool calls are audited")
- **Shift-left mitigations**:
  - F007-07: Fail-closed audit logging (tool execution blocked if audit unavailable)
  - R007-6: Audit write failure does not hang tool execution; returns error immediately
  - Section 3.3: `ToolAuditEntry.toolInput` size limited; `killSwitchActivatedAt` format validated
  - Invariant 6: 100% tool invocations produce audit entries
  - Invariant 7: Kill switch supremacy enforced
- **QCSD quality gates**:
  - HTSM Reliability: Audit completeness (100% of invocations)
  - HTSM Reliability: Kill switch latency < 1s for new sessions
  - HTSM Security: Audit trail for security review
  - HTSM Compliance: Audit log retention per policy
- **Estimated complexity**: MEDIUM

---

## Milestone 10: Adapter Integration & Validation Tests

- **Bounded Context**: Messenger Integration (cross-module)
- **SPARC Phase**: Completion
- **Files to create**:
  - `/src/messenger/testing/mock-adapter.ts` -- `MockMessengerAdapter implements IMessengerAdapter`. Test helpers: `simulateMessage()`, `simulateCallback()`, `sentMessages[]`, `sentTypingIndicators[]`, `editedMessages[]`, `deletedMessages[]`. Tracks all interactions for assertion.
  - `/src/messenger/testing/fixtures.ts` -- Test message fixtures: `createTelegramTextMessage()`, `createTelegramPhotoMessage()`, `createMaxTextMessage()`, `createMaxCallbackUpdate()`, `createOutboundMessageWithKeyboard()`, `createOutboundMessageWithMarkdown()`.
  - `/tests/messenger/core/router.test.ts` -- Router unit tests: U006-06 (route to correct adapter), U006-07 (adapter isolation), handler exception boundary, dead-letter for failed delivery, multi-adapter routing
  - `/tests/messenger/adapters/telegram/telegram-normalizer.test.ts` -- U006-01, U006-02, photo with caption, sticker, contact, location, empty message rejection, attachment size validation
  - `/tests/messenger/adapters/telegram/telegram-denormalizer.test.ts` -- U006-03, text truncation at 4096, callback data byte-length, parse mode mapping
  - `/tests/messenger/adapters/max/max-normalizer.test.ts` -- MAX normalization: text, attachments, reply links, UUID chat IDs
  - `/tests/messenger/adapters/max/max-denormalizer.test.ts` -- U006-04, U006-05, URL button stripping, empty row handling, markdown stripping edge cases
  - `/tests/messenger/resilience/rate-limiter.test.ts` -- U006-08, U006-09, refill accuracy, per-chat rate limiting
  - `/tests/messenger/resilience/circuit-breaker.test.ts` -- State transitions, premature open prevention (R006-5), half-open recovery
  - `/tests/messenger/core/connection-status.test.ts` -- U006-10, all valid/invalid transitions
  - `/tests/integration/telegram-router.test.ts` -- I006-01, full inbound/outbound cycle with grammy test mode
  - `/tests/integration/max-router.test.ts` -- I006-02, full cycle with mock MAX HTTP client
  - `/tests/integration/multi-adapter-router.test.ts` -- I006-03, messages route to correct adapter
  - `/tests/integration/adapter-resilience.test.ts` -- I006-04, circuit breaker opens and recovers
  - `/tests/integration/rate-limit-queue.test.ts` -- I006-05, 50 messages burst queued and drained
- **Dependencies**: M2 (Core), M4 (Telegram), M5 (MAX), M6 (Resilience)
- **Acceptance criteria**:
  - All 10 unit test cases from shift-left report (U006-01 through U006-10) passing
  - All 5 integration test cases (I006-01 through I006-05) passing
  - `MockMessengerAdapter` covers 100% of `IMessengerAdapter` methods
  - Test fixtures cover all supported message types (text, photo, document, video, audio, voice, sticker, contact, location, callback)
  - BDD scenarios from shift-left report validated: Telegram normalization, MAX URL button stripping, markdown degradation, rate limiting queuing, circuit breaker opening, adapter isolation, message routing
  - Total test count >= 40 (matching QCSD estimate of 40-50 unit tests)
  - Test execution time < 30s for unit tests, < 60s for integration tests
- **Shift-left mitigations**:
  - All F006-* failure modes have dedicated test cases
  - All E006-* edge cases have dedicated test cases
  - All L006-* load/timeout scenarios have dedicated test cases
  - Cross-ADR contract test: adapter barrel export only exposes `IMessengerAdapter`, `IMessengerAdapterFactory`, `MessageRouter`, and value object types (section 6.5)
- **QCSD quality gates**:
  - All HTSM Functionality criteria validated by tests
  - All HTSM Reliability criteria validated by tests
  - All HTSM Security criteria validated by tests
  - HTSM Performance: normalization throughput benchmark (10,000 messages < 1s)
- **Estimated complexity**: HIGH

---

## Milestone 11: Tool Sandbox Integration & CLI Runner Modification

- **Bounded Context**: Agent Execution (cross-module)
- **SPARC Phase**: Completion
- **Files to create**:
  - `/src/tool-sandbox/tool-execution-context.ts` -- `ToolExecutionContextBuilder` class. Builder pattern: `.withTier(tier)`, `.withSandbox(sandbox)`, `.withAllowedTools(tools)`, `.withMCPServers(servers)`, `.withAuditLogger(logger)`, `.build(): ToolExecutionContext`. `build()` throws if tier or sandbox missing. Result is `Object.freeze()`-d (immutable post-construction, invariant 2).
  - `/src/tool-sandbox/cli-runner-integration.ts` -- `buildSubprocessConfig(context: ToolExecutionContext): SubprocessConfig`. Orchestrates: `resolveAccessTier()` -> `buildMCPConfig()` -> `MCPConfigWriter.write()` -> `buildClaudeCliArgs()` -> `buildToolAccessDirective()`. Single function that produces everything needed to spawn a Claude Code subprocess. Includes tier-specific `--allowed-tools` enforcement.
  - `/tests/tool-sandbox/access-tier.test.ts` -- U007-01 through U007-04, all 5 user contexts, kill switch override
  - `/tests/tool-sandbox/tool-directive.test.ts` -- U007-05 through U007-07, snapshot tests for directive strings
  - `/tests/tool-sandbox/mcp-config.test.ts` -- U007-08, U007-09, server filtering, transport mapping, env var allowlist
  - `/tests/tool-sandbox/cli-args.test.ts` -- U007-10, all tiers, MCP config path inclusion/exclusion
  - `/tests/tool-sandbox/sandbox-config.test.ts` -- Path traversal rejection, writable paths validation, memory limits
  - `/tests/tool-sandbox/kill-switch.test.ts` -- Activation, deactivation, supremacy over all tiers
  - `/tests/tool-sandbox/workspace/workspace-manager.test.ts` -- Directory creation, permissions, concurrent sessions
  - `/tests/tool-sandbox/workspace/path-validator.test.ts` -- Traversal attacks, symlink detection
  - `/tests/tool-sandbox/audit/audit-logger.test.ts` -- Entry creation, truncation, fail-closed behavior
  - `/tests/integration/tier-to-cli.test.ts` -- I007-01, full admin pipeline
  - `/tests/integration/mcp-tier-filter.test.ts` -- I007-02, standard user MCP filtering
  - `/tests/integration/kill-switch.test.ts` -- I007-03, kill switch reverts new sessions
  - `/tests/integration/session-cleanup.test.ts` -- I007-04, MCP config cleanup on session end
  - `/tests/integration/audit-log.test.ts` -- I007-05, all invocations audited including denied
- **Dependencies**: M3 (Tier Resolution), M7 (MCP Config), M8 (Workspace), M9 (Audit/Kill Switch)
- **Acceptance criteria**:
  - `ToolExecutionContextBuilder.build()` throws when tier is missing
  - `ToolExecutionContextBuilder.build()` throws when sandbox config is missing
  - Built `ToolExecutionContext` is deeply frozen (immutable)
  - `buildSubprocessConfig()` produces correct `SubprocessConfig` for all 3 tiers
  - All 10 unit test cases from shift-left report (U007-01 through U007-10) passing
  - All 5 integration test cases (I007-01 through I007-05) passing
  - BDD scenarios from shift-left report validated: anonymous restricted, authenticated standard, admin full, self-hosted full, kill switch override, MCP server filtering, sandbox enforcement, audit completeness
  - Total test count >= 50 (matching QCSD estimate of 50-60 unit tests)
  - Migration backward compatibility: restricted tier produces identical behavior to ADR-003
  - `--allowed-tools` flag ALWAYS present for restricted and standard tiers (contract test per section 6.1)
  - Standard tier `mcp__*` wildcard scoped to registered MCP servers only, not user-registered ones (F007-10)
- **Shift-left mitigations**:
  - All F007-* failure modes have dedicated test cases
  - All E007-* edge cases have dedicated test cases
  - All L007-* load/timeout scenarios documented (Docker-dependent tests marked as infrastructure-level)
  - F007-10: Standard tier `--allowed-tools` value validated to not match unregistered MCP tools
  - F007-05: Kill switch does not terminate active sessions -- behavior documented and tested
- **QCSD quality gates**:
  - HTSM Functionality: Correct tier for all 5 user contexts
  - HTSM Reliability: Sandbox immutable post-spawn; MCP fault isolation
  - HTSM Security: Cross-user workspace isolation; sandbox escape blocked
  - HTSM Maintainability: Module isolation (zero OpenClaw app imports in `@openclaw/tool-sandbox`)
  - Backward compatibility: Phase 1 deployment identical to ADR-003 behavior
- **Estimated complexity**: HIGH

---

## Milestone 12: Cross-Bounded-Context Integration -- Identity Resolution & E2E

- **Bounded Context**: Cross-cutting (Messenger Integration + Agent Execution)
- **SPARC Phase**: Completion
- **Files to create**:
  - `/src/shared-kernel/identity/platform-identity-resolver.ts` -- `PlatformIdentityResolver` class. `resolve(platform: MessengerPlatform, platformUserId: string): Promise<UserContext>`. Maps platform user IDs to OpenClaw `UserContext` with roles and API key scopes. Returns anonymous context for unknown users. This is the bridge between ADR-006 and ADR-007 flagged as the #1 cross-ADR integration risk.
  - `/src/shared-kernel/identity/tier-mapper.ts` -- `mapTenantTierToAccessTier(tenantTier: string): AccessTier`. Maps ADR-008 tier names (free/standard/premium/admin) to ADR-007 tier names (restricted/standard/full). Resolves the #1 QCSD unresolved question (tier taxonomy reconciliation).
  - `/src/messenger/core/command-interceptor.ts` -- `CommandInterceptor` class. `intercept(msg: NormalizedMessage): { isCommand: boolean; command?: string; args?: string[] }`. Detects messages starting with `/` (e.g., `/train`, `/forget`, `/config`). Routes commands to appropriate handler instead of core engine. Addresses cross-ADR risk ADR-006 x ADR-011.
  - `/tests/integration/identity-resolution.test.ts` -- Contract test: `PlatformIdentityResolver` maps (telegram, "12345") to correct `UserContext` with roles
  - `/tests/integration/tier-mapping.test.ts` -- Contract test: free->restricted, standard->standard, premium->full, admin->full (X-078-1)
  - `/tests/integration/command-interceptor.test.ts` -- Contract test: `/train` routed to training engine, regular messages to core engine
  - `/tests/integration/cross-context-e2e.test.ts` -- Full chain test: Telegram webhook -> normalize -> identity resolve -> tier resolve -> build subprocess config -> mock subprocess -> response -> denormalize -> delivery receipt
  - `/tests/integration/multi-platform-isolation.test.ts` -- Telegram user and MAX user send messages concurrently; responses route to correct adapters; no cross-contamination
- **Dependencies**: M10 (Adapter Integration), M11 (Tool Sandbox Integration)
- **Acceptance criteria**:
  - `PlatformIdentityResolver.resolve('telegram', '12345')` returns `UserContext` with correct roles for known user
  - `PlatformIdentityResolver.resolve('telegram', 'unknown')` returns anonymous `UserContext` (restricted tier)
  - `mapTenantTierToAccessTier('free')` returns `'restricted'`
  - `mapTenantTierToAccessTier('standard')` returns `'standard'`
  - `mapTenantTierToAccessTier('premium')` returns `'full'`
  - `mapTenantTierToAccessTier('admin')` returns `'full'`
  - `CommandInterceptor.intercept({ text: '/train my data' })` returns `{ isCommand: true, command: 'train', args: ['my', 'data'] }`
  - `CommandInterceptor.intercept({ text: 'Hello world' })` returns `{ isCommand: false }`
  - Full chain E2E test passes: webhook -> normalize -> identity -> tier -> subprocess config -> response -> deliver
  - Multi-platform isolation: Telegram response never sent via MAX adapter and vice versa
  - Contract tests for all 6 cross-ADR integration risks from shift-left report (section 6)
  - Total cross-context test count >= 12 (matching shift-left contract test estimate)
- **Shift-left mitigations**:
  - Cross-ADR Risk #1: Platform user identity mapped to UserContext for tier resolution
  - Cross-ADR Risk #3 (partial): Streaming adapter extension point documented (IStreamingMessengerAdapter interface stub)
  - Cross-ADR Risk #8: Command routing interceptor prevents `/train` from reaching core engine
  - X-078-1: Tier taxonomy reconciliation via `mapTenantTierToAccessTier()`
  - X-068-1 through X-068-3: Platform identity mapping consistency
  - Section 6.6 (ADR-007 x ADR-006): platformUserId -> UserContext resolution defined
- **QCSD quality gates**:
  - Full-chain E2E: Free-tier Telegram user gets restricted, no tools (QCSD E2E-1)
  - Full-chain E2E: Premium MAX user gets full tier with MCP tools (QCSD E2E-2)
  - Cross-tenant isolation: User A response never reaches User B
  - Kill switch: new session after activation resolves to restricted (QCSD E2E-4 partial)
  - All 12 contract tests from shift-left report pass
- **Estimated complexity**: HIGH

---

## Dependency Graph

```
     M1 (Shared Kernel: Types & Value Objects)
    / \
   /   \
  v     v
 M2     M3
(Core) (Tier/Sandbox Core)
 /|\      /|\
/ | \    / | \
v  v  v  v  v  v
M4 M5 M6 M7 M8 M9
(TG)(MX)(Res)(MCP)(WS)(Audit)
 \  |  /     \  |  /
  \ | /       \ | /
   vvv         vvv
   M10         M11
  (Adapter    (Sandbox
  Integration) Integration)
       \       /
        \     /
         v   v
          M12
     (Cross-Context
      Integration)
```

**Legend:**
- **M1**: Shared Kernel (Types, Value Objects, Domain Events)
- **M2**: Messenger Core (Port Interfaces, Factory, Router)
- **M3**: Tool Sandbox Core (Tier Resolution, Directives, CLI Args)
- **M4**: Telegram Adapter
- **M5**: MAX Adapter
- **M6**: Adapter Resilience (Rate Limiter, Circuit Breaker, Retry, Queue)
- **M7**: MCP Configuration & Server Bindings
- **M8**: Sandbox Enforcement & Workspace Isolation
- **M9**: Audit Logging & Kill Switch
- **M10**: Adapter Integration & Validation Tests
- **M11**: Tool Sandbox Integration & CLI Runner Modification
- **M12**: Cross-Bounded-Context Integration

---

## Parallel Execution Opportunities

| Wave | Milestones | Rationale |
|------|-----------|-----------|
| **Wave 1** | M1 | Foundation; no dependencies |
| **Wave 2** | M2, M3 | Independent bounded contexts; both depend only on M1 |
| **Wave 3** | M4, M5, M6, M7, M8, M9 | M4/M5/M6 depend on M2; M7/M8/M9 depend on M3. All six can run in parallel since the two groups are independent |
| **Wave 4** | M10, M11 | M10 integrates M4+M5+M6; M11 integrates M7+M8+M9. Both can run in parallel |
| **Wave 5** | M12 | Depends on both M10 and M11 |

**Maximum parallelism**: 6 milestones in Wave 3 (requires 6 agents or developers).

**Minimum sequential path (critical path)**: M1 -> M2 -> M4 -> M10 -> M12 (5 steps) or M1 -> M3 -> M7 -> M11 -> M12 (5 steps).

---

## Risk Register

### Critical Risks (P*I >= 12)

| ID | Risk | Source | P | I | P*I | Mitigation |
|----|------|--------|---|---|-----|------------|
| R006-4 | Webhook endpoint exposed without authentication allows message spoofing | Shift-left F006-01, QCSD R006-4 | 3 | 5 | 15 | M4/M5: Webhook signature verification middleware (Telegram secret token, MAX HMAC). Reject unsigned requests with 403 before normalization. |
| R006-1 | MAX SDK abandoned; API changes break adapter | QCSD R006-1 | 3 | 4 | 12 | M5: Pin SDK version. Record HTTP fixtures for integration tests (VCR pattern). Fork strategy documented. |
| R006-2 | Rate limit storm: 30+ users simultaneously trigger Telegram 429 | QCSD R006-2 | 3 | 4 | 12 | M6: Token bucket rate limiter + bounded message queue. Load test in M10. |
| R007-2 | MCP server returns malicious tool-calling directive in response | QCSD R007-2 | 3 | 4 | 12 | M7: Response size limit (100KB). M11: Output sanitization in audit middleware. |
| X-078-1 | Tier name mismatch between ADR-007 (restricted/standard/full) and ADR-008 (free/standard/premium/admin) | QCSD X-078-1 | 4 | 4 | 16 | M12: `mapTenantTierToAccessTier()` function with explicit mapping and unit tests. |

### High Risks (P*I 8-11)

| ID | Risk | Source | P | I | P*I | Mitigation |
|----|------|--------|---|---|-----|------------|
| R007-1 | Sandbox escape via symlink in writable workspace directory | QCSD R007-1 | 2 | 5 | 10 | M8: `validateWorkspacePath()` rejects symlinks and `..` traversal. Integration test with real filesystem. |
| R007-3 | Tier misconfiguration grants excessive access | QCSD R007-3 | 2 | 5 | 10 | M3/M11: Unit tests for all 5 user contexts x 3 tiers. `defaultAuthenticatedTier` validated against safe values. |
| X-078-2 | Workspace path templates diverge between sandbox and tenant isolation | QCSD X-078-2 | 3 | 5 | 15 | M8/M12: Single `WorkspaceManager` class as source of truth for paths. Contract test validates path consistency. |
| F007-03 | Environment variable injection via tokenEnvVar | Shift-left F007-03 | 3 | 4 | 12 | M7: `SafeEnvResolver` allowlist. Only pre-approved env var names can be resolved. |
| F007-10 | Standard tier `mcp__*` wildcard matches user-registered MCP tools | Shift-left F007-10 | 3 | 4 | 12 | M11: Replace `mcp__*` glob with explicit tool names from registered MCP servers for standard tier. |
| R007-5 | MCP config temp files not cleaned up; disk fills over time | QCSD R007-5 | 3 | 3 | 9 | M8: Session cleanup + TTL-based orphan scanner. Integration test: create 100 sessions, verify 0 orphaned files. |
| F006-03 | Message handler throws; error propagates to adapter | Shift-left F006-03 | 3 | 4 | 12 | M2: Router wraps handler calls in try/catch. Test with throwing handler. |
| F006-04 | sendMessage fails after handler succeeds; user gets no response | Shift-left F006-04 | 3 | 4 | 12 | M2: Dead-letter logging + `MESSAGE_DELIVERY_FAILED` event emission. Future: retry queue. |

### Medium Risks (P*I 4-7)

| ID | Risk | Source | P | I | P*I | Mitigation |
|----|------|--------|---|---|-----|------------|
| R006-5 | Circuit breaker opens prematurely during transient blip | QCSD R006-5 | 2 | 3 | 6 | M6: Threshold of 5 consecutive failures. Chaos test: 3 failures + 2 successes = stays closed. |
| R006-6 | Adapter stop() during processing causes message loss | QCSD R006-6 | 3 | 3 | 9 | M4/M5: Drain logic in `stop()` with 10s timeout. Test: stop during 5 in-flight messages. |
| F007-04 | Tier resolution race (role revoked during active session) | Shift-left F007-04 | 2 | 4 | 8 | M11: Document that tier is immutable per session (by design). Active session continues at original tier until completion. |
| F007-05 | Kill switch does not terminate active sessions | Shift-left F007-05 | 2 | 4 | 8 | M9: Document as known limitation. New sessions immediately restricted. Future: graceful downgrade signal to active sessions. |
| F006-06 | Long polling reconnection on network drop | Shift-left F006-06 | 3 | 3 | 9 | M4/M5: Reconnection loop with exponential backoff (5s, 10s, 30s, 60s max). |
| F006-07 | Duplicate message delivery from webhook retries | Shift-left F006-07 | 3 | 3 | 9 | M4: `TelegramDeduplicator` with TTL cache on `update_id`. |

---

## File Summary

### Source files: 42 files across 2 bounded contexts + shared kernel

```
/src/
  shared-kernel/
    types/
      messenger-platform.ts
      result.ts
      branded.ts
    value-objects/
      normalized-message.ts
      normalized-callback.ts
      outbound-message.ts
      delivery-receipt.ts
      attachment.ts
      adapter-error.ts
      adapter-config.ts
      access-tier.ts
      connection-status.ts
    events/
      messenger-events.ts
      tool-sandbox-events.ts
      event-emitter.ts
    identity/
      platform-identity-resolver.ts
      tier-mapper.ts
    index.ts
  messenger/
    core/
      adapter.interface.ts
      adapter-factory.ts
      router.ts
      messenger-connection.ts
      command-interceptor.ts
      index.ts
    adapters/
      telegram/
        telegram-adapter.ts
        telegram-normalizer.ts
        telegram-denormalizer.ts
        telegram-webhook-auth.ts
        telegram-deduplicator.ts
        index.ts
      max/
        max-adapter.ts
        max-normalizer.ts
        max-denormalizer.ts
        max-webhook-auth.ts
        index.ts
    resilience/
      token-bucket-rate-limiter.ts
      circuit-breaker.ts
      retry-handler.ts
      message-queue.ts
      resilient-adapter-wrapper.ts
      index.ts
    testing/
      mock-adapter.ts
      fixtures.ts
  tool-sandbox/
    access-tier.ts
    tool-directive.ts
    cli-args.ts
    sandbox-config.ts
    resource-quota.ts
    tool-execution-context.ts
    cli-runner-integration.ts
    mcp/
      mcp-server-config.ts
      mcp-config-builder.ts
      mcp-config-manifest.ts
      safe-env-resolver.ts
      rate-limit-config.ts
      index.ts
    workspace/
      workspace-manager.ts
      workspace-cleanup.ts
      mcp-config-writer.ts
      path-validator.ts
      index.ts
    audit/
      audit-logger.ts
      audit-entry.ts
      audit-middleware.ts
      index.ts
    kill-switch/
      kill-switch.ts
      kill-switch-config.ts
      index.ts
    index.ts
```

### Test files: 24 test files

```
/tests/
  messenger/
    core/
      router.test.ts
      connection-status.test.ts
    adapters/
      telegram/
        telegram-normalizer.test.ts
        telegram-denormalizer.test.ts
      max/
        max-normalizer.test.ts
        max-denormalizer.test.ts
    resilience/
      rate-limiter.test.ts
      circuit-breaker.test.ts
  tool-sandbox/
    access-tier.test.ts
    tool-directive.test.ts
    mcp-config.test.ts
    cli-args.test.ts
    sandbox-config.test.ts
    kill-switch.test.ts
    workspace/
      workspace-manager.test.ts
      path-validator.test.ts
    audit/
      audit-logger.test.ts
  integration/
    telegram-router.test.ts
    max-router.test.ts
    multi-adapter-router.test.ts
    adapter-resilience.test.ts
    rate-limit-queue.test.ts
    tier-to-cli.test.ts
    mcp-tier-filter.test.ts
    kill-switch.test.ts
    session-cleanup.test.ts
    audit-log.test.ts
    identity-resolution.test.ts
    tier-mapping.test.ts
    command-interceptor.test.ts
    cross-context-e2e.test.ts
    multi-platform-isolation.test.ts
```

### Estimated test count: ~120 total

| Category | Count | Source |
|----------|-------|--------|
| Unit tests (ADR-006) | ~45 | QCSD estimate: 40-50 |
| Unit tests (ADR-007) | ~55 | QCSD estimate: 50-60 |
| Integration tests (ADR-006) | ~18 | QCSD estimate: 15-20 |
| Integration tests (ADR-007) | ~22 | QCSD estimate: 20-25 |
| Cross-context contract tests | ~12 | Shift-left estimate: 12 |
| **Total** | **~152** | |

---

## External Dependencies

| Package | Version | Used By | Purpose |
|---------|---------|---------|---------|
| `grammy` | `^1.x` | M4 (Telegram Adapter) | Telegram Bot API SDK |
| `@maxhub/max-bot-api` | `^1.x` | M5 (MAX Adapter) | MAX Messenger Bot API SDK |
| `vitest` or `jest` | latest | All test files | Test runner |
| `nock` or `msw` | latest | Integration tests | HTTP mocking for MAX SDK |
| `sinon` | latest | Resilience tests | Fake timers for rate limiter / circuit breaker |
| `typescript` | `^5.x` | All source | Language |

---

## Unresolved Questions (Requiring Architecture Team Input Before M12)

These are carried forward from the QCSD report (Appendix C) and must be resolved before Milestone 12:

1. **Workspace path standardization**: ADR-007 uses `/tmp/openclaw/workspaces/${userId}`, ADR-008 uses `/var/openclaw/tenants/{tenantId}/workspace`. This plan uses `/tmp/openclaw/workspaces/${userId}/${sessionId}/` as a default but the canonical path must be agreed upon.

2. **Duplicate rate limiting**: ADR-008 `rateLimitRpm` vs ADR-009 `rateLimitRequests` per window. This plan implements rate limiting only at the adapter level (M6) and tool sandbox level (M7); pool-level rate limiting is deferred to ADR-009 implementation.

3. **Streaming adapter interface**: ADR-010 will require `IStreamingMessengerAdapter` or an `editMessage` streaming protocol. M12 stubs this interface but does not implement it.

4. **Adapter-to-pool backpressure**: When ADR-009 worker pool queue is full, how does rejection propagate back through the MessageRouter? M2 documents this as a future integration point.

5. **Webhook production failover**: Should production deployments auto-switch to long-polling on sustained webhook failures? M4/M5 implement reconnection for long-polling but webhook failover is deferred.
