---
summary: "Retry policy for outbound provider calls"
read_when:
  - Updating provider retry behavior or defaults
  - Debugging provider send errors or rate limits
title: "Retry policy"
---

## Goals

- Retry per HTTP request, not per multi-step flow.
- Preserve ordering by retrying only the current step.
- Avoid duplicating non-idempotent operations.

## Defaults

These defaults apply to channel sends. Model requests use the recovery policy below.

| Setting       | Default   | Applies to                                                             |
| ------------- | --------- | ---------------------------------------------------------------------- |
| Attempts      | 3         | Every envelope below                                                   |
| Jitter        | 0.1 (10%) | Every envelope below                                                   |
| Min delay     | 400 ms    | The shared channel envelope: Telegram and any channel with no override |
| Min delay     | 500 ms    | Discord sends and Discord REST calls                                   |
| Max delay cap | 30000 ms  | The shared channel envelope and Discord sends                          |
| Max delay cap | 300000 ms | Discord REST API calls                                                 |

These are per-request envelopes. The Discord Gateway WebSocket reconnect loop is
separate and does not use them: it allows up to 50 reconnect attempts and backs
off exponentially from 2000 ms to a 30000 ms cap, with no jitter.

## Behavior

### Model providers

Agent runs automatically recover from temporary rate limits, overloads, and provider failures before showing a terminal error. Rate limits receive up to 10 total attempts; other transient failures allow eight retries within a 90-second retry window. A completed successful model response clears the outage window, so useful model and tool work between failures does not consume it. Partial streams, failed responses, and tool activity alone do not clear it. The retry count remains bounded across the whole run. Backoff starts around one second, increases exponentially, and adds jitter to spread concurrent retries. Provider pacing, including `retry-after`, `retry-after-ms`, and “Please try again in …” hints, sets the minimum wait even beyond the 30-second backoff cap. Cancellation and the run deadline still stop recovery.

Recovery continues the existing transcript with an instruction to preserve completed work and inspect interrupted actions before deciding whether to repeat them. It can recover a throttle after tool activity or partial output without resubmitting the original user request. The run shows one transient retry indicator while waiting and remains cancellable. Recovered attempts do not leave persisted assistant errors; only terminal failure retains one error. Billing failures, authentication errors, and provider refusals do not use this transient retry budget.

In the embedded runtime, a model idle timeout after tool activity also uses this recovery when every tool in the latest batch has a recorded result and all tool execution has settled. The next attempt keeps tools available to finish the task, including handling a recorded tool failure. Pending approval, asynchronous tool activity, intentional tool termination, cancellation, and the run deadline still prevent this continuation. Completed actions are not resubmitted.

A Responses stream that ends before its terminal event also qualifies for transient recovery, including when a tool call is still unfinished. Partial tool arguments are never executed. A completed response with inconsistent tool-call identities does not qualify as a disconnected stream. A Gemini or Vertex AI stream that ends partway through an event frame qualifies the same way; a complete frame containing malformed JSON does not.

If a Responses request reaches its output-token limit while generating a tool call, the embedded runner also continues automatically from recorded results after admitted tools settle. It keeps the same model and account, preserves completed actions, and never executes partial arguments. This continuation shares the retry-count budget and run deadline, but not the 90-second outage window: generating a full response can take longer than that. Cancellation, pending approval, active asynchronous work, and intentional tool termination still stop continuation. Provider refusals and unknown incomplete-response reasons do not qualify.

Exhausted subscription, daily, weekly, or monthly usage windows go directly to eligible auth-profile or model fallback. A `Retry-After` value alone does not establish usage-window exhaustion: temporary throttles still honor the provider's minimum wait up to the saved `retry.provider.maxRetryDelayMs` (default 60 seconds). A rate-limit floor longer than that cap goes directly to fallback when one is configured, since the operator has already said how long a server-requested wait may hold the run; with no fallback configured the floor is honored in full, and `maxRetryDelayMs: 0` disables the cap.

The [model failover controller](/concepts/model-failover#model-fallback) owns this recovery budget. Once it is exhausted, OpenClaw follows eligible auth-profile or model fallback paths, or surfaces the final failure. Native harnesses may retry individual requests internally before returning a terminal failure to OpenClaw; those internal retries are separate from OpenClaw's continuation budget.

ChatGPT SSE errors preserve HTTP status and `Retry-After` together, so a transient HTTP response remains retryable even when its message or provider code is unfamiliar. The ChatGPT transport separately reconnects once for `websocket_connection_limit_reached` before streaming; this is not an SSE HTTP-response retry.

For SDK calls that retain internal retries, Stainless-based SDKs such as Anthropic and OpenAI can receive `retry-after-ms` or `retry-after` on retryable responses (`408`, `409`, `429`, and `5xx`). When that wait is longer than 60 seconds, OpenClaw injects `x-should-retry: false` so the SDK returns control promptly. Override this SDK-only cap with `OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS=<seconds>`. Set it to `0`, `false`, `off`, `none`, or `disabled` to let those SDK calls honor long `Retry-After` sleeps internally.

### Managed Git operations

The shared Git runner retries transient `fetch` and `ls-remote` failures once,
after a one-second delay within the command's original timeout. This includes
incomplete object transfers, connection resets, temporary DNS failures, and
transient HTTP errors. Managed project clones use the same policy and remove
their failed partial checkout before retrying. Cancellation stops the retry,
and workspace or publication authority is checked again before another attempt.
Each scheduled retry writes a `git/network` warning with the operation, attempt
count, delay, and exit code. It omits command arguments, repository URLs, and raw
Git output.

Authentication failures, missing repositories or refs, local storage failures,
process termination, and exhausted command timeouts are not retried. `push` and
`pull` are not replayed by this runner: a failed connection can follow an accepted
write, so publication keeps its existing remote-outcome reconciliation. This
policy does not wrap arbitrary Git commands run by agents or setup scripts.

### Discord

- Retries on rate-limit errors (HTTP 429), request timeouts, HTTP 5xx responses, and transient transport failures such as DNS lookup failures, connection resets, socket closes, and fetch failures.
- Uses Discord `retry_after` when available, otherwise exponential backoff.

### Telegram

- With the built-in transport, new text messages and rich-text messages use fresh HTTP connections, avoiding stale keep-alive sockets for initial previews, replies, and terminal errors. Polling, edits, and control requests retain connection pooling. This adds a connection handshake to each new text message.
- These non-idempotent text sends retry only when Telegram rejects the request with flood control (429) or the transport proves the request did not start. A reset, timeout, or lost response after sending remains ambiguous and is not replayed.
- Idempotent operations, such as editing an existing message, can retry transient network failures.
- Uses `retry_after` when available, otherwise exponential backoff.
- HTML/Markdown parse errors are not retried; they fall back to plain text on the first attempt.

## Configuration

Discord and Telegram channel retry timings are built in and are not configurable in `openclaw.json`.

The embedded runtime's existing session setting `retry.provider.maxRetries` overrides its recovery retry budget; `0` disables retries, and rate limits remain capped at 10 total attempts. This is an embedded session setting, not an `openclaw.json` key, and it does not configure native harness request retries. Automatic recovery requires no new configuration.

## Notes

- Retries apply per request (message send, media upload, reaction, poll, sticker).
- Composite flows do not retry completed steps.

### Durable outbound delivery

The durable outbound queue has a separate delivery-attempt budget. When a
delivery uses a producer claim, reservation checks the exact owner and its lease
before charging an attempt. An expired or replaced claim does not spend the
remaining budget; recovery can acquire a fresh claim before retrying.

Producer leases last 60 seconds and renew every 20 seconds while the owner is
active. This tolerates brief Gateway stalls; recovery of a vanished producer
waits until its last lease expires.

Lease expiry does not erase evidence that a send already started. Those entries
still require reconciliation before replay, and an unreplaced owner can record a
late result without authorizing another send.

## Related

- [Model failover](/concepts/model-failover)
- [Command queue](/concepts/queue)
- [Streaming and chunking](/concepts/streaming)
