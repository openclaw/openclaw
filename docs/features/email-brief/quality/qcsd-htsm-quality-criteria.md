# HTSM Quality Criteria Analysis: Email Brief Extension

**Framework:** Heuristic Test Strategy Model (HTSM) — Quality Criteria Catalog
**Date:** 2026-02-20
**Analyst:** Quality Criteria Analyst (HTSM)
**Scope:** ADR-001 — Email Brief Extension (Gmail Summary via Telegram)
**Input:** `docs/features/email-brief/adr/ADR-001-email-brief.md`

---

## Summary Matrix

| #   | Quality Criterion | Risk Level | Key Concern                                                                                                                |
| --- | ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Capability        | **MEDIUM** | MIME parsing depth, HTML stripping, edge-case email formats                                                                |
| 2   | Reliability       | **HIGH**   | Gmail API rate limits, token refresh races, LLM timeouts under load                                                        |
| 3   | Usability         | **MEDIUM** | Service Account setup complexity, opaque Google Workspace delegation errors                                                |
| 4   | Security          | **HIGH**   | Private key in env vars / files, credential leak in error messages, no sender auth by default                              |
| 5   | Scalability       | **MEDIUM** | LLM context overflow with large inboxes, unbounded concurrent fetches                                                      |
| 6   | Performance       | **MEDIUM** | JWT+token exchange latency, serial message fetching, LLM cold start on Cloud.ru FM                                         |
| 7   | Installability    | **LOW**    | Pure TypeScript, no external binaries, standard plugin pattern                                                             |
| 8   | Compatibility     | **HIGH**   | Cloud.ru FM models lack tool use; prompt quality varies across GLM-4.7/Qwen3-Coder; context window limits differ per model |

---

## 1. Capability

**Risk Level: MEDIUM**

### What It Should Do

The extension must (a) parse user arguments into Gmail search queries, (b) authenticate via Service Account JWT, (c) fetch and extract email content from Gmail API v1, (d) build a summarization prompt, (e) invoke the LLM with `disableTools: true`, and (f) format the output as Telegram markdown.

### Concerns

| ID    | Concern                        | Severity | Detail                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-1.1 | MIME multipart traversal depth | Medium   | Gmail messages can have deeply nested `multipart/mixed > multipart/alternative > text/plain` structures. The ADR mentions "MIME multipart traversal" but does not specify a recursion depth limit. Real-world emails (especially forwarded chains) can nest 5+ levels deep.                      |
| C-1.2 | HTML-only email bodies         | Medium   | Many commercial emails have no `text/plain` part at all. The ADR acknowledges HTML stripping as a missing requirement (MR-04 in the shift-left report) but provides no specification for the stripping algorithm. Naive tag removal leaves artifacts (CSS, `<style>` blocks, `&nbsp;` entities). |
| C-1.3 | Base64url vs standard Base64   | Low      | Gmail API returns body data in base64url encoding (RFC 4648 Section 5), not standard base64. Node.js `Buffer.from(data, 'base64url')` handles this on Node 22+, but the ADR does not call out this specific encoding variant.                                                                    |
| C-1.4 | Non-Latin email content        | Low      | The ADR mentions "language detection" in the LLM prompt but does not address non-UTF-8 encoded email bodies (e.g., `charset=windows-1251` common in Russian corporate email). `Content-Type` charset must be respected during decoding.                                                          |
| C-1.5 | Empty results handling         | Low      | `/email_brief 1h` at 8 AM on Monday after a weekend will return zero messages. The ADR's "Graceful error on empty results" invariant is correct but needs a user-friendly message that suggests widening the period.                                                                             |
| C-1.6 | Urgent filter keyword coverage | Low      | The urgent query uses `subject:(urgent OR ASAP)` but does not cover common Russian urgency markers beyond `"срочно"`. Corporate environments may use `"важно"`, `"СРОЧНО"`, `"приоритет"`.                                                                                                       |

### Test Ideas

- **Unit:** Parse every supported MIME structure (plain-only, HTML-only, multipart/alternative, multipart/mixed with attachments, nested forwards with 5+ levels).
- **Unit:** Verify base64url decoding produces correct UTF-8 text for payloads containing `+`, `/`, and `=` padding variants.
- **Unit:** Verify HTML stripping removes `<style>` blocks, decodes HTML entities, preserves line breaks from `<br>` and `<p>` tags.
- **Unit:** Argument parser rejects invalid period formats (`0d`, `d`, `100x`, negative numbers).
- **Integration:** Mock Gmail API returning zero messages; verify the response text includes period-widening suggestion.
- **Integration:** Mock Gmail API returning messages with `charset=windows-1251` in Content-Type; verify body is decoded correctly or a graceful fallback is used.

---

## 2. Reliability

**Risk Level: HIGH**

### What Could Fail Under Stress

The extension chains three external I/O operations (Google OAuth token endpoint, Gmail API, LLM via gateway) in sequence. Any one of these can fail, timeout, or rate-limit.

### Concerns

| ID    | Concern                              | Severity | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-2.1 | Gmail API rate limits (HTTP 429)     | High     | Gmail API has a per-user quota of 250 quota units per second. Listing messages costs 5 units; getting a message costs 5 units. Fetching 20 messages in parallel = 100 units in a burst, which is safe for a single invocation, but repeated rapid invocations (e.g., user retrying after timeout) could trigger 429. The ADR mentions graceful handling but no exponential backoff or retry strategy is specified in the architecture. |
| R-2.2 | Token refresh race condition         | High     | If the cached access token expires mid-request (e.g., during the 15th message fetch in a batch), the Gmail API call fails with 401. The extension must detect this, refresh the token, and retry the failed request. The ADR mentions "auto-refresh" but does not specify retry-after-refresh behavior.                                                                                                                                |
| R-2.3 | LLM invocation timeout               | Medium   | `runEmbeddedPiAgent` with `disableTools: true` still routes through the gateway to Cloud.ru FM proxy. Cold starts on the proxy or slow model inference (GLM-4.7 on large prompts) can exceed default timeouts. The `llm-task` extension uses 30s default; email summarization of 20 emails may need 60-90s.                                                                                                                            |
| R-2.4 | Google OAuth token endpoint downtime | Medium   | The JWT-to-access-token exchange at `https://oauth2.googleapis.com/token` is a single point of failure. If it is unreachable (network partition, DNS failure), the entire command fails.                                                                                                                                                                                                                                               |
| R-2.5 | Partial Gmail API failure            | Medium   | If 15 of 20 message detail fetches succeed but 5 fail (network blip), the extension should summarize the 15 it has, not fail entirely. The ADR does not specify partial success behavior.                                                                                                                                                                                                                                              |
| R-2.6 | Corrupt or truncated email bodies    | Low      | Some emails have truncated base64 bodies (especially large attachments that hit Gmail's size limit). `Buffer.from()` on invalid base64 does not throw by default but produces garbage.                                                                                                                                                                                                                                                 |

### Test Ideas

- **Unit:** Token cache expiry logic: verify refresh is triggered when token age exceeds TTL minus a safety margin (e.g., 55 minutes, not 60).
- **Integration:** Mock Gmail API returning 429 on the 10th message fetch; verify backoff/retry or graceful degradation with partial results.
- **Integration:** Mock Gmail API returning 401 on message fetch after token was cached; verify token refresh and retry.
- **Integration:** Mock `runEmbeddedPiAgent` that hangs for 120s; verify timeout fires and fallback message is returned.
- **Integration:** Mock 5 of 20 message fetches failing with network error; verify the remaining 15 are summarized.
- **Stress:** Invoke `/email_brief` 10 times in 5 seconds from the same Telegram chat; verify no unhandled rejections and rate limit messages are returned.

---

## 3. Usability

**Risk Level: MEDIUM**

### User Experience Concerns

| ID    | Concern                                | Severity | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U-3.1 | Service Account setup is complex       | High     | Google Workspace domain-wide delegation requires: (1) create a GCP project, (2) enable Gmail API, (3) create a Service Account, (4) generate a JSON key, (5) open Google Workspace Admin Console, (6) grant domain-wide delegation with the gmail.readonly scope, (7) set the env var or config. This is 7+ steps, each with potential for misconfiguration. The ADR does not include a setup guide or wizard. The error message on failure must guide the user through these steps. |
| U-3.2 | Delegation error is cryptic            | High     | When domain-wide delegation is not configured, Google returns `"unauthorized_client"` in the token exchange. This generic OAuth error does not mention "delegation." The extension must map this to a human-readable message: "Domain-wide delegation has not been configured for this Service Account. Go to admin.google.com > Security > API Controls > Domain-wide Delegation and add client ID {X} with scope gmail.readonly."                                                  |
| U-3.3 | Argument syntax discoverability        | Medium   | The `/email_brief` command accepts positional arguments with no named flags. Users must know that `from:user@example.com` is a valid filter syntax. There is no `--help` sub-command. The `/help` listing should show usage examples.                                                                                                                                                                                                                                                |
| U-3.4 | No feedback during processing          | Medium   | Fetching 20 emails and running LLM summarization can take 10-30 seconds. Telegram users see no typing indicator or progress message. The extension should send a "Fetching emails..." intermediate message or use the Telegram `sendChatAction("typing")` API.                                                                                                                                                                                                                       |
| U-3.5 | Error messages expose internal details | Low      | Default error messages from `fetch()` failures include URLs with access tokens in headers. The extension must sanitize all error messages before returning them to the user.                                                                                                                                                                                                                                                                                                         |

### Test Ideas

- **Unit:** Verify error message for `unauthorized_client` includes delegation setup instructions with the Service Account's client ID.
- **Unit:** Verify error message for missing `GMAIL_SERVICE_ACCOUNT_KEY_PATH` includes the exact env var name and a brief setup guide.
- **Manual:** Walk through the full setup from scratch (new GCP project to working `/email_brief`); measure time and count failure points.
- **Manual:** Invoke `/email_brief` with no config at all; verify the first error message is actionable.
- **Integration:** Verify that command help text includes at least 3 usage examples.

---

## 4. Security

**Risk Level: HIGH**

### Concerns

| ID    | Concern                             | Severity | Detail                                                                                                                                                                                                                                                                                                                        |
| ----- | ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-4.1 | Private key in environment variable | Critical | The `GMAIL_SERVICE_ACCOUNT_KEY` env var contains the full JSON key including the RSA private key. If any logging, error reporting, or crash dump captures `process.env`, the private key is exposed. This is the most sensitive data in the system.                                                                           |
| S-4.2 | Private key in file system          | High     | `GMAIL_SERVICE_ACCOUNT_KEY_PATH` points to a JSON file with the private key. File permissions must be restricted (`chmod 600`). The extension does not validate file permissions before reading.                                                                                                                              |
| S-4.3 | Access token in error messages      | High     | If a Gmail API call fails, the `fetch()` response may include the `Authorization: Bearer {token}` header in error details. The extension must strip tokens from all error messages.                                                                                                                                           |
| S-4.4 | No sender authorization by default  | High     | The ADR does not specify whether `requireAuth` defaults to `true` for the command registration. If `requireAuth` is `false` or omitted, any Telegram user who knows the bot can invoke `/email_brief` and read the configured user's email. The shift-left report (MR-03) flags this but it is not yet in the ADR invariants. |
| S-4.5 | Email content forwarded to LLM      | Medium   | All email body text is sent to the LLM (Cloud.ru FM) for summarization. If emails contain sensitive data (passwords, PII, financial data), this data passes through the Cloud.ru proxy and the Cloud.ru Foundation Models API. The user must understand this data flow. There is no opt-in consent or warning.                |
| S-4.6 | Scope escalation risk               | Medium   | The ADR correctly specifies `gmail.readonly` scope. However, if the Service Account key is compromised, the attacker could request broader scopes (e.g., `gmail.compose`, `gmail.modify`). The readonly scope only limits the token request, not the key's capabilities.                                                      |
| S-4.7 | JWT replay window                   | Low      | JWTs are valid for up to 1 hour. If a JWT is intercepted before exchange, it can be replayed within that window. Using HTTPS for the token endpoint mitigates this, but the JWT itself has no nonce or jti claim.                                                                                                             |

### Test Ideas

- **Unit:** Verify that error messages from token exchange failures never contain the string `"private_key"` or `"-----BEGIN"`.
- **Unit:** Verify that error messages from Gmail API failures never contain `"Bearer "` followed by a token.
- **Unit:** Verify that the command registration sets `requireAuth: true`.
- **Integration:** Mock a scenario where an unauthorized sender (isAuthorizedSender=false) invokes the command; verify rejection before any Gmail API call is made.
- **Code review:** Grep the codebase for any `console.log`, `api.logger.debug`, or `api.logger.info` calls that could log `process.env.GMAIL_SERVICE_ACCOUNT_KEY` or the access token.
- **Security audit:** Verify the Service Account key file path is not logged, not included in error messages, and not accessible via any HTTP endpoint.

---

## 5. Scalability

**Risk Level: MEDIUM**

### Concerns

| ID     | Concern                              | Severity | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SC-5.1 | LLM context window overflow          | High     | Cloud.ru FM models have varying context windows: GLM-4.7 supports ~128K tokens, GLM-4.7-Flash ~128K, Qwen3-Coder ~262K. With `maxEmails=20` and ~2000 chars per email body, the total prompt is ~40K chars (~10K tokens for English, ~20K for Chinese/Russian). This fits, but if `maxEmails` is set higher (e.g., 50) or email bodies are not truncated, the prompt can overflow. The ADR mentions truncation as a consequence ("large emails must be truncated") but does not specify a truncation budget. |
| SC-5.2 | Unbounded concurrent message fetches | Medium   | If `maxEmails=50`, the extension would fire 50 concurrent HTTP requests to Gmail API. This could trigger rate limits (see R-2.1) and consume significant memory for response buffers. The shift-left report (MR-07) recommends a concurrency cap of 5, which is not in the ADR.                                                                                                                                                                                                                              |
| SC-5.3 | Multiple concurrent users            | Medium   | If multiple Telegram users invoke `/email_brief` simultaneously (each impersonating a different Gmail user), each invocation creates its own JWT, token, and Gmail API calls. There is no connection pooling or shared token cache across users. Each invocation is independent, which is correct for isolation but means resource usage scales linearly with concurrent users.                                                                                                                              |
| SC-5.4 | Telegram message size limit          | Medium   | Telegram messages are limited to 4096 characters. A summary of 20 emails will likely exceed this. The shift-left report (MR-01) identifies this and recommends using `chunkMarkdownText()`. The ADR does not mention chunking. If not implemented, the response will be silently truncated or rejected by the Telegram API.                                                                                                                                                                                  |
| SC-5.5 | Memory for large email bodies        | Low      | A single email body can be up to ~25 MB (Gmail attachment limit). Even with `format=full`, Gmail API returns the full body in the response. If multiple large emails are fetched simultaneously, memory usage could spike. Using `format=metadata` for the list call and only fetching full content for the top N emails would be more efficient.                                                                                                                                                            |

### Test Ideas

- **Unit:** Verify prompt builder respects a total character budget (e.g., 30K chars) and truncates individual email bodies proportionally.
- **Unit:** Verify `maxEmails` config is passed as `maxResults` to the Gmail API list call.
- **Integration:** Mock 50 messages with 5000-char bodies each; verify the prompt is truncated and the LLM is invoked with a prompt under the budget.
- **Integration:** Verify message fetching uses a concurrency limiter (e.g., `Promise.all` with batching of 5).
- **Integration:** Mock a Telegram response that exceeds 4096 characters; verify chunking splits correctly at markdown boundaries.

---

## 6. Performance

**Risk Level: MEDIUM**

### Concerns

| ID    | Concern                                 | Severity | Detail                                                                                                                                                                                                                                                                                                                       |
| ----- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-6.1 | JWT signing + token exchange latency    | Medium   | Each command invocation (when token cache is cold or expired) requires: (1) RSA-SHA256 signing via `node:crypto` (~1-5 ms), (2) HTTPS POST to `oauth2.googleapis.com/token` (~100-500 ms depending on network). This adds 100-500 ms to the first invocation. Subsequent invocations within the 1h TTL use the cached token. |
| P-6.2 | Sequential vs parallel message fetching | Medium   | The ADR does not specify whether message detail fetches are sequential or parallel. If sequential, fetching 20 messages at ~200 ms each = 4 seconds. If parallel (with concurrency cap of 5), it is ~800 ms. The reference `ask-agent` extension uses `Promise.all` for parallel operations.                                 |
| P-6.3 | LLM inference time on Cloud.ru FM       | High     | Cloud.ru FM models (GLM-4.7) can take 10-60 seconds to generate a summary of 20 emails depending on model load, prompt size, and cold start. This is the dominant latency contributor. The user sees no progress during this time.                                                                                           |
| P-6.4 | Cold start of Cloud.ru proxy            | Medium   | The `legard/claude-code-proxy` Docker container may have cold start latency of 5-15 seconds if it was idle. Combined with LLM inference, total latency could reach 30-75 seconds.                                                                                                                                            |
| P-6.5 | Response formatting overhead            | Low      | Telegram markdown formatting is pure string manipulation, negligible overhead (<1 ms).                                                                                                                                                                                                                                       |

### Expected Latency Budget

| Phase                               | Cold (first call) | Warm (cached token) |
| ----------------------------------- | ----------------- | ------------------- |
| JWT signing                         | 5 ms              | 0 ms (cached)       |
| Token exchange                      | 300 ms            | 0 ms (cached)       |
| List messages                       | 200 ms            | 200 ms              |
| Fetch 20 messages (parallel, cap 5) | 800 ms            | 800 ms              |
| Body extraction + prompt building   | 10 ms             | 10 ms               |
| LLM summarization                   | 10-60 s           | 10-60 s             |
| Formatting + chunking               | 5 ms              | 5 ms                |
| **Total**                           | **11-62 s**       | **11-61 s**         |

### Test Ideas

- **Performance:** Measure end-to-end latency with mocked Gmail API (0 ms latency) to isolate LLM invocation time.
- **Performance:** Measure JWT signing time on the target deployment hardware (Node 22 on Cloud.ru VM).
- **Integration:** Verify token caching eliminates the token exchange call on the second invocation within 1 hour.
- **Integration:** Verify parallel message fetching completes in O(N/concurrency) time, not O(N) time.
- **Manual:** Measure real end-to-end latency with Cloud.ru FM GLM-4.7 for 5, 10, and 20 emails to establish baseline expectations.

---

## 7. Installability

**Risk Level: LOW**

### Concerns

| ID    | Concern                             | Severity | Detail                                                                                                                                                                                                                                                                                                                            |
| ----- | ----------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-7.1 | No external binary dependencies     | None     | The extension uses `node:crypto` for JWT signing and `fetch()` (global in Node 22+) for HTTP. No `gog`, `himalaya`, or other external CLIs are required. This is a significant advantage over the existing `src/hooks/gmail.ts` approach.                                                                                         |
| I-7.2 | Plugin manifest registration        | Low      | The extension uses the standard `openclaw.plugin.json` manifest pattern (same as `ask-agent`, `llm-task`, etc.). Plugin loading is automatic when the extension directory is present in `extensions/`.                                                                                                                            |
| I-7.3 | Environment variable configuration  | Low      | Two env vars (`GMAIL_SERVICE_ACCOUNT_KEY_PATH` or `GMAIL_SERVICE_ACCOUNT_KEY`, and `GMAIL_USER_EMAIL`) plus optional `openclaw.json` plugin config. This is comparable to other extensions (e.g., Telegram needs `TELEGRAM_BOT_TOKEN`).                                                                                           |
| I-7.4 | No database or state persistence    | None     | The extension is stateless per invocation. No database, no file-based cache, no persistent state. Token caching is in-memory (per process lifetime).                                                                                                                                                                              |
| I-7.5 | Google Workspace Admin prerequisite | Medium   | While the extension itself is easy to install, the Google Workspace domain-wide delegation prerequisite is an external dependency that is not under the extension's control. This is an installability concern at the organizational level, not a technical one. A clear error message and setup documentation can mitigate this. |

### Test Ideas

- **Smoke:** Install the extension in a fresh OpenClaw instance; verify plugin loads without errors (`pnpm openclaw gateway` starts cleanly).
- **Smoke:** Verify `/help` lists the `email_brief` command after plugin registration.
- **Unit:** Verify the plugin manifest (`openclaw.plugin.json`) is valid JSON and contains the required fields (`name`, `version`, `main`).
- **Integration:** Verify config resolution priority: `GMAIL_USER_EMAIL` env var overrides `config.plugins["email-brief"].userEmail`.

---

## 8. Compatibility

**Risk Level: HIGH**

### Cloud.ru FM Model Compatibility

This is the highest-risk criterion because the extension is specifically designed to work with Cloud.ru Foundation Models that **cannot perform tool use**. The entire architecture hinges on `disableTools: true` and text-only LLM interaction.

### Concerns

| ID     | Concern                             | Severity             | Detail                                                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CO-8.1 | No tool use on Cloud.ru FM models   | Critical (mitigated) | Cloud.ru FM models (GLM-4.7, Qwen3-Coder) cannot invoke tools. The ADR correctly addresses this with `disableTools: true` and pre-fetching all data in TypeScript. This is the core architectural decision. If `disableTools` is accidentally omitted, the invocation may fail or produce garbage. |
| CO-8.2 | Prompt quality varies across models | High                 | GLM-4.7 and Qwen3-Coder have different instruction-following capabilities. A summarization prompt optimized for one model may produce poor results on another. The ADR uses a single prompt for all models. Testing must cover all Cloud.ru FM presets.                                            |
| CO-8.3 | Context window size varies          | High                 | GLM-4.7-Flash (free tier) may have a smaller effective context window than GLM-4.7 (full). The truncation budget must be conservative enough to work with the smallest supported model. The ADR does not specify per-model context budgets.                                                        |
| CO-8.4 | Output format compliance            | Medium               | The prompt requests Telegram-formatted markdown with priority sections. Cheaper/smaller models (GLM-4.7-Flash) may not reliably produce the expected format. The extension should have a fallback parser that handles malformed LLM output gracefully.                                             |
| CO-8.5 | Bilingual prompt handling           | Medium               | The prompt includes both Russian and English urgency keywords. Cloud.ru FM models handle Russian well (they are trained on multilingual data), but the summarization quality for mixed-language emails (Russian + English in the same inbox) needs validation.                                     |
| CO-8.6 | Model response latency variance     | Medium               | GLM-4.7-Flash is significantly faster than GLM-4.7 or Qwen3-Coder-480B. The timeout value must accommodate the slowest model. If the user has `cloudru-fm-qwen` preset, Qwen3-Coder-480B may take 60+ seconds for a large summary.                                                                 |
| CO-8.7 | Proxy compatibility                 | Low                  | The `legard/claude-code-proxy` translates OpenAI-compatible API calls to Cloud.ru FM format. The `runEmbeddedPiAgent` function routes through this proxy. If the proxy has limitations on max input tokens or max output tokens, the summarization may be silently truncated.                      |
| CO-8.8 | Non-Cloud.ru model compatibility    | Low                  | The extension should also work with standard providers (Anthropic Claude, OpenAI) when `disableTools: true` is set. This is a positive side-effect of the architecture but is not explicitly tested.                                                                                               |

### Test Ideas

- **Unit:** Verify `disableTools: true` is always passed to `runEmbeddedPiAgent`, regardless of configuration.
- **Integration:** Mock `runEmbeddedPiAgent` returning output in unexpected format (no priority sections, plain text, markdown with wrong heading levels); verify fallback formatting handles it.
- **Integration:** Mock `runEmbeddedPiAgent` returning empty payloads; verify the fallback raw email list is returned.
- **Manual:** Run the same 10-email summarization prompt against all Cloud.ru FM presets (GLM-4.7, GLM-4.7-Flash, Qwen3-Coder) and compare output quality, format compliance, and latency.
- **Manual:** Run with a mixed Russian/English inbox on GLM-4.7 and verify language detection works correctly.
- **Manual:** Verify the extension works with a standard Anthropic Claude backend (non-Cloud.ru) as a compatibility baseline.

---

## Cross-Cutting Concerns

### Error Handling Strategy

The extension chains multiple fallible operations. The error handling strategy must follow a waterfall pattern:

```
1. Config validation errors     -> Return setup instructions (no API calls)
2. JWT/token errors             -> Return auth troubleshooting (no Gmail calls)
3. Gmail API errors             -> Return partial results or API error message
4. Body extraction errors       -> Skip corrupt emails, continue with rest
5. LLM invocation errors        -> Return raw email list as fallback
6. Formatting errors            -> Return unformatted text
```

Each layer must catch its own errors and provide a degraded but useful response rather than propagating an unhandled exception.

### Observability

The ADR does not mention logging or metrics. For production readiness:

- Log at `debug` level: JWT creation, token cache hit/miss, Gmail query, message count, prompt size.
- Log at `info` level: command invocation (sender, filters, period), success/failure, latency.
- Log at `error` level: authentication failures, API errors, LLM timeouts.
- Never log: private keys, access tokens, email body content, full email addresses (use masking).

### Testability Assessment

| Component                              | Testability | Mock Strategy                             |
| -------------------------------------- | ----------- | ----------------------------------------- |
| Argument parser (`parse-args.ts`)      | Excellent   | Pure function, no I/O                     |
| Gmail query builder (`gmail-query.ts`) | Excellent   | Pure function, no I/O                     |
| JWT auth (`gmail-client.ts`)           | Good        | Mock `fetch()` for token endpoint         |
| Gmail API calls (`gmail-client.ts`)    | Good        | Mock `fetch()` for Gmail endpoints        |
| MIME body extraction (`gmail-body.ts`) | Excellent   | Pure function on JSON input               |
| Prompt builder (`summarize.ts`)        | Good        | Pure function + mock `runEmbeddedPiAgent` |
| Command handler (`index.ts`)           | Good        | Mock all dependencies above               |
| Telegram formatting                    | Excellent   | Pure function, string output              |

Overall testability is high due to the clean separation between I/O (Gmail API, LLM) and pure logic (parsing, query building, body extraction, formatting). The ADR's file organization (`parse-args.ts`, `gmail-client.ts`, `gmail-query.ts`, `gmail-body.ts`, `summarize.ts`) supports this separation well.

---

## Recommended Priority Actions

### P0 — Must Fix Before Implementation

1. **Add `requireAuth: true` to command registration** (S-4.4). Without this, any Telegram user can read the configured user's email.
2. **Define credential sanitization rules** (S-4.1, S-4.3). Establish a `sanitizeError(err)` helper that strips private keys, access tokens, and email addresses from all error messages.
3. **Define per-email body truncation limit** (SC-5.1). Set a constant (e.g., `MAX_EMAIL_BODY_CHARS = 2000`) and a total prompt budget (e.g., `MAX_PROMPT_CHARS = 30000`).
4. **Specify Telegram message chunking** (SC-5.4). Use the existing `chunkMarkdownText()` utility with the 4096-character limit.

### P1 — Must Fix During Implementation

5. **Implement concurrency-limited parallel fetching** (SC-5.2, P-6.2). Use a semaphore pattern with a cap of 5 concurrent requests.
6. **Implement token refresh on 401 retry** (R-2.2). When a Gmail API call returns 401, clear the token cache, re-authenticate, and retry once.
7. **Add partial success handling** (R-2.5). If some message fetches fail, summarize the ones that succeeded and note the failures.
8. **Set LLM timeout to 90 seconds** (R-2.3, CO-8.6). This accommodates Qwen3-Coder-480B cold starts.
9. **Test with all Cloud.ru FM presets** (CO-8.2). Validate prompt quality on GLM-4.7, GLM-4.7-Flash, and Qwen3-Coder.

### P2 — Should Fix Before Release

10. **Add typing indicator** (U-3.4). Send `sendChatAction("typing")` before starting the Gmail fetch.
11. **Add delegation-specific error message** (U-3.2). Map `unauthorized_client` to actionable setup instructions.
12. **Handle charset encoding** (C-1.4). Read `charset` from Content-Type header and decode with `TextDecoder` for non-UTF-8 encodings.
13. **Add structured logging** (Observability). Use `api.logger` at appropriate levels per the logging guidelines above.

---

## Appendix: HTSM Quality Criteria Definitions

| Criterion      | HTSM Definition                                                    | Applied To Email Brief                                         |
| -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Capability     | The product does what it is supposed to do                         | Gmail fetch, parse, summarize, format                          |
| Reliability    | The product works consistently under varying conditions            | Rate limits, timeouts, token expiry, network failures          |
| Usability      | Real users can figure out how to use the product                   | Setup complexity, argument syntax, error messages              |
| Security       | The product protects data and resources from unauthorized access   | Credential handling, sender authorization, data exposure       |
| Scalability    | The product handles growth in data volume and users                | Large inboxes, many emails, concurrent users, context overflow |
| Performance    | The product responds quickly enough for the user context           | JWT latency, API call time, LLM inference time                 |
| Installability | The product can be successfully deployed in the target environment | Dependencies, config, env vars, external prerequisites         |
| Compatibility  | The product works with the required platforms and integrations     | Cloud.ru FM models, proxy compatibility, model variance        |
