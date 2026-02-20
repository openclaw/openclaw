# Shift-Left Testing Report: ADR-001 Email Brief Extension

## Level 4 — Risk Analysis in Design Phase

**Date**: 2026-02-20
**Analyst**: QA Shift-Left Testing Agent
**Scope**: ADR-001 — Email Brief Extension (Gmail Summary via Telegram)
**ADR Status**: ACCEPTED

---

## 1. Requirements Validation

### 1.1 Functional Requirements Testability

| #    | Requirement                                            | Testable? | Measurable Criteria? | Notes                                                      |
| ---- | ------------------------------------------------------ | --------- | -------------------- | ---------------------------------------------------------- |
| R-01 | Parse `/email_brief [filters] [period]` arguments      | Yes       | Yes                  | Deterministic parser, fully unit-testable                  |
| R-02 | Period regex `\d+[hdwm]`, default 1d                   | Yes       | Yes                  | Pure function, edge cases well-defined                     |
| R-03 | Support filters: from:, to:, urgent, unread, free text | Yes       | Yes                  | Each filter maps to a Gmail query fragment                 |
| R-04 | JWT auth via Service Account (node:crypto, RS256)      | Yes       | Yes                  | Can mock token endpoint, verify JWT structure              |
| R-05 | Access token caching with 1h TTL auto-refresh          | Yes       | Yes                  | Verify token reuse within TTL, refresh after expiry        |
| R-06 | Gmail API: list messages with search query             | Yes       | Yes                  | Mock HTTP, verify query construction                       |
| R-07 | Gmail API: get message content (full format)           | Yes       | Yes                  | Mock HTTP, verify header/body extraction                   |
| R-08 | Build Gmail search query from parsed args              | Yes       | Yes                  | Deterministic mapping, fully unit-testable                 |
| R-09 | Respect maxEmails limit (default 20)                   | Yes       | Yes                  | Verify maxResults param in API call                        |
| R-10 | Extract email metadata (from, subject, date, snippet)  | Yes       | Yes                  | Parse MIME headers from API response                       |
| R-11 | Extract email body text (plain text preferred)         | Yes       | Yes                  | Base64 decode, MIME part selection                         |
| R-12 | LLM summarization via runEmbeddedPiAgent               | Partial   | No                   | LLM output non-deterministic; test invocation, not content |
| R-13 | Summarization prompt with priority tiers               | Yes       | No                   | Can verify prompt construction, not LLM quality            |
| R-14 | Format response for Telegram markdown                  | Yes       | Yes                  | Deterministic formatting, verify markdown output           |
| R-15 | Graceful error on missing credentials                  | Yes       | Yes                  | Return user-friendly message, not throw                    |
| R-16 | Graceful error on Gmail API failure                    | Yes       | Yes                  | HTTP 401/403/429/500 mapped to messages                    |
| R-17 | Graceful error on LLM failure/timeout                  | Yes       | Yes                  | Empty payloads, timeout → fallback message                 |
| R-18 | Plugin manifest with configSchema                      | Yes       | Yes                  | AJV validates at load time                                 |
| R-19 | Config from env vars and openclaw.json                 | Yes       | Yes                  | Test resolution order: env > config > default              |

**Score: 89/100** — Strong testability. R-12 is inherently non-deterministic (LLM output) but can be tested at integration boundaries. All other requirements are fully testable with mocks.

### 1.2 Missing Requirements

| #     | Missing Requirement                            | Impact | Recommendation                                                          |
| ----- | ---------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| MR-01 | Telegram message chunking for long digests     | High   | Use `resolveTextChunkLimit()` + `chunkMarkdownText()` (4000 char limit) |
| MR-02 | Email body truncation for LLM context window   | High   | Truncate per-email body to ~2000 chars, total prompt to ~30k chars      |
| MR-03 | Sender authorization check                     | High   | Check `ctx.isAuthorizedSender` before processing                        |
| MR-04 | HTML email body stripping                      | Medium | Strip HTML tags from email body, extract plain text                     |
| MR-05 | Base64url decoding for Gmail API body parts    | Medium | Gmail returns body data as base64url-encoded                            |
| MR-06 | MIME multipart traversal                       | Medium | Walk `payload.parts[]` tree to find text/plain or text/html             |
| MR-07 | Concurrent message fetching with limit         | Medium | Fetch message details in parallel (Promise.all) with concurrency cap    |
| MR-08 | Empty inbox handling                           | Low    | Return friendly message when no messages match filters                  |
| MR-09 | Logging at key checkpoints                     | Low    | Use `api.logger` for debug/info/error per codebase patterns             |
| MR-10 | Cleanup tmp session files after LLM invocation | Low    | Use `finally` block per llm-task pattern                                |

### 1.3 Acceptance Criteria Assessment

All 19 functional requirements have clear acceptance criteria except R-12 (LLM output quality). For R-12, acceptance is defined as: LLM is invoked correctly with well-formed prompt, and non-empty text is returned.

---

## 2. Acceptance Tests (Given-When-Then)

### Argument Parsing

```gherkin
Feature: Email Brief Argument Parsing

  Scenario: Default invocation with no arguments
    Given no arguments are provided
    When the args parser processes the input
    Then the period should be "1d"
    And no filters should be set

  Scenario: Period-only argument
    Given the argument "7d"
    When the args parser processes the input
    Then the period should be "7d"
    And no filters should be set

  Scenario: Hour-based period
    Given the argument "3h"
    When the args parser processes the input
    Then the period should be "3h"

  Scenario: Week-based period
    Given the argument "2w"
    When the args parser processes the input
    Then the period should be "2w"

  Scenario: Month-based period
    Given the argument "1m"
    When the args parser processes the input
    Then the period should be "1m"

  Scenario: From filter with period
    Given the arguments "from:user@company.com 7d"
    When the args parser processes the input
    Then the period should be "7d"
    And the from filter should be "user@company.com"

  Scenario: Urgent filter
    Given the argument "urgent"
    When the args parser processes the input
    Then the urgent flag should be true
    And the period should be "1d"

  Scenario: Urgent filter with period
    Given the arguments "urgent 3d"
    When the args parser processes the input
    Then the urgent flag should be true
    And the period should be "3d"

  Scenario: Multiple filters combined
    Given the arguments "from:boss@work.com urgent 2d"
    When the args parser processes the input
    Then the from filter should be "boss@work.com"
    And the urgent flag should be true
    And the period should be "2d"

  Scenario: Free text filter
    Given the arguments "project-alpha 7d"
    When the args parser processes the input
    Then the free text query should include "project-alpha"
    And the period should be "7d"
```

### JWT Authentication

```gherkin
Feature: Google Service Account JWT Authentication

  Scenario: Successful token acquisition
    Given a valid service account JSON key is configured
    And a valid user email is configured for impersonation
    When the Gmail client requests an access token
    Then a JWT should be signed with RS256 using node:crypto
    And the JWT should contain the gmail.readonly scope
    And the JWT should contain the impersonated user email as "sub"
    And the token endpoint should return an access token

  Scenario: Token caching within TTL
    Given an access token was acquired 30 minutes ago
    When the Gmail client requests an access token again
    Then the cached token should be returned
    And no HTTP request should be made to the token endpoint

  Scenario: Token refresh after expiry
    Given an access token was acquired 61 minutes ago
    When the Gmail client requests an access token again
    Then a new JWT should be signed and exchanged
    And the new access token should be cached

  Scenario: Missing service account key
    Given no GMAIL_SERVICE_ACCOUNT_KEY_PATH or GMAIL_SERVICE_ACCOUNT_KEY is set
    When the command is invoked
    Then an error message should be returned with setup instructions

  Scenario: Invalid service account key JSON
    Given GMAIL_SERVICE_ACCOUNT_KEY contains malformed JSON
    When the Gmail client attempts to parse the key
    Then an error message should indicate invalid credentials format

  Scenario: Missing user email for impersonation
    Given a valid service account key is configured
    But no GMAIL_USER_EMAIL or config userEmail is set
    When the command is invoked
    Then an error message should be returned requesting the user email

  Scenario: Token endpoint returns 401
    Given an expired or revoked service account key
    When the JWT is exchanged for an access token
    Then an authentication error message should be returned
```

### Gmail API Integration

```gherkin
Feature: Gmail API Message Fetching

  Scenario: List messages with default period
    Given a valid access token
    When listing messages with no filters
    Then the Gmail API query should be "newer_than:1d in:inbox"
    And maxResults should be 20

  Scenario: List messages with period and from filter
    Given a valid access token
    When listing messages with from "user@test.com" and period "7d"
    Then the Gmail API query should include "newer_than:7d"
    And the query should include "from:user@test.com"
    And the query should include "in:inbox"

  Scenario: List messages with urgent filter
    Given a valid access token
    When listing messages with the urgent flag
    Then the Gmail API query should include "is:important"
    And the query should include urgency keywords

  Scenario: Get message details with full format
    Given a list of message IDs
    When fetching message details
    Then each message should be fetched with format=full
    And message headers (From, Subject, Date) should be extracted
    And the plain text body part should be extracted

  Scenario: Handle empty inbox
    Given no messages match the search query
    When the Gmail API returns an empty result
    Then a friendly "no emails found" message should be returned

  Scenario: Handle Gmail API rate limit (429)
    Given the Gmail API returns HTTP 429
    When the error is caught
    Then a message about rate limiting should be returned

  Scenario: Handle Gmail API auth error (401/403)
    Given the Gmail API returns HTTP 401
    When the error is caught
    Then a message about credentials should be returned

  Scenario: Respect maxEmails config limit
    Given maxEmails is set to 5
    When listing messages
    Then maxResults should be 5

  Scenario: Concurrent message detail fetching
    Given 10 message IDs to fetch
    When fetching details
    Then requests should be made concurrently
    And results should be collected in order

  Scenario: HTML body fallback when no plain text
    Given a message with only text/html body part
    When extracting the body
    Then HTML tags should be stripped
    And plain text should be extracted

  Scenario: Base64url body decoding
    Given a message with base64url-encoded body
    When extracting the body
    Then the body should be correctly decoded to UTF-8

  Scenario: Nested MIME parts traversal
    Given a message with multipart/alternative containing text/plain
    When extracting the body
    Then the text/plain part should be found by traversal
```

### LLM Summarization

```gherkin
Feature: Email Summarization via LLM

  Scenario: Successful summarization
    Given 5 emails with extracted metadata and body text
    When runEmbeddedPiAgent is called with disableTools=true
    Then the prompt should contain all email summaries
    And the prompt should include formatting instructions
    And a non-empty text response should be returned

  Scenario: Email body truncation for context limit
    Given an email with a 50,000 character body
    When building the prompt
    Then the body should be truncated to the configured limit
    And a "[truncated]" marker should be appended

  Scenario: Total prompt size limit
    Given 20 emails totaling 100,000 characters
    When building the prompt
    Then the total prompt should not exceed the context limit
    And later emails should be summarized more aggressively

  Scenario: LLM returns empty response
    Given runEmbeddedPiAgent returns empty payloads
    When processing the result
    Then a fallback message with raw email list should be returned

  Scenario: LLM invocation timeout
    Given runEmbeddedPiAgent exceeds timeoutMs
    When the timeout fires
    Then a timeout error message should be returned
    And temporary session files should be cleaned up

  Scenario: Urgent mode prompt
    Given the urgent flag is set
    When building the prompt
    Then the instructions should emphasize urgency scoring
    And draft reply suggestions should be requested
```

### Security and Authorization

```gherkin
Feature: Command Authorization

  Scenario: Authorized sender invokes command
    Given a sender with isAuthorizedSender=true
    When /email_brief is invoked
    Then the command should be processed normally

  Scenario: Unauthorized sender invokes command
    Given a sender with isAuthorizedSender=false
    When /email_brief is invoked
    Then the command should be rejected
    And no Gmail API calls should be made

  Scenario: Service account key never exposed in responses
    Given any error occurs during processing
    When the error message is formatted
    Then the response should not contain the private key
    And the response should not contain the access token
```

### Telegram Output

```gherkin
Feature: Telegram Response Formatting

  Scenario: Response fits in single message
    Given a summary under 4000 characters
    When formatting the response
    Then a single text response should be returned

  Scenario: Response exceeds Telegram limit
    Given a summary over 4000 characters
    When the response is delivered via Telegram
    Then the chunking pipeline should split the message
    And each chunk should be valid markdown

  Scenario: Response includes priority sections
    Given emails with mixed urgency
    When the LLM produces a summary
    Then the output should have priority sections (urgent, action-required, informational)
```

---

## 3. Risk Analysis

### 3.1 Technical Risk Matrix

| ID    | Risk                                               | Probability | Impact | Severity | Category    |
| ----- | -------------------------------------------------- | ----------- | ------ | -------- | ----------- |
| TR-01 | Gmail API rate limits (429) during message fetch   | 3           | 3      | 9        | Integration |
| TR-02 | Service Account delegation not configured          | 4           | 5      | 20       | Setup       |
| TR-03 | LLM context overflow with many/large emails        | 3           | 4      | 12       | Technical   |
| TR-04 | JWT signing incompatibility across Node versions   | 1           | 4      | 4        | Technical   |
| TR-05 | Gmail API schema changes                           | 1           | 3      | 3        | Integration |
| TR-06 | LLM timeout on large digests                       | 3           | 2      | 6        | Performance |
| TR-07 | Token endpoint unreachable (network issues)        | 2           | 4      | 8        | Integration |
| TR-08 | Email body encoding issues (non-UTF8, corrupt b64) | 2           | 2      | 4        | Technical   |
| TR-09 | Private key exposure in error messages/logs        | 1           | 5      | 5        | Security    |
| TR-10 | Cloud.ru FM model fails to produce useful summary  | 2           | 3      | 6        | Technical   |

### 3.2 Mitigation Strategies

| Risk ID | Mitigation Strategy                                                | Owner | Priority |
| ------- | ------------------------------------------------------------------ | ----- | -------- |
| TR-01   | Implement exponential backoff; cap concurrent requests to 5        | Dev   | P1       |
| TR-02   | Clear setup guide in error message; link to Workspace Admin docs   | Dev   | P0       |
| TR-03   | Truncate per-email body; cap total prompt size; reduce email count | Dev   | P0       |
| TR-04   | Use standard `node:crypto` RSA-SHA256; test on Node 22+            | Dev   | P2       |
| TR-05   | Pin known response fields; graceful fallback on missing fields     | Dev   | P2       |
| TR-06   | Set 60s timeout; return raw email list on LLM timeout              | Dev   | P1       |
| TR-07   | Cache tokens aggressively; retry once on network error             | Dev   | P1       |
| TR-08   | Try/catch base64 decode; skip corrupt bodies with warning          | Dev   | P2       |
| TR-09   | Never log private key; sanitize error messages                     | Dev   | P0       |
| TR-10   | Fallback to structured email list if LLM output empty/broken       | Dev   | P1       |

### 3.3 Dependency Risk

| Dependency             | Availability Risk | Version Risk | Security Risk | Mitigation                            |
| ---------------------- | ----------------- | ------------ | ------------- | ------------------------------------- |
| Gmail API v1           | Low               | Low          | Low           | Google SLA, stable API                |
| Google OAuth2 token EP | Low               | Low          | Low           | Standard OAuth2 infra                 |
| node:crypto            | None              | None         | None          | Built into Node.js                    |
| runEmbeddedPiAgent     | None              | Medium       | None          | Internal API; follow breaking changes |
| Cloud.ru FM models     | Medium            | Medium       | Low           | Fallback to raw email list            |

---

## 4. Test Architecture

### 4.1 Test Tiers

```
        /  E2E  \          (~10%)
       /----------\
      / Integration \      (~30%)
     /----------------\
    /     Unit Tests    \  (~60%)
   /--------------------\
```

| Tier        | Count | What It Validates                                                          |
| ----------- | ----- | -------------------------------------------------------------------------- |
| Unit        | ~25   | Arg parsing, JWT construction, query building, body extraction, formatting |
| Integration | ~10   | Gmail API mock (HTTP), LLM invocation mock, config resolution              |
| E2E         | ~3    | Full command flow with mocked Gmail + mocked LLM                           |

### 4.2 Test File Organization

```
extensions/email-brief/
  index.ts                     # Entry point, command registration
  index.test.ts                # E2E: full command handler with mocks
  parse-args.ts                # Argument parser
  parse-args.test.ts           # Unit: all arg combinations
  gmail-client.ts              # JWT auth + Gmail API
  gmail-client.test.ts         # Integration: mocked HTTP
  gmail-query.ts               # Search query builder
  gmail-query.test.ts          # Unit: query construction
  gmail-body.ts                # MIME traversal, body extraction
  gmail-body.test.ts           # Unit: various MIME structures
  summarize.ts                 # Prompt builder + LLM invocation
  summarize.test.ts            # Integration: mocked runEmbeddedPiAgent
  openclaw.plugin.json         # Manifest
```

### 4.3 Mock Strategy

| What to Mock                 | Approach                                  | Justification                                    |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------ |
| Gmail API HTTP calls         | Custom `fetchImpl` mock (as in ask-agent) | Avoid real Google calls; control response shapes |
| Google OAuth2 token endpoint | Same fetchImpl mock                       | Test JWT → token exchange without network        |
| `runEmbeddedPiAgent`         | `vi.mock()` the module                    | Control LLM output; test prompt construction     |
| Service Account key file     | Temp file with test key in fixtures       | Test file reading without real credentials       |
| `node:crypto` signing        | No mock needed — use real signing         | Deterministic with known key; fast               |
| `api.logger`                 | Noop logger object                        | Prevent noise in test output                     |
| `ctx.config`                 | Object literal with test values           | Control config resolution                        |

---

## 5. Recommendations Summary

### 5.1 Immediate Actions (Before Implementation)

| #   | Action                                          | Owner | Deliverable                 |
| --- | ----------------------------------------------- | ----- | --------------------------- |
| 1   | Add MR-01 through MR-07 to ADR as requirements  | Dev   | Updated ADR                 |
| 2   | Define max prompt size constant (30k chars)     | Dev   | Constant in gmail-client.ts |
| 3   | Prepare test fixture: fake SA key (RSA keypair) | Dev   | Test fixture file           |
| 4   | Prepare test fixture: Gmail API responses       | Dev   | JSON fixture files          |

### 5.2 Implementation Phase

| #   | Action                                             | Owner | Deliverable             |
| --- | -------------------------------------------------- | ----- | ----------------------- |
| 1   | Implement arg parser with full test coverage first | Dev   | parse-args.ts + tests   |
| 2   | Implement JWT auth with token caching              | Dev   | gmail-client.ts + tests |
| 3   | Implement Gmail query builder                      | Dev   | gmail-query.ts + tests  |
| 4   | Implement MIME body extraction                     | Dev   | gmail-body.ts + tests   |
| 5   | Implement summarization prompt + LLM invocation    | Dev   | summarize.ts + tests    |
| 6   | Wire up command handler with authorization check   | Dev   | index.ts + tests        |
| 7   | Run `pnpm check` after each module                 | Dev   | Clean lint/types        |

### 5.3 Post-Implementation

| #   | Action                                         | Owner | Deliverable                   |
| --- | ---------------------------------------------- | ----- | ----------------------------- |
| 1   | Manual Telegram test with real Gmail account   | QA    | Test report                   |
| 2   | Verify chunking with 50+ email digest          | QA    | Chunking validation           |
| 3   | Test with Cloud.ru FM models (not just Claude) | QA    | FM compatibility confirmation |
| 4   | Document setup steps (SA creation, delegation) | Dev   | Setup guide                   |

---

Total test cases identified: ~25 unit + ~10 integration + ~3 E2E = **~38 test cases**
