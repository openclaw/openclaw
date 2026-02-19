# Shift-Left Testing Report: ADR-006 MAX Messenger Extension

## Level 4 -- Risk Analysis in Design Phase

**Date**: 2026-02-16
**Analyst**: QA Shift-Left Testing Agent
**Scope**: ADR-006 (MAX Messenger Extension for OpenClaw)
**ADR Status**: PROPOSED
**Adjacent ADRs Reviewed**: ADR-006/007 (Multi-Messenger Adapter Architecture), Telegram extension reference implementation

---

## 1. Requirements Validation

### 1.1 Functional Requirements Testability

| #     | Requirement (from ADR)                                         | Testable? | Measurable Criteria?                                                 | Notes                                                  |
| ----- | -------------------------------------------------------------- | --------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| FR-01 | Create extension `@openclaw/max` with 5-file structure         | YES       | File existence, export shape matches pattern                         | Structurally verifiable                                |
| FR-02 | `ChannelPlugin<ResolvedMaxAccount, MaxProbe>` adapter          | YES       | Type conformance at compile time                                     | TypeScript enforces                                    |
| FR-03 | `outbound.sendText` via `runtime.channel.max.sendMessageMax()` | YES       | Mock runtime, assert call with correct args                          | Delegated to runtime                                   |
| FR-04 | `outbound.sendMedia` with two-step upload                      | PARTIALLY | Upload step is internal to runtime; extension only passes `mediaUrl` | Cannot test upload flow without runtime implementation |
| FR-05 | Webhook event handling (9 event types)                         | YES       | Each event type mapped to OpenClaw action                            | Event-by-event testable                                |
| FR-06 | Long polling as alternative gateway                            | YES       | `useWebhook: false` triggers polling mode                            | Verifiable via config                                  |
| FR-07 | Inline keyboard support (210 buttons, 30 rows, 7/row)          | PARTIALLY | Button limits documented but enforcement location unclear            | Runtime or extension?                                  |
| FR-08 | Config CRUD (list, resolve, create, update, delete accounts)   | YES       | Standard CRUD assertions                                             | Follows existing pattern                               |
| FR-09 | Setup wizard for bot token                                     | YES       | Interactive flow testable with mock prompts                          | Follows Telegram pattern                               |
| FR-10 | Platform registration in `CHAT_CHANNEL_ORDER`                  | YES       | Array inclusion check                                                | Compile-time or unit test                              |
| FR-11 | Rate limit compliance (30 rps)                                 | PARTIALLY | Rate limiter exists in `rate-limiter.ts` docs but "not yet in code"  | Implementation gap                                     |
| FR-12 | Message format support (markdown, html)                        | YES       | Format parameter passed to runtime                                   | Verifiable                                             |
| FR-13 | `probeMax` via `GET /me`                                       | YES       | Mock HTTP, assert token validation                                   | Standard probe pattern                                 |
| FR-14 | Graceful shutdown via `abortSignal`                            | YES       | Signal abort, assert cleanup                                         | Behavioral test                                        |
| FR-15 | DM policy enforcement (open, pairing, closed)                  | YES       | Config-driven, testable per mode                                     | Follows existing pattern                               |

### 1.2 Missing Requirements

| #     | Missing Requirement                          | Impact                                                                                             | Recommendation                                                                          |
| ----- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| MR-01 | **Webhook signature verification mechanism** | CRITICAL -- ADR says "TBD (research needed)" for webhook secret format                             | Block implementation until MAX webhook verification is documented. Create a spike task. |
| MR-02 | **Error response mapping**                   | HIGH -- No mapping from MAX API HTTP errors (400, 401, 403, 429, 500, 503) to OpenClaw error types | Define `MaxApiError` taxonomy with retry/no-retry classification                        |
| MR-03 | **File upload size limits**                  | MEDIUM -- MAX has 10 MB max request size but per-file-type limits are not specified                | Research and document per-type limits (photo, video, audio, file)                       |
| MR-04 | **Message deduplication**                    | MEDIUM -- Long polling and webhooks can deliver duplicate updates; no dedup strategy defined       | Add `update_id` tracking with TTL cache                                                 |
| MR-05 | **Reconnection strategy for long polling**   | MEDIUM -- No behavior defined when polling connection drops                                        | Define exponential backoff with jitter for reconnection                                 |
| MR-06 | **Group chat bot mention parsing**           | MEDIUM -- How does the extension detect when the bot is mentioned in a group?                      | Research MAX group mention format (`@botname` or different?)                            |
| MR-07 | **Max message length validation**            | LOW -- "~4096 chars (assumed)" is not verified                                                     | Confirm exact limit from MAX API docs before implementation                             |
| MR-08 | **Proxy support behavior**                   | LOW -- `proxy` field exists in config but no behavior is specified                                 | Define proxy passthrough to runtime HTTP client                                         |
| MR-09 | **Bot command registration**                 | LOW -- Telegram has `setMyCommands`; MAX equivalent not researched                                 | Research MAX command registration API                                                   |
| MR-10 | **Typing indicator**                         | LOW -- No mention of typing/chat action indicator for MAX                                          | Research if MAX supports `sendAction` or equivalent                                     |

### 1.3 Acceptance Criteria Assessment

**Score: 45/100** -- The ADR defines architecture and structure well but lacks formal acceptance criteria. The 5 DDD invariants (Section "Invariants") serve as implicit acceptance criteria but are not expressed in testable Given-When-Then format. The webhook event table (Section 6) is descriptive but does not specify success/failure conditions.

---

## 2. Acceptance Tests (Given-When-Then)

### 2.1 Bot Registration and Token Validation

```gherkin
Feature: MAX Bot Registration and Token Validation

  Scenario: AT-01 -- Successful bot token probe
    Given a valid MAX bot token "test-token-abc123"
    And the MAX API at GET /me responds with 200 and body {"user_id": 1, "name": "TestBot", "username": "testbot"}
    When probeMax is called with the token and timeout 5000ms
    Then the probe result should contain userId "1"
    And the probe result should contain name "TestBot"
    And the probe result should contain username "testbot"
    And the probe should be marked as successful

  Scenario: AT-02 -- Invalid bot token probe
    Given an invalid MAX bot token "bad-token"
    And the MAX API at GET /me responds with 401 and body {"code": "unauthorized", "message": "Invalid token"}
    When probeMax is called with the token and timeout 5000ms
    Then the probe should fail with error code "UNAUTHORIZED"
    And the error message should include "Invalid token"
    And no account should be created

  Scenario: AT-03 -- Bot token probe timeout
    Given a valid MAX bot token "test-token-abc123"
    And the MAX API at GET /me does not respond within 5000ms
    When probeMax is called with the token and timeout 5000ms
    Then the probe should fail with error code "TIMEOUT"
    And the error should be marked as retryable
```

### 2.2 Message Sending

```gherkin
Feature: MAX Message Sending

  Scenario: AT-04 -- Send plain text message
    Given a MAX account "acc1" is configured and enabled
    And the runtime channel max is available
    When sendText is called with chatId "chat-123" and text "Hello, world!"
    Then runtime.channel.max.sendMessageMax should be called with chatId "chat-123"
    And the text argument should be "Hello, world!"
    And the format option should default to "markdown"

  Scenario: AT-05 -- Send message with media attachment
    Given a MAX account "acc1" is configured and enabled
    And the runtime channel max is available
    When sendMedia is called with chatId "chat-123", text "See this image", and mediaUrl "https://example.com/photo.jpg"
    Then runtime.channel.max.sendMessageMax should be called with chatId "chat-123"
    And the opts.mediaUrl should be "https://example.com/photo.jpg"
    And the text argument should be "See this image"

  Scenario: AT-06 -- Send message exceeding chunk limit
    Given a MAX account "acc1" is configured and enabled
    And a text message of 8500 characters
    When sendText is called with the message
    Then runtime.channel.text.chunkMarkdownText should be called with limit 4000
    And the message should be split into 3 chunks
    And each chunk should be sent as a separate sendMessageMax call
    And chunks should be sent in sequential order

  Scenario: AT-07 -- Send message with inline keyboard
    Given a MAX account "acc1" is configured and enabled
    And an inline keyboard with 3 callback buttons in 1 row
    When the message with keyboard is sent to chatId "chat-456"
    Then the keyboard should be included in the sendMessageMax opts
    And each button should have type "callback"
    And callback_data should be preserved for each button
```

### 2.3 Webhook Event Handling

```gherkin
Feature: MAX Webhook Event Handling

  Scenario: AT-08 -- Handle bot_started event
    Given the MAX gateway is running in webhook mode for account "acc1"
    When a webhook payload with update_type "bot_started" is received
    And the payload contains userId "user-1" and chatId "chat-1"
    Then a new session should be created or resumed for userId "user-1"
    And the domain event "max.gateway.started" should not be emitted (it is a user event, not gateway event)

  Scenario: AT-09 -- Handle message_created event
    Given the MAX gateway is running in webhook mode for account "acc1"
    When a webhook payload with update_type "message_created" is received
    And the payload contains text "Hello bot" from userId "user-2" in chatId "chat-2"
    Then the message should be routed to the agent
    And the domain event "max.message.received" should be emitted
    And the event payload should contain chatId "chat-2", userId "user-2", text "Hello bot"

  Scenario: AT-10 -- Handle message_callback event (inline button press)
    Given the MAX gateway is running for account "acc1"
    And a message with inline keyboard was previously sent to chatId "chat-3"
    When a webhook payload with update_type "message_callback" is received
    And the callback contains callbackId "cb-1" and payload "action:confirm" from userId "user-3"
    Then the callback should be handled as an inline button press
    And the domain event "max.callback.received" should be emitted
    And the event payload should contain callbackId "cb-1" and payload "action:confirm"

  Scenario: AT-11 -- Handle message_edited event
    Given the MAX gateway is running for account "acc1"
    When a webhook payload with update_type "message_edited" is received
    And the edited message has messageId "msg-1" with new text "Updated text"
    Then the context should be updated with the new message content
    And the domain event should reflect the edit

  Scenario: AT-12 -- Handle message_removed event
    Given the MAX gateway is running for account "acc1"
    When a webhook payload with update_type "message_removed" is received
    And the removed message has messageId "msg-2"
    Then the removal should be logged
    And no further processing should occur (log only per ADR)

  Scenario: AT-13 -- Handle bot_added to group
    Given the MAX gateway is running for account "acc1"
    When a webhook payload with update_type "bot_added" is received
    And the payload contains groupChatId "group-1"
    Then the group should be registered in the account
    And the group chatType should be set to "group"

  Scenario: AT-14 -- Handle bot_removed from group
    Given the MAX gateway is running for account "acc1"
    When a webhook payload with update_type "bot_removed" is received
    And the payload contains groupChatId "group-1"
    Then the group registration should be cleaned up
    And no further messages should be processed for groupChatId "group-1"

  Scenario: AT-15 -- Handle user_added to group
    Given the MAX gateway is running for account "acc1"
    And the bot is a member of groupChatId "group-1"
    When a webhook payload with update_type "user_added" is received
    And userId "user-new" was added to "group-1"
    Then the group member list should be updated to include "user-new"

  Scenario: AT-16 -- Handle user_removed from group
    Given the MAX gateway is running for account "acc1"
    And the bot is a member of groupChatId "group-1"
    And userId "user-old" is a member of "group-1"
    When a webhook payload with update_type "user_removed" is received
    And userId "user-old" was removed from "group-1"
    Then the group member list should be updated to exclude "user-old"
```

### 2.4 Rate Limiting

```gherkin
Feature: MAX Rate Limit Compliance

  Scenario: AT-17 -- Messages within rate limit are sent immediately
    Given the MAX rate limiter is configured for 30 rps
    And 0 messages have been sent in the current second
    When 25 sendMessageMax calls are made in rapid succession
    Then all 25 messages should be sent without delay
    And no rate limit domain event should be emitted

  Scenario: AT-18 -- Messages exceeding rate limit are queued
    Given the MAX rate limiter is configured for 30 rps
    And 30 messages have been sent in the current second
    When the 31st sendMessageMax call is made
    Then the message should be queued (not dropped)
    And the domain event "max.message.delivery_failed" should NOT be emitted
    And when the next second begins, the queued message should be sent

  Scenario: AT-19 -- HTTP 429 response triggers backoff
    Given the MAX API returns HTTP 429 with Retry-After header "2"
    When a sendMessageMax call receives this response
    Then the rate limiter should pause outbound messages for at least 2 seconds
    And the error should be classified as retryable
    And queued messages should be retried after the backoff period
```

### 2.5 Gateway Modes

```gherkin
Feature: MAX Gateway Modes

  Scenario: AT-20 -- Start webhook gateway
    Given a MAX account "acc1" with config useWebhook: true
    And webhookUrl is "https://example.com/webhook/max"
    And webhookSecret is "secret-123"
    When gateway.startAccount is called
    Then runtime.channel.max.monitorMaxProvider should be called with useWebhook: true
    And the webhookUrl should be "https://example.com/webhook/max"
    And the domain event "max.gateway.started" should be emitted with mode "webhook"

  Scenario: AT-21 -- Start long polling gateway
    Given a MAX account "acc1" with config useWebhook: false
    And no webhookUrl is configured
    When gateway.startAccount is called
    Then runtime.channel.max.monitorMaxProvider should be called with useWebhook: false
    And the domain event "max.gateway.started" should be emitted with mode "polling"

  Scenario: AT-22 -- Gateway exclusivity enforcement
    Given a MAX account "acc1" is running in webhook mode
    When an attempt is made to start the same account in polling mode
    Then the attempt should be rejected with an error
    And the error message should indicate only one gateway mode per account is allowed
    And the existing webhook gateway should continue running
```

### 2.6 Error Handling

```gherkin
Feature: MAX Error Handling

  Scenario: AT-23 -- Handle HTTP 400 Bad Request
    Given a sendMessageMax call with malformed payload
    When the MAX API returns HTTP 400
    Then the error should be classified as non-retryable
    And the domain event "max.message.delivery_failed" should be emitted
    And the statusCode in the event payload should be 400

  Scenario: AT-24 -- Handle HTTP 401 Unauthorized
    Given a MAX account "acc1" with an expired or revoked token
    When the MAX API returns HTTP 401
    Then the error should be classified as non-retryable
    And the account status should be marked as requiring re-authentication
    And subsequent messages should not be attempted until token is refreshed

  Scenario: AT-25 -- Handle HTTP 429 Too Many Requests
    Given outbound messages are being sent at high rate
    When the MAX API returns HTTP 429
    Then the error should be classified as retryable
    And the Retry-After header value should be respected
    And queued messages should resume after the backoff period

  Scenario: AT-26 -- Handle HTTP 503 Service Unavailable
    Given the MAX API is experiencing downtime
    When the MAX API returns HTTP 503
    Then the error should be classified as retryable
    And exponential backoff should be applied
    And the domain event "max.message.delivery_failed" should be emitted with statusCode 503
```

### 2.7 Graceful Shutdown

```gherkin
Feature: MAX Graceful Shutdown

  Scenario: AT-27 -- Graceful shutdown via AbortSignal
    Given the MAX gateway is running for account "acc1" in webhook mode
    And there are 3 messages currently being processed
    When the abortSignal is triggered
    Then the gateway should stop accepting new incoming messages
    And the 3 in-flight messages should complete processing
    And the domain event "max.gateway.stopped" should be emitted with reason "abort"
    And the webhook subscription should be cleaned up

  Scenario: AT-28 -- Graceful shutdown during long polling
    Given the MAX gateway is running for account "acc1" in polling mode
    And a GET /updates request is currently pending
    When the abortSignal is triggered
    Then the pending polling request should be cancelled
    And no new polling requests should be initiated
    And the domain event "max.gateway.stopped" should be emitted
```

### 2.8 Config CRUD

```gherkin
Feature: MAX Account Config CRUD

  Scenario: AT-29 -- List MAX account IDs
    Given openclaw.json contains MAX accounts "acc1" and "acc2"
    When listMaxAccountIds is called
    Then the result should contain ["acc1", "acc2"]

  Scenario: AT-30 -- Resolve MAX account by ID
    Given openclaw.json contains MAX account "acc1" with token "tok-1" and enabled: true
    When resolveMaxAccount("acc1") is called
    Then the result should contain token "tok-1"
    And enabled should be true
    And all optional fields (webhookUrl, webhookSecret, proxy) should have their configured or default values

  Scenario: AT-31 -- Create new MAX account via setup wizard
    Given no MAX accounts exist in openclaw.json
    When the setup wizard prompts for a bot token
    And the user enters "new-bot-token"
    And probeMax succeeds with bot name "MyBot"
    Then a new account should be created in openclaw.json under channels.max.accounts
    And the account token should be "new-bot-token"
    And the account should be enabled by default

  Scenario: AT-32 -- Delete MAX account
    Given openclaw.json contains MAX account "acc1"
    When deleteMaxAccount("acc1") is called
    Then the account should be removed from openclaw.json
    And if the account gateway was running, it should be stopped first
```

### 2.9 Security

```gherkin
Feature: MAX Security

  Scenario: AT-33 -- Reject webhook with invalid or missing signature
    Given the MAX gateway is running in webhook mode with webhookSecret "secret-abc"
    When a webhook payload is received without a valid signature header
    Then the payload should be rejected with HTTP 403
    And the domain event "max.webhook.validation_failed" should be emitted
    And the event payload should contain reason "invalid_signature" and the source IP
    And no message processing should occur

  Scenario: AT-34 -- Accept webhook with valid signature
    Given the MAX gateway is running in webhook mode with webhookSecret "secret-abc"
    When a webhook payload is received with a correctly computed signature
    Then the payload should be accepted and processed normally
    And no validation_failed event should be emitted

  Scenario: AT-35 -- Token never appears in logs
    Given a MAX account "acc1" with token "secret-bot-token-12345"
    When any logging operation occurs during message send, probe, or gateway start
    Then the string "secret-bot-token-12345" should NOT appear in any log output
    And the token should be masked as "***" or "[REDACTED]" if referenced
```

---

## 3. Risk Analysis

### 3.1 Technical Risk Matrix

| ID   | Risk                                                                                                                               | Probability | Impact   | Severity | Category       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | -------- | -------------- |
| R-01 | **Webhook signature verification format unknown** -- ADR states "TBD (research needed)"                                            | HIGH        | CRITICAL | **P1**   | Security       |
| R-02 | **`@maxhub/max-bot-api` SDK single-maintainer risk** -- 85+ stars, MIT, but bus factor = 1                                         | MEDIUM      | HIGH     | **P2**   | Dependency     |
| R-03 | **Runtime `channel.max.*` API not yet implemented** -- Extension depends on runtime work                                           | HIGH        | HIGH     | **P2**   | Dependency     |
| R-04 | **Rate limiter not yet in code** -- `rate-limiter.ts` documents `max: 20 rps` but platform limit is 30 rps; neither is implemented | HIGH        | MEDIUM   | **P2**   | Implementation |
| R-05 | **MAX API behavior differences from documentation** -- API is relatively new, docs may be incomplete                               | MEDIUM      | MEDIUM   | **P3**   | Technical      |
| R-06 | **Two-step file upload complexity** -- `POST /uploads` then `POST /messages` introduces failure window                             | MEDIUM      | MEDIUM   | **P3**   | Technical      |
| R-07 | **Long polling connection instability** -- No reconnection strategy defined                                                        | MEDIUM      | MEDIUM   | **P3**   | Reliability    |
| R-08 | **MAX message length limit unverified** -- "~4096 chars (assumed)"                                                                 | LOW         | MEDIUM   | **P3**   | Technical      |
| R-09 | **Russian legal entity requirement for bot publication** -- Business blocker, not technical                                        | HIGH        | LOW      | **P4**   | Business       |
| R-10 | **MAX API version pinning absent** -- No version specified, SDK upgrades may break                                                 | LOW         | MEDIUM   | **P4**   | Maintenance    |
| R-11 | **Inline keyboard limit enforcement location unclear** -- 210 buttons, 30 rows, 7/row: extension or runtime?                       | MEDIUM      | LOW      | **P4**   | Architecture   |
| R-12 | **Duplicate webhook delivery** -- No deduplication mechanism documented                                                            | MEDIUM      | MEDIUM   | **P3**   | Reliability    |

### 3.2 Mitigation Strategies

| Risk ID | Mitigation Strategy                                                                                                                                                                                                                                       | Owner         | Priority              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------- |
| R-01    | **Spike task**: Dedicate 1-2 days to research MAX webhook verification. Contact MAX developer support. Review SDK source for signature verification utilities. If no verification exists, implement IP whitelist as fallback.                             | Security Lead | IMMEDIATE             |
| R-02    | **Vendor risk**: (a) Fork the SDK repository. (b) Pin to a specific version with lockfile. (c) Write an adapter interface around the SDK so it can be replaced with raw HTTP calls if abandoned. (d) Monitor GitHub activity monthly.                     | Tech Lead     | Before implementation |
| R-03    | **Parallel workstream**: Start runtime `channel.max.*` implementation as a parallel workstream. Define the interface contract (from ADR Section 4) as a TypeScript interface file first, allowing extension development against the interface with mocks. | Platform Team | Before implementation |
| R-04    | **Reconcile rate limits**: The documented `20 rps` in `rate-limiter.ts` contradicts the MAX API's `30 rps`. Verify the actual limit via load testing against a staging bot. Implement token bucket with the confirmed value.                              | Backend Dev   | During implementation |
| R-05    | **API exploration tests**: Write a suite of exploratory integration tests against the real MAX API (staging bot) that exercise each endpoint and document actual behavior vs. documented behavior.                                                        | QA            | During implementation |
| R-06    | **Atomic upload pattern**: Implement upload-then-send as a single transactional operation in the runtime. If upload succeeds but send fails, retry send with the uploaded file token (not re-upload). Add cleanup for orphaned uploads.                   | Backend Dev   | During implementation |
| R-07    | **Reconnection with backoff**: Implement exponential backoff (1s, 2s, 4s, 8s, max 60s) with jitter for long polling reconnection. Add a health check that re-probes the bot token after 3 consecutive connection failures.                                | Backend Dev   | During implementation |
| R-08    | **Boundary testing**: Send messages of exactly 4096, 4097, and 4095 characters to the MAX API. Document the actual limit and update `textChunkLimit` accordingly.                                                                                         | QA            | Before implementation |
| R-10    | **Pin SDK version**: Pin `@maxhub/max-bot-api` to an exact version in `package.json`. Add a CI check that flags SDK version bumps for manual review.                                                                                                      | DevOps        | During implementation |
| R-12    | **Dedup via update_id**: Track the last processed `update_id` per account. Skip updates with `update_id <= lastProcessedId`. Use a TTL map (5 min) as secondary dedup for webhook mode.                                                                   | Backend Dev   | During implementation |

### 3.3 Dependency Risk: `@maxhub/max-bot-api` SDK

| Dimension              | Assessment                                                            |
| ---------------------- | --------------------------------------------------------------------- |
| **Maturity**           | Low -- 85+ stars, relatively new SDK for a new platform               |
| **Maintenance**        | Risk -- Single maintainer (bus factor = 1)                            |
| **License**            | MIT -- No legal risk                                                  |
| **TypeScript support** | Native -- SDK is written in TypeScript                                |
| **API coverage**       | Unknown -- Need to verify all endpoints used by extension are covered |
| **Bundle size**        | Unknown -- Needs assessment for extension size impact                 |
| **Test coverage**      | Unknown -- SDK's own test suite quality not evaluated                 |

**Recommendation**: Create a thin adapter layer (`MaxApiClient`) wrapping the SDK. This layer (a) isolates the extension from SDK API changes, (b) allows fallback to raw HTTP if SDK is abandoned, (c) provides a clean mock surface for testing.

---

## 4. Testability Assessment

### 4.1 Overall Score: 70/100

| Dimension                   | Score | Rationale                                                                 |
| --------------------------- | ----- | ------------------------------------------------------------------------- |
| Interface mockability       | 9/10  | All API calls delegated to `runtime.channel.max.*` -- trivially mockable  |
| Extension isolation         | 9/10  | Extension contains zero direct HTTP calls; pure adapter layer             |
| Config testability          | 8/10  | Standard CRUD pattern with JSON schema; easily assertable                 |
| Event mapping testability   | 7/10  | 9 event types clearly tabulated; each testable in isolation               |
| Acceptance criteria clarity | 4/10  | Invariants listed but no formal BDD scenarios in ADR                      |
| Webhook verification        | 2/10  | "TBD" -- cannot test what is not defined                                  |
| Rate limiter testability    | 5/10  | Documented in code comments but not implemented; 20 vs 30 rps discrepancy |
| Error handling              | 5/10  | No error taxonomy or HTTP status mapping defined                          |

### 4.2 Unit Tests (No MAX API Required)

These tests can run entirely with mocked runtime, no network calls.

| #    | Test                                                                | What It Validates                                                               |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| U-01 | `maxPlugin meta returns correct channel metadata`                   | `getChatChannelMeta("max")` returns correct display name, icon, capabilities    |
| U-02 | `maxPlugin capabilities declare correct chatTypes`                  | `chatTypes` includes `["direct", "group"]` but NOT `"thread"` or `"channel"`    |
| U-03 | `sendText delegates to runtime.channel.max.sendMessageMax`          | Mock runtime, call `sendText`, assert `sendMessageMax` called with correct args |
| U-04 | `sendMedia passes mediaUrl in opts`                                 | Mock runtime, call `sendMedia`, assert `opts.mediaUrl` is passed through        |
| U-05 | `chunker uses platform markdown chunker with limit 4000`            | Assert `chunkMarkdownText` called with limit `4000`                             |
| U-06 | `text chunk limit is 4000`                                          | Assert `outbound.textChunkLimit === 4000`                                       |
| U-07 | `config.listMaxAccountIds returns all account IDs`                  | Seed config, assert all IDs returned                                            |
| U-08 | `config.resolveMaxAccount returns full account config`              | Seed config with all fields, assert resolved account matches                    |
| U-09 | `config.resolveMaxAccount returns undefined for missing ID`         | Empty config, assert `undefined` returned                                       |
| U-10 | `probeAccount delegates to runtime.channel.max.probeMax`            | Mock runtime, assert `probeMax` called with token and timeout                   |
| U-11 | `gateway.startAccount calls monitorMaxProvider with correct opts`   | Mock runtime, assert all `MaxMonitorOpts` fields passed correctly               |
| U-12 | `gateway.startAccount passes abortSignal`                           | Assert `opts.abortSignal` is the provided signal                                |
| U-13 | `pairing.idLabel is "maxUserId"`                                    | Assert the pairing configuration is correct                                     |
| U-14 | `setMaxRuntime / getMaxRuntime singleton works correctly`           | Set runtime, get runtime, assert same reference                                 |
| U-15 | `getMaxRuntime throws if runtime not set`                           | Do not set runtime, call get, assert throws                                     |
| U-16 | `register function calls setRuntime and registerChannel`            | Mock API, call register, assert both methods called                             |
| U-17 | `webhook event mapping: all 9 events have correct OpenClaw mapping` | For each event type in the mapping table, assert correct action                 |
| U-18 | `config schema validates required fields (token, enabled)`          | Schema validation rejects config missing `token`                                |
| U-19 | `config schema rejects empty token string`                          | Schema validation rejects `token: ""`                                           |
| U-20 | `config schema validates webhookUrl is HTTPS when present`          | Schema rejects `webhookUrl: "http://..."`                                       |

### 4.3 Integration Tests (Mock Server Required)

These tests require a mock MAX API HTTP server (e.g., using `msw` or `nock`).

| #    | Test                                                               | What It Validates                                                                |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| I-01 | `probeMax against mock GET /me -- success path`                    | Full HTTP roundtrip: request with auth header, parse response                    |
| I-02 | `probeMax against mock GET /me -- 401 error path`                  | Auth failure handling, error classification                                      |
| I-03 | `sendMessageMax against mock POST /messages -- success`            | Message delivery, response parsing, delivery receipt generation                  |
| I-04 | `sendMessageMax with media -- upload then send`                    | Two-step flow: `POST /uploads` -> `POST /messages` with attachment token         |
| I-05 | `monitorMaxProvider webhook mode -- receives and processes events` | Mock webhook POST to local server, verify event routing                          |
| I-06 | `monitorMaxProvider polling mode -- GET /updates cycle`            | Mock `GET /updates` with test events, verify processing loop                     |
| I-07 | `Rate limiter integration -- 30+ rps triggers queuing`             | Send 35 messages in 1 second, verify first 30 sent immediately, remaining queued |
| I-08 | `HTTP 429 backoff -- respects Retry-After header`                  | Mock 429 response, verify pause duration matches header                          |
| I-09 | `Full inbound/outbound cycle with mock MAX API`                    | Webhook event -> normalize -> route -> agent -> denormalize -> send response     |
| I-10 | `Graceful shutdown -- abort signal stops polling loop`             | Start polling, trigger abort, verify loop exits cleanly                          |

### 4.4 E2E Tests (Real MAX API Required)

These tests require a staging MAX bot token and network access to `platform-api.max.ru`.

| #      | Test                                                  | What It Validates                                                                      |
| ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| E2E-01 | `Bot probe against real MAX API`                      | Token is valid, `GET /me` returns expected bot info                                    |
| E2E-02 | `Send text message to a test chat`                    | Message appears in MAX chat, delivery receipt is returned                              |
| E2E-03 | `Send message with inline keyboard, receive callback` | Keyboard renders, button press generates `message_callback` event                      |
| E2E-04 | `Upload and send photo`                               | Two-step upload succeeds, photo appears in chat                                        |
| E2E-05 | `Webhook subscription lifecycle`                      | `POST /subscriptions` creates subscription, messages are received, cleanup on shutdown |
| E2E-06 | `Long polling receives messages`                      | Start polling, send a test message, verify it is received within 30 seconds            |
| E2E-07 | `Rate limit boundary test`                            | Send 30 messages in 1 second, verify all succeed. Send 31st, observe behavior.         |

### 4.5 Test Infrastructure Requirements

| Requirement              | Purpose                                              | Tool/Library                                            |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------- |
| Mock HTTP server         | Simulate MAX API responses for integration tests     | `msw` (Mock Service Worker) or `nock`                   |
| Fake timers              | Test rate limiter timing, polling intervals, backoff | `@sinonjs/fake-timers` or Vitest fake timers            |
| Staging MAX bot          | E2E testing against real API                         | Register bot at `dev.max.ru`, store token in CI secrets |
| Test chat/group          | E2E message delivery validation                      | Create dedicated test group on MAX                      |
| AbortController polyfill | Test graceful shutdown in Node < 16                  | `abort-controller` npm package (if needed)              |
| CI secret management     | Store bot tokens for E2E tests                       | GitHub Actions secrets or Vault                         |
| Webhook tunnel           | Receive webhooks in CI environment                   | `ngrok` or `localtunnel` for E2E webhook tests          |

---

## 5. Security Testing Plan

### 5.1 Webhook Signature Verification Testing

**Status: BLOCKED -- Verification mechanism is "TBD" per ADR**

Once the verification mechanism is researched, the following tests must be written:

| #    | Test                                                           | Type        | Expected Result                                                      |
| ---- | -------------------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| S-01 | Valid signature with correct secret                            | Unit        | Payload accepted, processed normally                                 |
| S-02 | Invalid signature (tampered payload)                           | Unit        | Payload rejected with 403, `validation_failed` event emitted         |
| S-03 | Missing signature header entirely                              | Unit        | Payload rejected with 403                                            |
| S-04 | Empty signature header                                         | Unit        | Payload rejected with 403                                            |
| S-05 | Correct signature but replayed payload (timestamp > 5 min old) | Unit        | Payload rejected (if timestamp verification is supported)            |
| S-06 | Signature computed with wrong secret                           | Unit        | Payload rejected with 403                                            |
| S-07 | Concurrent valid webhooks with same signature                  | Unit        | Both processed (signatures are per-payload, not single-use)          |
| S-08 | Webhook flood without signatures (DDoS via forged payloads)    | Integration | All rejected without heavy computation; rate limit on rejection path |

**Spike deliverable**: A `verifyMaxWebhookSignature(payload: string, signature: string, secret: string): boolean` pure function with 100% branch coverage.

### 5.2 Token Leakage Prevention

| #    | Test                                                                | Type            | What It Validates                                                         |
| ---- | ------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| S-09 | Token not in console.log output during probe                        | Unit            | Mock logger, assert token string not present in any log call              |
| S-10 | Token not in console.log output during sendMessage                  | Unit            | Same as above for send path                                               |
| S-11 | Token not in error stack traces                                     | Unit            | Trigger error with token in context, assert stack trace is sanitized      |
| S-12 | Token not in HTTP error response bodies logged                      | Unit            | Mock 401 response that echoes token, assert it is redacted before logging |
| S-13 | Token not committed in openclaw.json to git                         | Pre-commit hook | Regex scan: reject commits containing patterns matching MAX bot tokens    |
| S-14 | Token stored only in `channels.max.accounts[id].token` path         | Unit            | Assert no other config paths contain the token value                      |
| S-15 | `resolveMaxAccount` does not include token in debug/toString output | Unit            | Assert object stringification does not expose token                       |

**CI Integration**: Add a pre-commit hook that scans for potential MAX bot token patterns in staged files. The exact token format should be researched as part of the webhook verification spike (R-01).

### 5.3 Input Sanitization (Message Injection)

| #    | Test                                                              | Type | What It Validates                                                         |
| ---- | ----------------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| S-16 | Inbound message with markdown injection                           | Unit | `**bold**` in user message does not alter agent's markdown context        |
| S-17 | Inbound message with HTML injection (`<script>alert(1)</script>`) | Unit | HTML tags are escaped or stripped before agent processing                 |
| S-18 | Inbound callback_data with oversized payload                      | Unit | Callback data exceeding expected size is truncated or rejected            |
| S-19 | Inbound message with null bytes                                   | Unit | Null bytes (`\x00`) are stripped before processing                        |
| S-20 | Inbound message with Unicode control characters                   | Unit | Control characters (U+200B zero-width space, etc.) are handled gracefully |
| S-21 | Inbound webhook with extra/unexpected JSON fields                 | Unit | Unknown fields are ignored, not passed to agent                           |
| S-22 | Inbound message with path traversal in attachment URL             | Unit | Attachment URLs are validated, `file:///etc/passwd` patterns rejected     |

### 5.4 Rate Limit Enforcement

| #    | Test                                                      | Type        | What It Validates                                                   |
| ---- | --------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| S-23 | Outbound rate limit enforced at 30 rps per token          | Integration | Token bucket correctly limits to 30 requests/second                 |
| S-24 | Inbound webhook rate limit (if implemented)               | Integration | Excessive webhook calls from single IP are throttled                |
| S-25 | Rate limit per account, not global                        | Unit        | Two accounts with separate tokens have independent rate limits      |
| S-26 | Rate limit state survives account restart                 | Integration | Rate limiter resets on restart (verify this is acceptable behavior) |
| S-27 | Burst handling: 30 requests at t=0, then sustained 30 rps | Integration | Initial burst succeeds, sustained rate is maintained without drift  |

---

## 6. Test Architecture

### 6.1 Test Tiers

```
                    +--------------------------+
                    |   E2E Tests (7 tests)    |   Real MAX API
                    |   Staging bot token      |   platform-api.max.ru
                    |   ~5 min to run          |   CI: nightly only
                    +-----------+--------------+
                                |
                    +-----------+--------------+
                    | Integration Tests (10)   |   Mock MAX API server
                    | msw / nock               |   Full HTTP roundtrip
                    | ~30 sec to run           |   CI: every PR
                    +-----------+--------------+
                                |
                    +-----------+--------------+
                    |   Unit Tests (20+ tests) |   No I/O, mocked runtime
                    |   Pure function tests    |   ~2 sec to run
                    |   Config validation       |   CI: every commit
                    +-----------+--------------+
```

| Tier        | Count | Runtime  | CI Trigger        | Dependencies                                    |
| ----------- | ----- | -------- | ----------------- | ----------------------------------------------- |
| Unit        | 20+   | < 3 sec  | Every commit      | None (mocked runtime)                           |
| Integration | 10    | < 30 sec | Every PR          | Mock HTTP server (`msw`)                        |
| E2E         | 7     | < 5 min  | Nightly / release | Real MAX API, staging bot token, network access |

### 6.2 Mock Strategy

#### 6.2.1 Runtime Mock

The extension makes zero direct HTTP calls. All communication goes through `runtime.channel.max.*`. The primary mock surface is the runtime object:

```typescript
// tests/mocks/mock-max-runtime.ts
export function createMockMaxRuntime(): PluginRuntime {
  return {
    channel: {
      max: {
        sendMessageMax: vi.fn().mockResolvedValue({ messageId: "mock-msg-1", success: true }),
        probeMax: vi.fn().mockResolvedValue({ userId: "1", name: "TestBot", username: "testbot" }),
        monitorMaxProvider: vi.fn().mockResolvedValue(undefined),
        messageActions: undefined,
      },
      text: {
        chunkMarkdownText: vi.fn((text: string, limit: number) => {
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks;
        }),
      },
    },
  } as unknown as PluginRuntime;
}
```

#### 6.2.2 MAX API Mock Server (Integration Tests)

```typescript
// tests/mocks/max-api-handlers.ts (using msw)
import { http, HttpResponse } from "msw";

const BASE_URL = "https://platform-api.max.ru";

export const maxApiHandlers = [
  // GET /me -- Bot info
  http.get(`${BASE_URL}/me`, ({ request }) => {
    const token = request.headers.get("Authorization");
    if (token !== "valid-test-token") {
      return HttpResponse.json({ code: "unauthorized" }, { status: 401 });
    }
    return HttpResponse.json({ user_id: 1, name: "TestBot", username: "testbot" });
  }),

  // POST /messages -- Send message
  http.post(`${BASE_URL}/messages`, async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({ message: { body: { mid: "msg-123" } } });
  }),

  // POST /uploads -- File upload
  http.post(`${BASE_URL}/uploads`, ({ request }) => {
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    return HttpResponse.json({ token: `upload-token-${type}-1` });
  }),

  // POST /subscriptions -- Webhook setup
  http.post(`${BASE_URL}/subscriptions`, () => {
    return HttpResponse.json({ success: true });
  }),

  // GET /updates -- Long polling
  http.get(`${BASE_URL}/updates`, ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({ updates: [] });
  }),

  // POST /answers -- Callback answer
  http.post(`${BASE_URL}/answers`, () => {
    return HttpResponse.json({ success: true });
  }),
];
```

#### 6.2.3 Webhook Event Fixtures

```typescript
// tests/fixtures/max-webhook-events.ts
export const webhookFixtures = {
  bot_started: {
    update_type: "bot_started",
    timestamp: 1708000000000,
    user: { user_id: 100, name: "TestUser" },
    chat_id: "chat-1",
  },
  message_created: {
    update_type: "message_created",
    timestamp: 1708000001000,
    message: {
      sender: { user_id: 100, name: "TestUser" },
      recipient: { chat_id: "chat-1" },
      body: { mid: "msg-1", text: "Hello bot", seq: 1 },
    },
  },
  message_callback: {
    update_type: "message_callback",
    timestamp: 1708000002000,
    callback: {
      callback_id: "cb-1",
      payload: "action:confirm",
      user: { user_id: 100 },
    },
  },
  message_edited: {
    update_type: "message_edited",
    timestamp: 1708000003000,
    message: {
      body: { mid: "msg-1", text: "Edited text", seq: 2 },
    },
  },
  message_removed: {
    update_type: "message_removed",
    timestamp: 1708000004000,
    message_id: "msg-2",
  },
  bot_added: {
    update_type: "bot_added",
    timestamp: 1708000005000,
    chat_id: "group-1",
    user: { user_id: 0, name: "System" },
  },
  bot_removed: {
    update_type: "bot_removed",
    timestamp: 1708000006000,
    chat_id: "group-1",
    user: { user_id: 0, name: "System" },
  },
  user_added: {
    update_type: "user_added",
    timestamp: 1708000007000,
    chat_id: "group-1",
    user: { user_id: 200, name: "NewUser" },
  },
  user_removed: {
    update_type: "user_removed",
    timestamp: 1708000008000,
    chat_id: "group-1",
    user: { user_id: 200, name: "OldUser" },
  },
};
```

### 6.3 Test Data Management

| Data Type                     | Strategy                                                 | Lifecycle                               |
| ----------------------------- | -------------------------------------------------------- | --------------------------------------- |
| Bot tokens (unit/integration) | Hardcoded test values (`"test-token-123"`)               | Stateless, per-test                     |
| Bot tokens (E2E)              | CI secrets (`MAX_STAGING_BOT_TOKEN`)                     | Persistent, managed in vault            |
| Config fixtures               | Factory functions (`createTestMaxConfig(overrides)`)     | Created per test, discarded after       |
| Webhook payloads              | Static fixtures (see Section 6.2.3)                      | Version-controlled in `tests/fixtures/` |
| Chat IDs / User IDs           | Deterministic strings (`"test-chat-1"`, `"test-user-1"`) | Stateless, per-test                     |
| Uploaded file tokens          | Mock-generated (`"upload-token-photo-1"`)                | Scoped to mock server session           |
| Rate limiter state            | Reset before each test via `beforeEach`                  | No carryover between tests              |

### 6.4 CI/CD Integration

```yaml
# .github/workflows/max-extension-tests.yml (conceptual)
jobs:
  unit-tests:
    name: "MAX Extension -- Unit Tests"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npx vitest run extensions/max/tests/unit --reporter=verbose
    # Trigger: every push, every PR

  integration-tests:
    name: "MAX Extension -- Integration Tests"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npx vitest run extensions/max/tests/integration --reporter=verbose
    # Trigger: PR to main, merge to main

  e2e-tests:
    name: "MAX Extension -- E2E Tests"
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    env:
      MAX_STAGING_BOT_TOKEN: ${{ secrets.MAX_STAGING_BOT_TOKEN }}
      MAX_TEST_CHAT_ID: ${{ secrets.MAX_TEST_CHAT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npx vitest run extensions/max/tests/e2e --reporter=verbose --timeout=300000
    # Trigger: nightly schedule, manual dispatch

  security-scan:
    name: "MAX Extension -- Security Scan"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check for token leakage in source
        run: |
          # Scan for potential MAX bot tokens in non-test source files
          ! grep -rn --include='*.ts' --include='*.json' --exclude-dir=tests \
            -E '[a-zA-Z0-9]{32,}' extensions/max/src/ || true
      - name: Audit dependencies
        run: npm audit --workspace=extensions/max
    # Trigger: every PR
```

### 6.5 Test File Organization

```
extensions/max/
  tests/
    unit/
      channel.test.ts          # U-01 through U-07 (ChannelPlugin behavior)
      config.test.ts           # U-07 through U-09, U-18 through U-20 (Config CRUD & validation)
      runtime.test.ts          # U-14 through U-16 (Singleton, register)
      event-mapping.test.ts    # U-17 (Webhook event -> OpenClaw action mapping)
      probe.test.ts            # U-10, U-13 (Probe and pairing)
      gateway.test.ts          # U-11, U-12 (Gateway start with opts)
    integration/
      probe.integration.test.ts     # I-01, I-02
      send-message.integration.test.ts  # I-03, I-04
      webhook-gateway.integration.test.ts  # I-05
      polling-gateway.integration.test.ts  # I-06, I-10
      rate-limiter.integration.test.ts     # I-07, I-08
      full-cycle.integration.test.ts       # I-09
    e2e/
      max-e2e.test.ts          # E2E-01 through E2E-07
    security/
      webhook-verification.test.ts   # S-01 through S-08
      token-leakage.test.ts          # S-09 through S-15
      input-sanitization.test.ts     # S-16 through S-22
      rate-limit-enforcement.test.ts # S-23 through S-27
    fixtures/
      max-webhook-events.ts    # Static webhook event payloads
      max-config.ts            # Config factory functions
    mocks/
      mock-max-runtime.ts      # Runtime mock factory
      max-api-handlers.ts      # msw handlers for MAX API
```

---

## 7. DDD Invariant Enforcement

### 7.1 Invariant Test Coverage

| #      | Invariant (from ADR)                                                 | Enforcement Mechanism                             | Test Strategy                                                                                                       |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| INV-01 | Token stored only in `channels.max.accounts[id].token`, never logged | Runtime validation + logging interceptor          | S-09 through S-15: Mock logger, assert token never appears in log output. Pre-commit hook scans for token patterns. |
| INV-02 | Every incoming webhook MUST be verified before processing            | Middleware function `verifyMaxWebhookSignature()` | S-01 through S-08: Test valid/invalid/missing signatures. **BLOCKED on R-01 research.**                             |
| INV-03 | Outbound messages MUST respect 30 rps per token                      | Token bucket rate limiter per account             | AT-17 through AT-19, S-23 through S-27: Boundary tests at 29, 30, 31 rps.                                           |
| INV-04 | Only one gateway mode (webhook OR polling) per account               | Guard in `gateway.startAccount`                   | AT-22: Attempt dual start, assert rejection.                                                                        |
| INV-05 | `gateway.startAccount` MUST respect `abortSignal`                    | AbortController integration                       | AT-27, AT-28: Signal abort, verify clean shutdown.                                                                  |

### 7.2 Domain Event Testability

The ADR defines 8 domain events. Each must be emittable and assertable:

| Event                           | Testable? | How to Test                                                   |
| ------------------------------- | --------- | ------------------------------------------------------------- |
| `max.message.received`          | YES       | Mock webhook event, assert event emitted with correct payload |
| `max.message.sent`              | YES       | Mock sendMessageMax success, assert event emitted             |
| `max.message.delivery_failed`   | YES       | Mock sendMessageMax failure, assert event emitted with error  |
| `max.webhook.received`          | YES       | Any webhook payload, assert event emitted with `updateType`   |
| `max.webhook.validation_failed` | BLOCKED   | Depends on R-01 (webhook verification mechanism)              |
| `max.callback.received`         | YES       | Mock `message_callback` event, assert event emitted           |
| `max.gateway.started`           | YES       | Call `startAccount`, assert event emitted with mode           |
| `max.gateway.stopped`           | YES       | Trigger abort, assert event emitted with reason               |

---

## 8. Recommendations Summary

### 8.1 Immediate Actions (Before Implementation)

| #   | Action                                                                   | Owner         | Deliverable                                                               |
| --- | ------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------- |
| 1   | **Research MAX webhook signature verification**                          | Security Lead | Document verification mechanism, write `verifyMaxWebhookSignature()` spec |
| 2   | **Define runtime `channel.max.*` interface as a TypeScript file**        | Platform Team | `src/runtime/channels/max.d.ts`                                           |
| 3   | **Reconcile rate limit: 20 rps (in code docs) vs 30 rps (MAX API docs)** | Backend Dev   | Confirmed value, update `rate-limiter.ts`                                 |
| 4   | **Verify MAX message length limit (currently "assumed ~4096")**          | QA            | Confirmed boundary value                                                  |
| 5   | **Register staging MAX bot for E2E testing**                             | DevOps        | Bot token stored in CI secrets                                            |
| 6   | **Evaluate `@maxhub/max-bot-api` SDK fitness**                           | Tech Lead     | Assessment doc: API coverage, test quality, maintenance risk              |

### 8.2 Implementation Phase

| #   | Action                                                | Owner    | Deliverable                              |
| --- | ----------------------------------------------------- | -------- | ---------------------------------------- |
| 7   | Write unit tests (20+) before implementation (TDD)    | Dev + QA | `extensions/max/tests/unit/`             |
| 8   | Write integration tests (10) with mock MAX API server | QA       | `extensions/max/tests/integration/`      |
| 9   | Create thin SDK adapter layer (`MaxApiClient`)        | Dev      | `src/runtime/channels/max-api-client.ts` |
| 10  | Implement webhook event handler for all 9 event types | Dev      | Event mapping with tests                 |
| 11  | Implement rate limiter with confirmed 30 rps limit    | Dev      | Token bucket with tests                  |
| 12  | Add `"max"` to `CHAT_CHANNEL_ORDER`                   | Dev      | `src/channels/registry.ts` update        |

### 8.3 Post-Implementation

| #   | Action                                                                  | Owner         | Deliverable                 |
| --- | ----------------------------------------------------------------------- | ------------- | --------------------------- |
| 13  | Write E2E test suite against real MAX API                               | QA            | `extensions/max/tests/e2e/` |
| 14  | Security audit: token leakage, webhook verification, input sanitization | Security Lead | Signed-off security report  |
| 15  | Load test: sustained 30 rps for 10 minutes, verify zero drops           | QA            | Load test report            |
| 16  | SDK version pinning and monthly maintenance check                       | DevOps        | CI check, calendar reminder |

---

## 9. Appendix: Test Coverage Traceability Matrix

| ADR Section                       | Acceptance Tests | Unit Tests             | Integration Tests | E2E Tests      | Security Tests |
| --------------------------------- | ---------------- | ---------------------- | ----------------- | -------------- | -------------- |
| 1. Extension structure            | --               | U-14, U-15, U-16       | --                | --             | --             |
| 2. ChannelPlugin sections         | AT-04..07        | U-01..06               | I-03, I-04        | E2E-02..04     | --             |
| 3. Platform registration          | --               | U-01                   | --                | --             | --             |
| 4. Runtime API surface            | AT-04, AT-05     | U-03, U-04, U-10, U-11 | I-01..04, I-09    | E2E-01..04     | --             |
| 5. Config schema                  | AT-29..32        | U-07..09, U-18..20     | --                | --             | S-14           |
| 6. Webhook events                 | AT-08..16        | U-17                   | I-05, I-06, I-09  | E2E-05, E2E-06 | S-01..08       |
| 7. Modular design                 | --               | U-14..16               | --                | --             | --             |
| Invariant 1: Token security       | AT-35            | --                     | --                | --             | S-09..15       |
| Invariant 2: Webhook verification | AT-33, AT-34     | --                     | --                | --             | S-01..08       |
| Invariant 3: Rate compliance      | AT-17..19        | --                     | I-07, I-08        | E2E-07         | S-23..27       |
| Invariant 4: Gateway exclusivity  | AT-22            | U-11, U-12             | --                | --             | --             |
| Invariant 5: Graceful shutdown    | AT-27, AT-28     | U-12                   | I-10              | --             | --             |
| Error handling                    | AT-23..26        | --                     | I-02, I-08        | --             | --             |

**Total test cases identified**: 35 acceptance tests + 20 unit tests + 10 integration tests + 7 E2E tests + 27 security tests = **99 test cases**
