> **SUPERSEDED:** This document references ADR-006..013 which were deleted during the v2 ADR rewrite (commit e54143f). ADR-001..005 v2 now cover this scope. Retained for historical context only.

# Shift-Left Testing Report: ADR-006 & ADR-007

## Level 4 -- Risk Analysis in Design Phase

**Date**: 2026-02-13
**Analyst**: QA Shift-Left Testing Agent
**Scope**: ADR-006 (Multi-Messenger Adapter Architecture), ADR-007 (Claude Code Tools & MCP Enablement)
**Adjacent ADRs Reviewed for Cross-Cutting Risks**: ADR-003, ADR-008 through ADR-013

---

# ADR-006: Multi-Messenger Adapter Architecture

## 1. Testability Assessment: Score 72/100

### Strengths (+)

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Interface mockability | 9/10 | `IMessengerAdapter` is a clean port interface. `MockMessengerAdapter` is already provided with `simulateMessage()` and `simulateCallback()` test helpers. All methods return promises, making async testing straightforward. |
| Value object immutability | 8/10 | All value objects (`NormalizedMessage`, `NormalizedCallback`, `DeliveryReceipt`, `Attachment`) use `readonly` fields and `ReadonlyArray`. This prevents mutation bugs and makes assertion-based testing reliable. |
| Factory testability | 8/10 | `IMessengerAdapterFactory` uses a registration pattern. Constructors are plain functions `(config: AdapterConfig) => IMessengerAdapter`, trivially mockable. |
| Error taxonomy | 7/10 | `AdapterErrorCode` is a union literal type, enabling exhaustive switch testing. The `retryable` boolean on `AdapterError` is testable. |
| Separation of concerns | 8/10 | Normalization (inbound), denormalization (outbound), routing, and rate limiting are separate responsibilities with distinct interfaces. |

### Weaknesses (-)

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Compile-time invariant enforcement | 5/10 | The `ConnectionStatus` state machine (`active <-> paused -> disconnected`, `rate_limited` transient) is described in prose but not enforced by the type system. Invalid transitions like `disconnected -> active` are not prevented at compile time. |
| Acceptance criteria | 4/10 | No formal acceptance criteria are defined. The capability matrix is descriptive but does not specify pass/fail criteria for each feature/platform pair. |
| Event definitions | 5/10 | Domain events are implied (message received, message sent, adapter started/stopped) but never formally declared as typed events. Event-driven testing requires explicit event types. |
| Normalization completeness | 6/10 | `NormalizedMessage.text` and `NormalizedMessage.attachments` are both optional. A message with neither text nor attachments is type-valid but semantically invalid. No validation guards this. |
| `MessageRouter` handler lifecycle | 5/10 | `onMessage` and `onCallback` on `MessageRouter` overwrite the handler each time they are called (last-write-wins). There is no guard against double-registration or missing registration before `startAll()`. |

### Testability Breakdown

- **Mockability**: 85/100 -- Excellent interface design for mock injection
- **Compile-time safety**: 55/100 -- State machines and invariants rely on runtime checks
- **Acceptance criteria clarity**: 40/100 -- Capability matrix exists but no formal BDD scenarios
- **Event testability**: 50/100 -- Events are implicit, not typed
- **Weighted total**: **72/100**

---

## 2. Missing Error Scenarios

### 2.1 Unaddressed Failure Modes

| ID | Failure Mode | Description | Risk |
|----|-------------|-------------|------|
| F006-01 | **Webhook signature verification failure** | Neither adapter mentions verifying webhook signatures (Telegram uses `X-Telegram-Bot-Api-Secret-Token`; MAX uses HMAC). An attacker can send forged webhook payloads to the webhook endpoint. | CRITICAL |
| F006-02 | **Partial normalization failure** | If `extractAttachments()` throws on a single attachment (e.g., unknown type), the entire message normalization fails. No partial-success path is defined. | HIGH |
| F006-03 | **Message handler throws** | `MessageRouter.registerAdapter` wires `adapter.onMessage(async (event) => { ... await this.messageHandler(event) ... })`. If `messageHandler` throws, the error propagates to the adapter's internal handler chain. No try/catch boundary exists in the router. | HIGH |
| F006-04 | **sendMessage fails after messageHandler succeeds** | The router calls `await adapter.sendMessage(event.chatId, response)` after getting the core engine response. If delivery fails, the user gets no response but the core engine has already processed the message. No retry or dead-letter mechanism exists at the router level. | HIGH |
| F006-05 | **Adapter start() fails for one platform** | `startAll()` uses `Promise.all()`, meaning if Telegram starts successfully but MAX fails, `Promise.all()` rejects and the success of Telegram is ambiguous. Should use `Promise.allSettled()` like `stopAll()`. | MEDIUM |
| F006-06 | **Long polling reconnection** | No reconnection strategy is defined when long polling connections drop (network interruption, server restart). The adapter might silently stop receiving messages. | MEDIUM |
| F006-07 | **Duplicate message delivery** | Telegram webhooks can deliver the same update multiple times. No deduplication mechanism (e.g., tracking `update_id`) is described. | MEDIUM |
| F006-08 | **Message ordering violation** | Under high load with rate limiting and queuing, outbound messages may arrive at the platform out of order. No sequence number or ordering guarantee is defined. | MEDIUM |
| F006-09 | **Platform API version mismatch** | Neither adapter specifies which Telegram Bot API version or MAX API version it targets. SDK upgrades may silently change behavior. | LOW |
| F006-10 | **Empty callback data** | `InlineButton.callbackData` defaults to empty string `''` in denormalization. Some platforms may reject or mishandle empty callback data. | LOW |

### 2.2 Missing Edge Cases

| ID | Edge Case | Expected Behavior | Currently Undefined |
|----|-----------|-------------------|---------------------|
| E006-01 | Message with 0 characters of text and 0 attachments | Should reject or skip | Yes -- both fields optional, no validation |
| E006-02 | Message text exactly 4096 characters (boundary) | Should deliver without truncation | Yes -- truncation logic not specified for boundary |
| E006-03 | Message text 4097 characters | Should truncate with "..." suffix per capability matrix | Yes -- truncation implementation not shown |
| E006-04 | InlineButton callback_data exceeding 64 bytes (UTF-8 multi-byte) | Should reject or truncate before sending to Telegram | Yes -- 64-byte limit is documented but not enforced in code |
| E006-05 | InlineKeyboard with URL buttons sent to MAX | Should silently drop URL buttons per capability matrix | Yes -- `filter(btn => !btn.url)` exists but if ALL buttons are URL buttons, an empty row results |
| E006-06 | Platform user sends message during adapter `stop()` | Should be handled gracefully (queue or reject) | Yes -- no drain logic shown |
| E006-07 | Concurrent `sendMessage` calls exceeding per-chat rate limit | Should queue and drain, not drop | Yes -- queue mechanism described but not shown |
| E006-08 | Attachment with `size` exceeding platform limit | Should reject document uploads exceeding 50MB on Telegram | Yes -- rejection logic not shown |
| E006-09 | `replyTo` referencing a deleted or nonexistent message | Telegram returns 400; MAX behavior unknown | Yes -- no error handling for invalid replyTo |
| E006-10 | Sticker message from Telegram (WebP) forwarded to MAX (unsupported) | Should convert to image per capability matrix | Yes -- conversion logic not defined |

### 2.3 Load/Timeout/Network Scenarios

| ID | Scenario | Missing Handling |
|----|----------|-----------------|
| L006-01 | 30+ messages/second burst to Telegram adapter | Token bucket `tryAcquire()` returns false. Queue behavior (bounded? unbounded? backpressure?) is unspecified. |
| L006-02 | Platform API returns HTTP 429 (rate limited) | Retry-After header parsing not specified. `RATE_LIMITED` error code exists but backoff strategy for 429 is not shown. |
| L006-03 | Platform API returns HTTP 502/503 (platform outage) | Circuit breaker is described (5 failures, 30s reset) but behavior during half-open state is not specified. What happens to queued messages? |
| L006-04 | Webhook endpoint receives flood of requests | No inbound rate limiting on the webhook HTTP handler. An attacker could overwhelm the adapter with forged webhook calls. |
| L006-05 | Network timeout during file upload (large attachment) | 10s default timeout is likely insufficient for 50MB file uploads to Telegram. No per-operation timeout override. |

---

## 3. DDD Invariant Enforcement

### 3.1 Aggregate Invariants -- Type System Enforcement

| Invariant | Can TypeScript Enforce? | Recommendation |
|-----------|------------------------|----------------|
| "A MessengerConnection maps exactly one (platform, platformUserId, platformChatId) tuple to one openclawUserId" | PARTIALLY. The uniqueness constraint must be enforced at the repository/database layer, not the type system. TypeScript can enforce that the fields are `readonly` (preventing mutation) but not uniqueness across instances. | Create a `ConnectionIdentity` branded type: `type ConnectionIdentity = string & { readonly __brand: unique symbol }`. Build it from `${platform}:${platformUserId}:${platformChatId}` and use it as the repository lookup key. Write a unit test that verifying the repository rejects duplicate `ConnectionIdentity` values. |
| "Connection status transitions follow: active <-> paused -> disconnected. rate_limited is transient" | NO. `ConnectionStatus` is a plain string union. Nothing prevents setting `status = 'active'` on a disconnected connection. | Encode the state machine using discriminated unions or a `transition(currentStatus, event)` pure function. Test every valid and invalid transition. |
| "Every inbound message MUST be normalized to NormalizedMessage" | PARTIALLY. The port interface signature ensures adapters return `NormalizedMessage`, but there is no runtime validation that all required fields are populated correctly. | Create a `validateNormalizedMessage(msg: NormalizedMessage): Result<NormalizedMessage, ValidationError>` function. Call it at the adapter output boundary. Unit test with all field combinations. |
| "Adapter failure MUST NOT crash other adapters or core engine" | NO compile-time enforcement. This is a runtime isolation property. | Test with a deliberately failing adapter (throws in `sendMessage`, `start`, `onMessage` handler) and assert that other adapters and the router continue operating. |
| "DeliveryReceipt MUST be returned for every sendMessage" | YES. The return type `Promise<DeliveryReceipt>` enforces this at the type level. However, if the promise rejects, no receipt is returned. | Ensure `sendMessage` implementations catch SDK errors and return `DeliveryReceipt` with `success: false` instead of throwing. Test with mocked SDK failures. |
| "Bot tokens MUST NOT appear in source code or openclaw.json" | NO compile-time enforcement. | Write a pre-commit hook test that scans for token patterns (e.g., regex matching Telegram bot tokens `\d+:[\w-]{35}`) in source and config files. Add to CI. |

### 3.2 Domain Event Gaps

The ADR describes an event flow (inbound and outbound) but does **not** define formal domain event types. The following events should be typed for event-driven testing:

```typescript
// Missing domain events that should be defined
type MessengerDomainEvent =
  | { type: 'MESSAGE_RECEIVED'; payload: NormalizedMessage }
  | { type: 'MESSAGE_SENT'; payload: DeliveryReceipt }
  | { type: 'MESSAGE_DELIVERY_FAILED'; payload: { chatId: string; error: AdapterError } }
  | { type: 'CALLBACK_RECEIVED'; payload: NormalizedCallback }
  | { type: 'ADAPTER_STARTED'; payload: { platform: MessengerPlatform } }
  | { type: 'ADAPTER_STOPPED'; payload: { platform: MessengerPlatform } }
  | { type: 'ADAPTER_ERROR'; payload: AdapterError }
  | { type: 'RATE_LIMIT_ENTERED'; payload: { platform: MessengerPlatform; chatId?: string } }
  | { type: 'RATE_LIMIT_CLEARED'; payload: { platform: MessengerPlatform } }
  | { type: 'CIRCUIT_BREAKER_OPENED'; payload: { platform: MessengerPlatform } }
  | { type: 'CIRCUIT_BREAKER_CLOSED'; payload: { platform: MessengerPlatform } };
```

Without these, testing the event flow requires inspecting side effects (sent messages, console logs) rather than asserting on emitted events.

### 3.3 Value Object Validation Gaps

| Value Object | Missing Validation | Test Needed |
|-------------|-------------------|-------------|
| `NormalizedMessage` | No check that at least `text` or `attachments` is present | `should reject NormalizedMessage with neither text nor attachments` |
| `NormalizedMessage.id` | No UUID format validation | `should validate NormalizedMessage.id is a valid UUID v4` |
| `NormalizedMessage.timestamp` | No future-date rejection | `should reject NormalizedMessage with timestamp in the future` |
| `InlineButton.callbackData` | No byte-length validation (max 64 bytes) | `should reject InlineButton with callbackData exceeding 64 bytes` |
| `InlineButton` | No check that at least one of `callbackData` or `url` is present | `should reject InlineButton with neither callbackData nor url` |
| `Attachment.size` | No per-platform limit validation at creation time | `should reject Attachment with size exceeding platform limit` |
| `OutboundMessage` | No check that at least `text` or `attachments` is present | `should reject OutboundMessage with neither text nor attachments` |
| `AdapterConfig.token` | No empty-string check | `should reject AdapterConfig with empty token` |
| `AdapterConfig.webhookUrl` | No URL format validation when transport is 'webhook' | `should reject webhook transport with missing webhookUrl` |

---

## 4. Missing Acceptance Criteria

### 4.1 BDD Scenarios Needed

```gherkin
Feature: Telegram Message Normalization

  Scenario: Normalize a plain text message from Telegram
    Given a raw Telegram update with message text "Hello world"
    And the message is from user ID 12345 in chat ID 67890
    When the TelegramAdapter normalizes the message
    Then the NormalizedMessage.text should be "Hello world"
    And the NormalizedMessage.platform should be "telegram"
    And the NormalizedMessage.userId should be "12345"
    And the NormalizedMessage.chatId should be "67890"
    And the NormalizedMessage.id should be a valid UUID

  Scenario: Normalize a photo message with caption from Telegram
    Given a raw Telegram update with a photo attachment
    And the message caption is "Check this out"
    When the TelegramAdapter normalizes the message
    Then the NormalizedMessage.text should be "Check this out"
    And the NormalizedMessage.attachments should contain 1 attachment
    And the attachment type should be "photo"

  Scenario: Drop URL buttons when sending keyboard to MAX
    Given an OutboundMessage with a keyboard containing 2 callback buttons and 1 URL button
    When the MaxAdapter denormalizes the keyboard
    Then the resulting keyboard should contain 2 buttons
    And no button should have a URL property

  Scenario: Graceful degradation of markdown on MAX
    Given an OutboundMessage with text "**bold** and `code`"
    When the MaxAdapter sends the message
    Then the delivered text should be "bold and code"

  Scenario: Rate limiting queues messages instead of dropping them
    Given the TelegramAdapter rate limiter has 0 available tokens
    When sendMessage is called
    Then the message should be queued
    And when a token becomes available
    Then the queued message should be delivered

  Scenario: Circuit breaker opens after 5 consecutive failures
    Given the Telegram API has failed 5 consecutive times
    When a new sendMessage is attempted
    Then the circuit breaker should be OPEN
    And the call should fail immediately without contacting the API
    And the AdapterError code should be "PLATFORM_ERROR"

  Scenario: Adapter isolation during platform outage
    Given the TelegramAdapter is in CIRCUIT_BREAKER_OPEN state
    When a message arrives on the MaxAdapter
    Then the MaxAdapter should process it normally
    And the core engine should receive the normalized message

  Scenario: Message routing returns response through originating adapter
    Given a NormalizedMessage arrived through the TelegramAdapter
    When the core engine returns an OutboundMessage
    Then the response should be sent through the TelegramAdapter
    And NOT through the MaxAdapter
```

### 4.2 Undefined Integration Contracts

| Contract | Between | What Is Missing |
|----------|---------|-----------------|
| Adapter <-> Core Engine response format | `IMessengerAdapter.onMessage` handler <-> `agent-runner.ts` | The handler signature is `(msg: NormalizedMessage) => Promise<void>` but the MessageRouter expects `(msg: NormalizedMessage) => Promise<OutboundMessage>`. These signatures are inconsistent. The router handles the outbound response, but the port interface does not reflect this. |
| Adapter <-> Streaming pipeline (ADR-010) | `IMessengerAdapter.sendMessage` <-> `ResponseStream` | ADR-010 defines streaming responses with progressive `editMessageText` calls. `IMessengerAdapter.sendMessage` returns a single `DeliveryReceipt`. There is no `sendMessageChunk` or `updateMessage` method in the port interface for streaming. |
| Adapter <-> Session isolation (ADR-008) | `NormalizedMessage.userId/chatId` <-> `UserTenant` resolution | The mapping from `(platform, platformChatId)` to `UserTenant` is implied by the session identity invariant but no formal resolution function or contract is specified. |
| Adapter <-> User training (ADR-011) | Chat commands (e.g., `/train`, `/forget`) <-> `NormalizedMessage` | Commands arrive as `NormalizedMessage.text` starting with `/`. There is no mechanism for the adapter to distinguish commands from regular messages or for the router to intercept commands before they reach the core engine. |
| Rate limiter <-> Observability | `RateLimiter` <-> metrics/monitoring | No metrics export (current queue depth, tokens available, requests throttled) is defined. Monitoring rate limiter behavior in production is impossible without this. |

---

## 5. Pre-Implementation Tests

### 5.1 Unit Tests (Write BEFORE Implementation)

| # | Test Name | File | What It Validates |
|---|-----------|------|-------------------|
| U006-01 | `TelegramNormalizer: should normalize plain text message to NormalizedMessage` | `tests/adapters/telegram/telegram-normalizer.test.ts` | Given a raw Telegram `Update` with `message.text`, produce a `NormalizedMessage` with correct `platform`, `chatId`, `userId`, `text`, `timestamp`. Assert `id` is a valid UUIDv4. |
| U006-02 | `TelegramNormalizer: should extract photo attachment with fileId and size` | `tests/adapters/telegram/telegram-normalizer.test.ts` | Given a Telegram `Update` with `message.photo[]`, extract the largest photo size as an `Attachment` with `type: 'photo'`, `fileId`, `size`. |
| U006-03 | `TelegramDenormalizer: should convert InlineKeyboard with URL buttons to Telegram format` | `tests/adapters/telegram/telegram-denormalizer.test.ts` | Given an `InlineKeyboard` with both callback and URL buttons, produce a Telegram-native `InlineKeyboardMarkup` with both button types preserved. |
| U006-04 | `MaxDenormalizer: should strip URL buttons from InlineKeyboard` | `tests/adapters/max/max-denormalizer.test.ts` | Given an `InlineKeyboard` with mixed callback and URL buttons, produce a MAX-native keyboard with only callback buttons. Assert URL buttons are dropped. |
| U006-05 | `MaxDenormalizer: should strip markdown from outbound text` | `tests/adapters/max/max-denormalizer.test.ts` | Given `"**bold** and \`code\`"`, produce `"bold and code"`. Test edge cases: nested markdown, unclosed markers, empty string. |
| U006-06 | `MessageRouter: should route inbound message to correct handler and send response via originating adapter` | `tests/core/router.test.ts` | Register a mock adapter and a message handler that returns an `OutboundMessage`. Simulate a message. Assert the response was sent via `mockAdapter.sendMessage()` with the correct `chatId`. |
| U006-07 | `MessageRouter: should isolate adapter errors -- one adapter failure does not affect another` | `tests/core/router.test.ts` | Register two mock adapters. Make adapter A's `onError` fire. Assert adapter B's message processing continues unaffected. |
| U006-08 | `TokenBucketRateLimiter: should allow requests up to capacity and then reject` | `tests/core/rate-limiter.test.ts` | Create a token bucket with capacity 30 and refill rate 30/sec. Call `tryAcquire()` 30 times (all should return true). Call once more (should return false). Advance time by 1 second. Call again (should return true). |
| U006-09 | `TokenBucketRateLimiter: acquire() should resolve when token becomes available` | `tests/core/rate-limiter.test.ts` | Drain all tokens. Call `acquire(5000)`. Advance time by refill interval. Assert the promise resolves before timeout. |
| U006-10 | `ConnectionStatus state machine: should reject invalid transitions` | `tests/core/connection-status.test.ts` | Assert: `transition('disconnected', 'activate')` throws. `transition('active', 'pause')` returns `'paused'`. `transition('paused', 'disconnect')` returns `'disconnected'`. `transition('active', 'rate_limit')` returns `'rate_limited'`. `transition('rate_limited', 'clear')` returns `'active'`. |

### 5.2 Integration Tests

| # | Test Name | File | What It Validates |
|---|-----------|------|-------------------|
| I006-01 | `TelegramAdapter + MessageRouter: full inbound/outbound cycle with mock Telegram API` | `tests/integration/telegram-router.test.ts` | Use grammy's test mode (`bot.api.config.use(...)`) to mock the Telegram API. Wire a `TelegramAdapter` to a `MessageRouter`. Simulate an incoming webhook payload. Assert that the core engine handler receives a `NormalizedMessage` and the response `OutboundMessage` is sent back via the Telegram API with correct `chat_id` and `parse_mode`. |
| I006-02 | `MaxAdapter + MessageRouter: full inbound/outbound cycle with mock MAX API` | `tests/integration/max-router.test.ts` | Mock the MAX HTTP client. Wire a `MaxAdapter` to a `MessageRouter`. Simulate a long-polling update. Assert normalization and denormalization are correct. Verify that URL buttons are dropped and markdown is stripped. |
| I006-03 | `MessageRouter with both adapters: messages route to correct adapter based on platform` | `tests/integration/multi-adapter-router.test.ts` | Register both Telegram and MAX mock adapters. Simulate a Telegram message and a MAX message. Assert each response goes through the correct adapter. Assert neither adapter receives the other's response. |
| I006-04 | `Adapter resilience: circuit breaker opens after consecutive failures and auto-recovers` | `tests/integration/adapter-resilience.test.ts` | Mock the Telegram API to fail 5 times, then succeed. Assert the circuit breaker opens on failure 5, rejects immediate calls, enters half-open after 30s (use fake timers), and closes after one success. |
| I006-05 | `Adapter rate limiter: high-throughput message burst is queued and drained without drops` | `tests/integration/rate-limit-queue.test.ts` | Send 50 `sendMessage` calls in rapid succession to an adapter with 30 tokens/sec capacity. Assert all 50 messages are eventually delivered (not dropped). Assert delivery order matches send order. |

### 5.3 E2E Test Scenarios

| # | Scenario | Environment | What It Validates |
|---|----------|-------------|-------------------|
| E2E-006-01 | **User sends text message on Telegram, receives agent response, presses inline button, receives callback response** | Staging bot token, real Telegram API, mock core engine | Full lifecycle: webhook receive -> normalize -> route -> core engine -> denormalize -> Telegram send -> callback receive -> normalize -> route -> core engine -> response. Assert all messages appear in the Telegram chat. Assert delivery receipts are generated. |
| E2E-006-02 | **Concurrent users on Telegram and MAX send messages simultaneously, both receive correct responses** | Both staging bot tokens, real APIs, mock core engine | Assert platform isolation: Telegram user's response does not leak to MAX user. Assert both responses arrive within 10 seconds. Assert no adapter crashes. |

---

## 6. Cross-ADR Integration Risks

### 6.1 ADR-006 x ADR-010 (Streaming Response Pipeline) -- HIGH RISK

**Problem**: `IMessengerAdapter.sendMessage()` returns a single `DeliveryReceipt`. ADR-010 requires progressive message updates (typing indicator -> initial message -> multiple `editMessageText` calls -> final message). The adapter port interface has no concept of streaming.

**Impact**: When ADR-010 is implemented, it will need to call `sendTypingIndicator()`, then `sendMessage()` for the first chunk, then `editMessage()` repeatedly. This logic will either (a) live in the `MessageRouter`, coupling it to streaming semantics, or (b) require a new `IStreamingMessengerAdapter` interface, breaking the clean port abstraction.

**Contract test needed**: `StreamingRouter should call sendTypingIndicator, then sendMessage for first chunk, then editMessage for subsequent chunks, and never call editMessage before sendMessage`.

### 6.2 ADR-006 x ADR-008 (Multi-Tenant Session Isolation) -- HIGH RISK

**Problem**: `NormalizedMessage` carries `userId` and `chatId` as plain strings. ADR-008's `UserTenant` aggregate needs to resolve these to a tenant workspace. The resolution logic (lookup or create tenant from platform + chatId) is not defined in either ADR.

**Impact**: Without a formal contract, the mapping between `NormalizedMessage` and `UserTenant` will be implemented ad-hoc, potentially allowing cross-tenant message routing.

**Contract test needed**: `TenantResolver should map (platform, chatId) to exactly one UserTenant, and reject unknown platforms`.

### 6.3 ADR-006 x ADR-009 (Concurrent Request Processing) -- MEDIUM RISK

**Problem**: ADR-009 replaces `serialize: true` with a worker pool. Multiple messages from different users may arrive concurrently. The `MessageRouter` handles each message sequentially within the `onMessage` callback, but if the core engine handler is async (which it is), multiple handler invocations may run concurrently. The router has no concurrency control.

**Impact**: Concurrent messages from the same chat could be processed out of order, or two responses could be sent in reverse order.

**Contract test needed**: `MessageRouter should process messages from the same chatId sequentially, and messages from different chatIds concurrently`.

### 6.4 ADR-006 x ADR-011 (User Training via Messenger) -- MEDIUM RISK

**Problem**: ADR-011 defines chat commands (`/train`, `/forget`, `/style`, etc.) that arrive as regular `NormalizedMessage.text` values. The `MessageRouter` dispatches all messages to the same `messageHandler`. There is no command routing layer between the adapter and the core engine.

**Impact**: Training commands will be sent to the LLM agent instead of the training engine, unless a command interceptor is added. This interceptor needs to be defined as a cross-cutting contract.

**Contract test needed**: `CommandInterceptor should route messages starting with /train to TrainingEngine and messages starting with /forget to TrainingEngine, and all other messages to the core engine handler`.

### 6.5 ADR-006 x ADR-012 (Modular Plugin Architecture) -- LOW RISK

**Problem**: ADR-012 declares `@openclaw/messenger-adapters` as an independent npm package. ADR-006 defines the module boundary but does not define the public API contract (what is exported, what is internal).

**Impact**: Without a formal public API surface, other packages may import internal adapter classes directly, creating tight coupling that defeats the modular architecture.

**Contract test needed**: `@openclaw/messenger-adapters barrel export should expose only IMessengerAdapter, IMessengerAdapterFactory, MessageRouter, and value object types. Internal classes (TelegramAdapter, MaxAdapter) should not be exported directly`.

### 6.6 ADR-006 x ADR-013 (Cloud.ru AI Fabric Agent Integration) -- LOW RISK

**Problem**: ADR-013 introduces external agent providers that may need to send messages to users proactively (e.g., async task completion notifications). `IMessengerAdapter.sendMessage()` requires a `chatId`, but external agents operate outside the message-response cycle and may not have the user's `chatId` in context.

**Contract test needed**: `ProactiveMessageService should resolve userId to active MessengerConnection(s) and send message through the correct adapter`.

---

## 7. Defect Prevention Recommendations

### 7.1 Architectural Patterns

| Pattern | Prevents | Implementation |
|---------|----------|----------------|
| **Branded types for platform IDs** | Mixing up `chatId` and `userId`, or passing a Telegram chat ID to the MAX adapter | `type TelegramChatId = string & { __brand: 'TelegramChatId' }; type MaxChatId = string & { __brand: 'MaxChatId' };` Use these in adapter-specific code and use `string` only in normalized interfaces. |
| **Result type instead of exceptions** | `sendMessage` throwing unhandled errors that crash the router | `type SendResult = { ok: true; receipt: DeliveryReceipt } | { ok: false; error: AdapterError }`. Forces callers to handle failure. |
| **State machine as pure function** | Invalid `ConnectionStatus` transitions | `function transition(current: ConnectionStatus, event: ConnectionEvent): ConnectionStatus | null`. Returns `null` for invalid transitions. Fully unit-testable. |
| **Webhook signature middleware** | Forged webhook payloads from attackers | Verify `X-Telegram-Bot-Api-Secret-Token` header for Telegram. Verify HMAC signature for MAX. Reject unsigned requests before normalization. |
| **Idempotency key on inbound messages** | Duplicate message processing from webhook retries | Track `(platform, platformMessageId)` in a TTL cache (5 minutes). Skip processing if the key was already seen. |
| **Bounded message queue** | Unbounded memory growth under sustained rate limiting | Set a max queue depth per adapter (e.g., 1000 messages). When exceeded, drop oldest or reject new messages with backpressure signal. |

### 7.2 Runtime Validations

| Validation | Where | What |
|-----------|-------|------|
| `NormalizedMessage` must have text or attachments | Adapter output boundary (after normalization) | `assert(msg.text || (msg.attachments && msg.attachments.length > 0), 'Empty message')` |
| `InlineButton.callbackData` must be <= 64 bytes | `TelegramDenormalizer` before sending | `assert(Buffer.byteLength(btn.callbackData ?? '', 'utf8') <= 64)` |
| `OutboundMessage.text` must be <= 4096 characters | Both adapters before sending | Truncate to 4093 characters + "..." if exceeded |
| `Attachment.size` must be within platform limit | Adapter-specific, before upload | Telegram: reject if > 50MB (document) or > 10MB (photo). MAX: reject if > 256MB. |
| `AdapterConfig.token` must be non-empty | `AdapterFactory.create()` | `assert(config.token.trim().length > 0, 'Bot token is required')` |
| Webhook URL must be HTTPS | `AdapterConfig` validation | `assert(config.webhookUrl?.startsWith('https://'), 'Webhook URL must be HTTPS')` |
| Platform response status codes | Every SDK call wrapper | Log and classify HTTP 4xx (client error, do not retry) vs 5xx (server error, retry per resilience config) |

---
---

# ADR-007: Claude Code Tools & MCP Enablement

## 1. Testability Assessment: Score 78/100

### Strengths (+)

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Tier resolution testability | 9/10 | `resolveAccessTier()` is a pure function with clear inputs (`UserContext`, `InstanceConfig`) and deterministic output (`AccessTierConfig`). Every code path is trivially unit-testable. |
| Tool directive generation | 9/10 | `buildToolAccessDirective()` is a pure function mapping tier to string. Easy to snapshot-test. |
| MCP config generation | 8/10 | `buildMCPConfig()` is a pure function filtering servers by tier rank. Clear input/output contract. |
| CLI args construction | 8/10 | `buildClaudeCliArgs()` is a pure function. Output is a structured object, not raw string interpolation. |
| Kill switch testability | 9/10 | Kill switch is a simple boolean check that overrides all other logic. Testing requires only toggling the flag and asserting that all tiers resolve to `restricted`. |
| Audit logging | 7/10 | `ToolAuditEntry` is well-typed. But audit completeness (invariant 6) is a runtime property that requires integration tests. |

### Weaknesses (-)

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Sandbox enforcement testability | 4/10 | `SandboxConfig` defines the desired state (filesystem paths, network rules, resource limits) but enforcement is delegated to Docker/gVisor. Testing requires actual container orchestration or a mock sandbox runtime. No mock sandbox interface is defined. |
| MCP server health checking | 3/10 | No health check mechanism for MCP servers is defined. A misconfigured or unreachable MCP server will only fail at runtime when Claude Code tries to use it. |
| Tier escalation prevention | 5/10 | The invariant "tier escalation requires a new session" is enforced by sandbox immutability, but no mechanism prevents the Claude Code subprocess from modifying its own `--allowed-tools` or `--mcp-config` files at runtime. |
| Rate limit enforcement testability | 5/10 | `RateLimitConfig` defines limits but no rate limiter implementation is shown. Testing depends on an unspecified implementation. |
| `UserContext` definition | 4/10 | The `UserContext` type is referenced but never defined. Fields like `roles`, `apiKeyScopes`, `authenticated` are mentioned in `resolveAccessTier()` but their types, sources, and validation are unknown. |

### Testability Breakdown

- **Pure function testability**: 92/100 -- Core logic is pure functions
- **Sandbox testability**: 35/100 -- OS-level enforcement, no mock interface
- **Integration testability**: 65/100 -- MCP config generation is testable but MCP server health is not
- **Security invariant testability**: 70/100 -- Kill switch and tier resolution are testable; sandbox escape is not
- **Weighted total**: **78/100**

---

## 2. Missing Error Scenarios

### 2.1 Unaddressed Failure Modes

| ID | Failure Mode | Description | Risk |
|----|-------------|-------------|------|
| F007-01 | **MCP config file not cleaned up on session crash** | `buildClaudeCliArgs()` writes a temporary JSON file at `/tmp/openclaw/mcp-configs/${sessionId}.json`. If the session crashes, this file persists with auth tokens in env vars. No cleanup-on-crash mechanism is defined. | CRITICAL |
| F007-02 | **`--dangerously-skip-permissions` bypasses all Claude Code safety** | The `base` args in `buildClaudeCliArgs()` always include `--dangerously-skip-permissions`. This flag disables Claude Code's built-in permission prompts. Combined with `full` tier, this means the subprocess has unrestricted tool access without any interactive confirmation. | CRITICAL |
| F007-03 | **Environment variable injection via `tokenEnvVar`** | `MCPServerConfig.auth.tokenEnvVar` is a string that resolves to `userEnv[server.auth.tokenEnvVar]`. If an attacker can control `tokenEnvVar` (e.g., via custom MCP server config), they can read arbitrary environment variables by setting `tokenEnvVar` to names like `DATABASE_URL` or `ADMIN_TOKEN`. | HIGH |
| F007-04 | **Tier resolution race condition** | If a user's role changes (e.g., admin revokes access) while a session is active, the sandbox remains at the original tier due to immutability. The user retains elevated access until the session expires. | HIGH |
| F007-05 | **Kill switch does not terminate active sessions** | When the kill switch is activated, `resolveAccessTier()` returns `restricted` for NEW sessions. Active sessions with `full` tier continue operating with all tools available. | HIGH |
| F007-06 | **MCP server returns oversized payload** | No response size limit enforcement is defined in the MCP config generation. A malicious or buggy MCP server could return multi-GB responses. | MEDIUM |
| F007-07 | **Audit log write failure** | If the audit log database is unavailable, tool invocations may either fail (blocking user) or proceed without logging (violating invariant 6). No fallback strategy (e.g., buffer to file, fail-open vs fail-closed) is defined. | MEDIUM |
| F007-08 | **`--allowed-tools ''` behavior is undefined** | For the `restricted` tier, `toolArgs` is `['--allowed-tools', '']`. The behavior of Claude Code CLI with an empty string for `--allowed-tools` is not documented. It may allow all tools or throw an error. | MEDIUM |
| F007-09 | **Workspace directory creation race** | If two sessions for the same user start simultaneously, both attempt to create `/tmp/openclaw/workspaces/${userId}`. The second `mkdir` may fail or create unexpected state. | MEDIUM |
| F007-10 | **Standard tier allows `mcp__*` wildcard** | The `--allowed-tools` value for standard tier is `'mcp__*,WebSearch,WebFetch'`. The `mcp__*` glob matches ALL MCP tools, including those from user-registered MCP servers that bypass the `minimumTier` check. | HIGH |

### 2.2 Missing Edge Cases

| ID | Edge Case | Expected Behavior | Currently Undefined |
|----|-----------|-------------------|---------------------|
| E007-01 | User has both `admin` role AND `tools` API key scope | Should resolve to `full` (admin takes precedence) | Yes -- works by code ordering, not by explicit priority rule |
| E007-02 | `instanceConfig.selfHosted` is `true` but user is anonymous | Should resolve to `full` per code, but security implication is that anonymous users on self-hosted get full tool access | Yes -- potentially dangerous, no explicit check |
| E007-03 | `instanceConfig.defaultAuthenticatedTier` set to `'full'` | Authenticated users get `full` tier via config. This bypasses the intended gradual rollout. | Yes -- no validation that config values are within safe bounds |
| E007-04 | MCP server list is empty for standard tier | `buildClaudeCliArgs()` skips `--mcp-config` but still sets `--allowed-tools 'mcp__*,WebSearch,WebFetch'`. Claude Code will have MCP tool patterns allowed but no MCP servers configured. | Yes -- unclear if this causes errors or is silently ignored |
| E007-05 | Session wall-time timeout fires during an MCP server call | The MCP call may be interrupted mid-operation (e.g., mid-database-write for PostgreSQL MCP). No transactional rollback. | Yes -- no graceful interruption protocol |
| E007-06 | Two MCP servers expose tools with the same name | `MCPConfigManifest.mcpServers` is keyed by `server.id`, but if two servers expose a tool named `search`, Claude Code may route to the wrong one. | Yes -- no collision detection |
| E007-07 | `SandboxConfig.filesystem.rootDir` contains path traversal (`../../etc`) | Could allow filesystem escape if not validated | Yes -- no path sanitization shown |
| E007-08 | User's API key is revoked between tier resolution and tool execution | Tier is immutable post-spawn, so the revoked key's tier persists | Yes -- same as F007-04 |
| E007-09 | Kill switch activated with reason of 0 characters | `killSwitchReason` is optional string. Admin UI may show blank reason. | Minor -- UX issue |
| E007-10 | `ResourceQuota` mentioned in aggregate diagram but never defined | Referenced as a value object but no interface or validation exists | Yes -- no type definition in the ADR |

### 2.3 Load/Timeout/Network Scenarios

| ID | Scenario | Missing Handling |
|----|----------|-----------------|
| L007-01 | 100 users simultaneously creating sessions (100 Docker containers) | Docker container startup time (~500ms-2s each) is not accounted for. Spawning 100 containers in parallel may exhaust host resources. No container pool or warm-start strategy. |
| L007-02 | MCP server timeout during tool call | Per-user `RateLimitConfig.maxConcurrent` limits concurrent calls, but timeout for individual MCP calls is not specified. Claude Code's internal timeout may differ from the sandbox's `maxWallTimeSeconds`. |
| L007-03 | Audit log write throughput under high concurrency | With 100 concurrent sessions each making tool calls, the audit log table receives hundreds of writes/second. No batching or async write strategy. |
| L007-04 | MCP server DNS resolution failure | `MCPServerConfig.url` may contain a hostname that fails DNS resolution. No fallback or timeout-on-connect specified. |
| L007-05 | Docker daemon unresponsive | If the Docker daemon hangs, all session creation blocks indefinitely. No health check for the container runtime. |

---

## 3. DDD Invariant Enforcement

### 3.1 Aggregate Invariants -- Type System Enforcement

| Invariant | Can TypeScript Enforce? | Recommendation |
|-----------|------------------------|----------------|
| "ToolExecutionContext MUST have a resolved AccessTier before any tool execution occurs" | PARTIALLY. TypeScript can make the constructor require an `AccessTierConfig` parameter. But the invariant that resolution happens BEFORE spawn is a temporal constraint. | Use a builder pattern: `ToolExecutionContextBuilder.withTier(tier).withSandbox(sandbox).build()`. The `build()` method validates all required fields. Test: `should throw when building ToolExecutionContext without tier`. |
| "SandboxConfig MUST be immutable once subprocess is spawned" | YES, with `Readonly<SandboxConfig>` and `Object.freeze()`. But deep immutability of nested objects (`filesystem`, `network`, `resources`) requires recursive freezing. | Use `DeepReadonly<SandboxConfig>` type utility. Test: `should not allow mutation of sandbox config after creation`. |
| "AllowedTools is deny-by-default" | PARTIALLY. The type `AllowedTools[]` is an allowlist, but the enforcement depends on the `--allowed-tools` flag being correctly passed to Claude Code. If the flag is missing (bug in `buildClaudeCliArgs`), Claude Code defaults to allowing all tools. | Test: `buildClaudeCliArgs for restricted tier should include --allowed-tools with empty string`. `buildClaudeCliArgs for standard tier should include --allowed-tools with specific tool list`. |
| "Sandbox violation MUST terminate subprocess" | NO compile-time enforcement. This is an OS-level runtime property. | Integration test with Docker: write a test that starts a sandboxed subprocess, attempts to write outside `writablePaths`, and asserts the container is killed. |
| "MCP fault isolation -- failures scoped to single ToolExecutionContext" | NO compile-time enforcement. Depends on per-session MCP server instances. | Test: `should isolate MCP server crash to single session -- other sessions continue`. Requires multi-session integration test. |
| "Audit completeness -- every tool invocation produces a ToolAuditEntry" | NO compile-time enforcement. Must be tested with instrumentation. | Wrapper test: `should produce audit entry for successful tool call`. `should produce audit entry for failed tool call`. `should produce audit entry when tool is denied by tier`. |
| "Kill switch supremacy -- all sessions resolve to restricted when active" | YES, testable as a pure function. | Test: `resolveAccessTier should return restricted for admin user when kill switch is active`. `resolveAccessTier should return restricted for self-hosted instance when kill switch is active`. |

### 3.2 Domain Event Gaps

The ADR does not define domain events. The following should be formally typed:

```typescript
type ToolSandboxDomainEvent =
  | { type: 'TIER_RESOLVED'; payload: { userId: string; tier: AccessTierConfig } }
  | { type: 'SANDBOX_CREATED'; payload: { sessionId: string; config: SandboxConfig } }
  | { type: 'TOOL_INVOKED'; payload: ToolAuditEntry }
  | { type: 'TOOL_DENIED'; payload: { sessionId: string; toolName: string; tier: string; reason: string } }
  | { type: 'MCP_SERVER_CONNECTED'; payload: { sessionId: string; serverId: string } }
  | { type: 'MCP_SERVER_FAILED'; payload: { sessionId: string; serverId: string; error: string } }
  | { type: 'SANDBOX_VIOLATION'; payload: { sessionId: string; violation: string } }
  | { type: 'SESSION_TERMINATED'; payload: { sessionId: string; reason: string } }
  | { type: 'KILL_SWITCH_ACTIVATED'; payload: KillSwitchConfig }
  | { type: 'KILL_SWITCH_DEACTIVATED'; payload: { deactivatedBy: string } }
  | { type: 'WORKSPACE_CREATED'; payload: { userId: string; path: string } }
  | { type: 'WORKSPACE_CLEANED_UP'; payload: { userId: string; path: string } };
```

### 3.3 Value Object Validation Gaps

| Value Object | Missing Validation | Test Needed |
|-------------|-------------------|-------------|
| `AccessTierConfig.tier` | No runtime validation beyond type narrowing | `should reject unknown tier string at runtime (e.g., from JSON parse)` |
| `MCPServerConfig.url` | No URL format validation for SSE/HTTP; no command existence check for stdio | `should reject MCPServerConfig with empty url` and `should reject MCPServerConfig with non-https url for SSE transport` |
| `MCPServerConfig.exposedTools` | No check for empty array | `should reject MCPServerConfig with zero exposedTools` |
| `MCPServerConfig.rateLimit.requestsPerMinute` | No check for negative or zero values | `should reject RateLimitConfig with requestsPerMinute <= 0` |
| `SandboxConfig.filesystem.rootDir` | No path traversal prevention | `should reject rootDir containing '..' segments` |
| `SandboxConfig.filesystem.writablePaths` | No check that writable paths are under rootDir | `should reject writablePaths outside rootDir` |
| `SandboxConfig.network.allowedDomains` | No wildcard validation | `should validate that domain wildcards are only prefix (e.g., '*.example.com', not 'example.*.com')` |
| `SandboxConfig.resources.maxMemoryMB` | No lower/upper bound check | `should reject maxMemoryMB of 0 or negative` and `should reject maxMemoryMB exceeding host capacity` |
| `ToolAuditEntry.toolInput` | No size limit | `should truncate toolInput to max 10KB before storage` |
| `KillSwitchConfig.killSwitchActivatedAt` | ISO 8601 format not validated | `should reject non-ISO-8601 timestamp in killSwitchActivatedAt` |

---

## 4. Missing Acceptance Criteria

### 4.1 BDD Scenarios Needed

```gherkin
Feature: Access Tier Resolution

  Scenario: Anonymous user gets restricted tier
    Given an unauthenticated user context
    And a multi-tenant instance configuration
    When the access tier is resolved
    Then the tier should be "restricted"
    And the resolvedBy should be "default"

  Scenario: Authenticated user gets standard tier by default
    Given an authenticated user context without admin role
    And no API key scopes
    And instanceConfig.defaultAuthenticatedTier is not set
    When the access tier is resolved
    Then the tier should be "standard"
    And the resolvedBy should be "config"

  Scenario: Admin user gets full tier
    Given an authenticated user context with role "admin"
    When the access tier is resolved
    Then the tier should be "full"
    And the resolvedBy should be "user-role"

  Scenario: Self-hosted instance grants full tier to all users
    Given any user context (including anonymous)
    And instanceConfig.selfHosted is true
    When the access tier is resolved
    Then the tier should be "full"
    And the resolvedBy should be "config"

  Scenario: Kill switch overrides all tier resolution
    Given an admin user context
    And the tools kill switch is active
    When the access tier is resolved
    Then the tier should be "restricted"
    And the resolvedBy should be "kill-switch"

Feature: MCP Server Filtering by Tier

  Scenario: Standard tier user can access Standard and below MCP servers
    Given a user with "standard" access tier
    And 3 MCP servers: one "standard" minimum, one "full" minimum, one "restricted" minimum
    When MCP config is built
    Then the config should include the "standard" and "restricted" servers
    And the config should NOT include the "full" server

  Scenario: Full tier user can access all MCP servers
    Given a user with "full" access tier
    And 3 MCP servers at different minimum tiers
    When MCP config is built
    Then the config should include all 3 servers

Feature: Sandbox Enforcement

  Scenario: Standard tier subprocess cannot write outside scratch directory
    Given a standard tier sandbox with writablePaths ["/workspace/scratch"]
    When the subprocess attempts to write to "/workspace/config.json"
    Then the write should be denied
    And a SANDBOX_VIOLATION event should be emitted
    And the subprocess should be terminated

  Scenario: Standard tier subprocess cannot make outbound network request to unauthorized domain
    Given a standard tier sandbox with allowedDomains ["foundation-models.api.cloud.ru"]
    When the subprocess attempts to connect to "evil.example.com"
    Then the connection should be blocked
    And a SANDBOX_VIOLATION event should be emitted

Feature: Audit Completeness

  Scenario: Every tool call produces an audit entry
    Given a standard tier session with WebSearch allowed
    When the subprocess invokes WebSearch
    Then a ToolAuditEntry should be created with toolName "WebSearch"
    And the entry should include duration_ms
    And the entry should include success status

  Scenario: Denied tool calls are audited
    Given a standard tier session
    When the subprocess attempts to invoke Bash (not allowed)
    Then the tool call should be denied
    And a ToolAuditEntry should be created with success=false
    And the error should indicate "tool not in allowlist"
```

### 4.2 Undefined Integration Contracts

| Contract | Between | What Is Missing |
|----------|---------|-----------------|
| Tier resolution <-> Session creation (ADR-008) | `resolveAccessTier()` <-> `UserTenant` creation | Who calls `resolveAccessTier()`? Is it called during tenant creation, during session creation, or during subprocess spawn? The temporal ordering is not specified. |
| MCP config <-> Claude Code subprocess | `MCPConfigManifest` <-> `claude` CLI `--mcp-config` flag | The exact JSON schema expected by `--mcp-config` is referenced but not validated. If the schema drifts between Claude Code versions, config generation may silently break. |
| Sandbox config <-> Docker runtime | `SandboxConfig` <-> Docker container creation API | The mapping from `SandboxConfig` fields to Docker run flags (`--memory`, `--cpus`, `--read-only`, `--mount`) is not defined. |
| Kill switch <-> Active sessions | `KillSwitchConfig.toolsKillSwitch` <-> Running subprocesses | Activating the kill switch affects only new sessions. No mechanism to terminate or downgrade active sessions. |
| Audit log <-> Monitoring/alerting | `ToolAuditEntry` <-> Alerting system | Invariant 6 says missing audit entries should trigger alerts. No alerting integration is defined. |
| Access tier <-> Messenger adapter (ADR-006) | `AccessTierConfig` <-> `MessageRouter` | When a message arrives via ADR-006's adapter, the router dispatches to the core engine, which spawns a Claude Code subprocess. The tier resolution depends on user identity, but the adapter only provides `platformUserId`. The mapping from `platformUserId` to OpenClaw `UserContext` (with roles, API key scopes) is not defined. |

---

## 5. Pre-Implementation Tests

### 5.1 Unit Tests (Write BEFORE Implementation)

| # | Test Name | File | What It Validates |
|---|-----------|------|-------------------|
| U007-01 | `resolveAccessTier: should return restricted for anonymous user` | `tests/access-tier.test.ts` | Given `userContext = { authenticated: false, roles: [], apiKeyScopes: [] }` and `instanceConfig = { selfHosted: false }`, assert tier is `'restricted'` and resolvedBy is `'default'`. |
| U007-02 | `resolveAccessTier: should return full for admin user` | `tests/access-tier.test.ts` | Given `userContext = { authenticated: true, roles: ['admin'], apiKeyScopes: [] }`, assert tier is `'full'` and resolvedBy is `'user-role'`. |
| U007-03 | `resolveAccessTier: should return full for self-hosted instance regardless of user` | `tests/access-tier.test.ts` | Given `userContext = { authenticated: false }` and `instanceConfig = { selfHosted: true }`, assert tier is `'full'`. Test with anonymous, authenticated, and admin users to confirm self-hosted always wins. |
| U007-04 | `resolveAccessTier: should return restricted when kill switch is active, even for admin` | `tests/access-tier.test.ts` | Given kill switch active and admin user context, assert tier is `'restricted'` and resolvedBy is `'kill-switch'`. |
| U007-05 | `buildToolAccessDirective: should return tools-disabled string for restricted tier` | `tests/tool-directive.test.ts` | Assert output contains `"Tools are disabled in this session."`. Assert output does NOT contain tool names. |
| U007-06 | `buildToolAccessDirective: should list allowed tools for standard tier` | `tests/tool-directive.test.ts` | Given allowedTools `['WebSearch', 'mcp__rag_search']`, assert output contains both tool names and contains `"Do NOT use file operations"`. |
| U007-07 | `buildToolAccessDirective: should return empty string for full tier` | `tests/tool-directive.test.ts` | Assert output is exactly `''`. No restrictions injected. |
| U007-08 | `buildMCPConfig: should filter servers by tier rank` | `tests/mcp-config.test.ts` | Given 3 servers (minimumTier: restricted, standard, full) and user tier standard, assert config includes only restricted and standard servers. |
| U007-09 | `buildMCPConfig: should set stdio command for stdio transport servers` | `tests/mcp-config.test.ts` | Given a stdio server, assert config entry has `command` field and no `url` field. Given an SSE server, assert config entry has `url` field and `transport: 'sse'`. |
| U007-10 | `buildClaudeCliArgs: should include --allowed-tools with empty value for restricted tier` | `tests/cli-args.test.ts` | Assert `toolArgs` contains `['--allowed-tools', '']`. Assert `mcpConfigPath` is `undefined`. |

### 5.2 Integration Tests

| # | Test Name | File | What It Validates |
|---|-----------|------|-------------------|
| I007-01 | `Full tier resolution to CLI args pipeline: admin user gets full tool access with MCP` | `tests/integration/tier-to-cli.test.ts` | Create `UserContext` with admin role. Run through `resolveAccessTier` -> `buildMCPConfig` -> `buildClaudeCliArgs`. Assert final CLI args do NOT include `--allowed-tools` restriction and DO include `--mcp-config` path. Assert the MCP config JSON file is valid and contains all servers. |
| I007-02 | `Standard tier subprocess cannot access Full-tier MCP servers` | `tests/integration/mcp-tier-filter.test.ts` | Configure a PostgreSQL MCP server with `minimumTier: 'full'` and a RAG server with `minimumTier: 'standard'`. Resolve a standard user. Build MCP config. Assert PostgreSQL server is NOT in the config. Assert RAG server IS in the config. |
| I007-03 | `Kill switch activation reverts all new sessions to restricted` | `tests/integration/kill-switch.test.ts` | Create sessions for anonymous, authenticated, and admin users. Activate kill switch. Create new sessions for the same users. Assert all new sessions have restricted tier. Assert pre-existing sessions are unaffected (documenting the gap). |
| I007-04 | `MCP config cleanup on session end` | `tests/integration/session-cleanup.test.ts` | Start a session that generates `/tmp/openclaw/mcp-configs/${sessionId}.json`. End the session. Assert the JSON file is deleted. Test crash scenario: kill the process and assert cleanup runs via a secondary mechanism (e.g., TTL-based file cleaner). |
| I007-05 | `Audit log records all tool invocations including denied calls` | `tests/integration/audit-log.test.ts` | Create a standard-tier session. Invoke an allowed tool (WebSearch). Attempt a denied tool (Bash). Query the audit log. Assert two entries: one with `success: true`, one with `success: false` and error indicating denial. |

### 5.3 E2E Test Scenarios

| # | Scenario | Environment | What It Validates |
|---|----------|-------------|-------------------|
| E2E-007-01 | **Standard tier user invokes RAG MCP server via Claude Code, gets results, and is rate-limited after exceeding quota** | Docker sandbox, real Claude Code subprocess with mock Cloud.ru MCP server | Full lifecycle: session creation -> tier resolution -> MCP config generation -> Claude Code subprocess spawn -> MCP tool call -> result returned -> rate limit enforcement on excessive calls. Assert audit log contains all invocations. Assert the subprocess cannot call Bash. |
| E2E-007-02 | **Full tier user performs file operations within sandbox, then sandbox wall-time limit terminates the session** | Docker sandbox, real Claude Code subprocess | Spawn a full-tier session with `maxWallTimeSeconds: 30`. Issue a long-running task. Assert that after 30 seconds, the subprocess is terminated. Assert a `SESSION_TERMINATED` audit entry is created. Assert workspace cleanup occurs. |

---

## 6. Cross-ADR Integration Risks

### 6.1 ADR-007 x ADR-003 (Claude Code Agentic Engine) -- CRITICAL RISK

**Problem**: ADR-007 supersedes ADR-003's tools restriction at `cli-runner.ts:82-83`. But ADR-003 also defines the subprocess spawning logic, session ID management, and `--dangerously-skip-permissions` usage. ADR-007 modifies the CLI args but does not redefine the spawning lifecycle. If ADR-003's spawning logic changes independently, the tier-based arg injection may break.

**Impact**: A regression in `cli-runner.ts` could silently drop the `--allowed-tools` flag, granting all users full tool access.

**Contract test needed**: `cli-runner.ts subprocess spawning should ALWAYS include --allowed-tools flag when tier is restricted or standard. Absence of the flag should fail a health check.`

### 6.2 ADR-007 x ADR-008 (Multi-Tenant Session Isolation) -- CRITICAL RISK

**Problem**: Both ADRs define workspace isolation. ADR-007 uses `/tmp/openclaw/workspaces/${userId}` with Docker uid mapping. ADR-008 defines `UserTenant` with workspace boundaries. These two isolation mechanisms must align exactly. If ADR-008 uses a different path template or isolation mechanism, gaps appear.

**Impact**: Cross-user workspace access if path templates diverge between the two ADRs.

**Contract test needed**: `UserTenant workspace path should match SandboxConfig.filesystem.rootDir for the same userId. Paths should be validated as identical at session creation time.`

### 6.3 ADR-007 x ADR-009 (Concurrent Request Processing) -- HIGH RISK

**Problem**: ADR-009 introduces a worker pool with concurrent subprocesses. ADR-007's sandbox creates a Docker container per session. Concurrent sessions for the same user may share the workspace directory. Docker volume mounts do not prevent concurrent writes within the same volume.

**Impact**: Race conditions in workspace files when the same user has multiple concurrent sessions.

**Contract test needed**: `Concurrent sessions for the same user should have independent scratch directories (e.g., /workspace/${userId}/${sessionId}/scratch), not shared workspace roots.`

### 6.4 ADR-007 x ADR-011 (User Training via Messenger) -- HIGH RISK

**Problem**: ADR-011 allows users to modify their CLAUDE.md and register custom MCP servers via chat commands. ADR-007's tier system determines MCP server access. If a standard-tier user registers a custom MCP server via ADR-011's `/mcp add` command, should it be accessible? The `MCPServerConfig.source` field distinguishes `'cloudru-registry'` from `'custom'`, but the tier filtering logic does not distinguish by source.

**Impact**: A standard-tier user could register a custom MCP server that provides tools (e.g., a bash-equivalent tool) that bypass the tier restrictions.

**Contract test needed**: `Custom MCP servers registered by standard-tier users should be filtered to only expose tools in the standard-tier allowlist. Custom MCP servers providing tools outside the allowlist should be rejected at registration time.`

### 6.5 ADR-007 x ADR-013 (Cloud.ru AI Fabric Agent Integration) -- MEDIUM RISK

**Problem**: ADR-013 introduces external agent providers (Cloud.ru AI Agents) that execute remotely. ADR-007's sandbox applies to local Claude Code subprocesses. When Claude Code calls a Cloud.ru agent via MCP, the remote agent operates outside the local sandbox. The remote agent may have its own tool access (e.g., PostgreSQL writes) that the local sandbox cannot restrict.

**Impact**: A standard-tier user calling a Cloud.ru agent via MCP could indirectly access capabilities (database writes, file operations) that their local sandbox denies.

**Contract test needed**: `Cloud.ru agent MCP tools should declare their effective capabilities (read, write, execute) in MCPServerConfig.exposedTools. Tier filtering should account for the effective capability, not just the tool name.`

### 6.6 ADR-007 x ADR-006 (Multi-Messenger Adapter) -- MEDIUM RISK

**Problem**: ADR-006's `NormalizedMessage.userId` is a platform-native ID (e.g., Telegram numeric ID). ADR-007's `resolveAccessTier()` requires a `UserContext` with roles and API key scopes. The mapping from platform user ID to `UserContext` is not defined in either ADR.

**Impact**: Without this mapping, tier resolution will default to `restricted` for all messenger users (the anonymous fallback), even if they are authenticated OpenClaw users who connected via Telegram.

**Contract test needed**: `PlatformIdentityResolver should map (platform, platformUserId) to UserContext with correct roles and API key scopes. Should return anonymous context for unknown platform users.`

---

## 7. Defect Prevention Recommendations

### 7.1 Architectural Patterns

| Pattern | Prevents | Implementation |
|---------|----------|----------------|
| **Builder pattern for ToolExecutionContext** | Incomplete context construction (missing tier, missing sandbox) | `ToolExecutionContext.builder().withTier(tier).withSandbox(sandbox).withAllowedTools(tools).build()` throws if any required field is missing. |
| **Opaque session token** | Session ID guessing/hijacking | Use `crypto.randomUUID()` for session IDs. Never derive from user ID or timestamp. Do not expose in URLs. |
| **Signed MCP config files** | Tampered MCP config allowing unauthorized tool access | HMAC-sign the MCP config JSON with a server-side secret. Claude Code subprocess validates the signature before loading. |
| **Principle of least privilege for env vars** | `tokenEnvVar` injection reading arbitrary env vars | Create a `SafeEnvResolver` that only resolves env vars from a predefined allowlist (`CLOUDRU_API_KEY`, `TELEGRAM_BOT_TOKEN`, etc.). Reject any `tokenEnvVar` not in the allowlist. |
| **Fail-closed audit logging** | Tool invocations proceeding without audit trail | Wrap every tool invocation in an audit middleware that writes the audit entry BEFORE returning the tool result. If audit write fails, the tool result is discarded and an error is returned. |
| **Immutable tier assertion** | Runtime tier mutation after session creation | `Object.freeze(accessTierConfig)`. Add a runtime assertion at every tool invocation checkpoint: `assert(currentTier === frozenTier, 'Tier mutation detected')`. |

### 7.2 Runtime Validations

| Validation | Where | What |
|-----------|-------|------|
| `SandboxConfig.filesystem.rootDir` must not contain `..` | `SandboxConfig` constructor/factory | `assert(!rootDir.includes('..'), 'Path traversal detected in rootDir')` |
| `SandboxConfig.filesystem.writablePaths` must all be under `rootDir` | `SandboxConfig` constructor/factory | `assert(writablePaths.every(p => p.startsWith(rootDir)), 'Writable path outside rootDir')` |
| `MCPServerConfig.url` must be HTTPS for SSE/HTTP transports | `buildMCPConfig()` | `assert(server.url.startsWith('https://'), 'MCP server URL must be HTTPS')` |
| `MCPServerConfig.auth.tokenEnvVar` must be in allowlist | `buildMCPConfig()` | `assert(ALLOWED_ENV_VARS.includes(server.auth.tokenEnvVar), 'Unauthorized env var access')` |
| Tier must be resolved before subprocess spawn | `buildClaudeCliArgs()` entry point | `assert(tier !== undefined && tier !== null, 'Tier must be resolved')` |
| MCP config JSON file must have restricted permissions | After writing to `/tmp/openclaw/mcp-configs/` | `fs.chmodSync(path, 0o600)` -- owner read/write only. Test: `MCP config file should have permissions 600`. |
| Kill switch check at every tier resolution | `resolveAccessTier()` first line | `if (globalConfig.toolsKillSwitch) return { tier: 'restricted', resolvedBy: 'kill-switch' }` |
| Session workspace must be created with correct uid ownership | `workspace.ts` creation logic | `assert(fs.statSync(workspacePath).uid === expectedUid, 'Workspace uid mismatch')` |
| `--allowed-tools` value must not be undefined/null | `buildClaudeCliArgs()` | For restricted and standard tiers, assert `toolArgs` contains `'--allowed-tools'` followed by a defined string value. |
| Audit entry `duration_ms` must be non-negative | `audit.ts` entry creation | `assert(entry.duration_ms >= 0, 'Negative duration detected')` |

---
---

# Cross-ADR Summary: Top 10 Integration Risks

| Priority | Risk | ADRs Involved | Test Type Needed |
|----------|------|---------------|------------------|
| 1 | Platform user identity not mapped to UserContext for tier resolution | ADR-006 x ADR-007 | Contract test: `PlatformIdentityResolver` |
| 2 | Workspace path templates diverge between sandbox and tenant isolation | ADR-007 x ADR-008 | Contract test: path consistency assertion |
| 3 | Streaming responses require adapter interface extension not defined in ADR-006 | ADR-006 x ADR-010 | Contract test: `IStreamingMessengerAdapter` |
| 4 | Custom MCP servers from training engine bypass tier restrictions | ADR-007 x ADR-011 | Security test: custom MCP tool filtering |
| 5 | Kill switch does not terminate active full-tier sessions | ADR-007 standalone | Integration test: active session behavior |
| 6 | Concurrent sessions share workspace directory causing race conditions | ADR-007 x ADR-009 | Concurrency test: parallel workspace writes |
| 7 | `--dangerously-skip-permissions` removes Claude Code safety for all tiers | ADR-007 x ADR-003 | Security review: evaluate necessity per tier |
| 8 | Command routing (`/train`, `/forget`) not intercepted by adapter layer | ADR-006 x ADR-011 | Contract test: command interceptor |
| 9 | Remote Cloud.ru agents execute outside local sandbox | ADR-007 x ADR-013 | Security test: effective capability check |
| 10 | `mcp__*` wildcard in standard tier matches user-registered MCP tools | ADR-007 standalone | Security test: wildcard scope validation |

---

# Appendix: Test Count Summary

| ADR | Unit Tests | Integration Tests | E2E Tests | BDD Scenarios | Contract Tests | Total |
|-----|-----------|-------------------|-----------|---------------|---------------|-------|
| ADR-006 | 10 | 5 | 2 | 8 | 6 | 31 |
| ADR-007 | 10 | 5 | 2 | 9 | 6 | 32 |
| **Total** | **20** | **10** | **4** | **17** | **12** | **63** |

All 63 tests should be written BEFORE implementation begins. The unit tests (20) and contract tests (12) are the highest priority -- they validate the core invariants and cross-bounded-context contracts that, if violated, produce defects that are expensive to fix post-implementation.
