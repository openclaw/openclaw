# Telegram E2E verification map

This map is the maintained source for proving what an OpenClaw Telegram user
sees through the dedicated QA user account.

## Baseline preconditions

- Complete Prepare and proof-directory creation in [`SKILL.md`](../SKILL.md). The runner performs strict readiness on the same lease used for the scenario.

## Driving conventions

- Use `run-mock-sut-user-e2e.mjs` for every recipe. It owns a fresh SUT gateway.
- Prefer `--dm` for isolated turns. Use the group only when group policy, mentions, commands, topics, or reactions are part of the claim.
- Give every feature its own proof subdirectory and explicit `--record` plus `--output` paths.
- After a failed drive, preserve the evidence and repair the setup or harness before another attempt. The changed scenario must pass readiness on its own lease; use a standalone doctor only to isolate a credential problem.

## Proof gate

- Apply the evidence and cleanup gates from `SKILL.md` to every recipe.
- For an unreachable path, record the exact command, attempted in-scope setup
  and remaining access, platform or external-service boundary. A missing test
  chat alone is a fixture to create, not an unreachable path.

## Features

- [Basic turns](./basic-turns.md): real-user group, DM, and native-command entry points.
- [Delivery lifecycle](./delivery-lifecycle.md): messages, edits, typing, and finalization.
- [Private yielded reply policy](./private-yield-reply-policy.md): real private-child settlement with tool-only and automatic delivery controls.
- [Restart attribution](./restart-attribution.md): visible baseline, process replacement, and a distinct fresh reply.
- [Reaction lifecycle](./reaction-lifecycle.md): acknowledgement and status reactions on the user's message.
- Photo and album turns: pass `--photo PATH` to the canonical runner; repeat it for one Telegram media album and inspect `messagePhoto` events plus provider evidence. That album goes out when recording starts, before the Gateway's poller is long-polling, so Telegram hands every member back in one `getUpdates` response. For album delivery timing, send it from a scenario instead: `{ "type": "send", "atMs": 25000, "photos": ["/abs/a.png", "/abs/b.png"] }` (2–10 paths, one `sendMessageAlbum` call; `text` is the optional first caption). The action row carries every member in `messageIds`. Use distinct, small (tens of KB) photo files per album: reused files let TDLib resend cached uploads, and multi-MB photos uploaded too slowly to the Test DC for the 30 s send confirmation. Judge with `getUpdates` `updates` counts in `scenario.telegramApiRequestLog`, spool-to-spool gaps from the Gateway's `isolated polling update spooled` diagnostics, and one agent turn whose newest user message holds every image.
- Forwarded bursts: use scenario action `{ "type": "forwardBurst", "text": "...", "photo": "/abs/path.png" }` with `--dm` (required). The SUT bot posts both into the DM via the direct Test Bot API, then the QA user forwards them back in one `forwardMessages` call so each carries `forward_origin` (the QA user's own Saved Messages posts lose it, verified live). Source messages appear as SUT rows before the action row; exclude them when judging replies. The summary/recording action row carries `messageIds` (forwarded) and `sourceMessageIds`. Count only `/v1/responses` requests whose latest user content contains the burst text and an image; recaps/embeddings do not count. Inspect `getUpdates` `updates` counts plus `getFile`/`file` latency (`doneAt - at`) in `scenario.telegramApiRequestLog`.

## Other branches

- [Runtime reference](./runtime-reference.md): backends, manual tools, event fields, and failure triage.

## Reaching non-default config

The audit lane exercises config the default path never uses:

| Knob                        | Reaches                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_TELEGRAM_CONFIG_PATCH` | anything under `channels.telegram` (streaming, replyToMode, richMessages)                                                       |
| `E2E_ROOT_CONFIG_PATCH`     | the config root — `messages.*` for ack/status reactions and reply visibility; `null` removes a seeded key                       |
| `E2E_REQUIRE_MENTION=true`  | makes the test group mention-required; ack scope treats `group-mentions` as mention-_required_ groups, so reaction rows need it |
| `E2E_TELEGRAM_PROVIDER_API` | `openai-completions` for commentary and preamble scenarios                                                                      |
| `E2E_MOCK_SERVER_PATH`      | an alternate mock server for provider-shape controls                                                                            |
| `--source-gateway`          | the exact TypeScript checkout without a build step                                                                              |
| `--pre-send '<text>'`       | posts as the QA user before the driven turn, for history-scoped rows                                                            |

Scenario action `command` runs argv without an implicit shell in the leased
test environment. It receives the leased TDLib state, private credential file location,
`TELEGRAM_E2E_TEST_API_ROOT`, Gateway config, and Gateway state. Set `cwd` to
`repo`, `workspace`, `state`, or `root`. The summary keeps only status, timing,
exit code, and timeout. The command writes any deliberately sanitized artifact
it needs. Invoke a shell explicitly when the test needs shell syntax.

Read `sutBotToken` from
`$TELEGRAM_E2E_STATE_DIR/credentials.local.json` inside the command process.
Use it with `TELEGRAM_E2E_TEST_API_ROOT` to call any Test Bot API method.
Gateway reads a private run-owned `tokenFile`; the runner passes file locations
to children and keeps leased tokens out of their environments. The local proxy
forwards requests to Telegram's Test Server.

Command actions stay in the runner-owned process group by default. A command
that deliberately creates a new process session owns that session and stops it
before the scenario finishes.

```json
{
  "actions": [
    { "type": "command", "argv": ["pnpm", "openclaw", "status", "--json"], "cwd": "repo" }
  ]
}
```

Bot API response controls reproduce a send that Telegram accepted while the
fresh test Gateway callback stays unresolved. Arm one method, wait until it is
held, then release it after the behavior checkpoint:

```json
{
  "actions": [
    { "type": "telegramApiHold", "method": "sendMessage", "skip": 1 },
    { "type": "telegramApiWaitHeld", "atMs": 1000, "method": "sendMessage" },
    { "type": "telegramApiRelease", "atMs": 5000 }
  ]
}
```

For a definite transport rejection, use `telegramApiReject`. It rejects one
matching request before forwarding it to Telegram, with a non-retriable synthetic
Bot API 400. `skip` counts matching requests; optional `bodyIncludes` matches the
raw request body, so an ASCII final marker can select the final send rather than
the progress message. The summary records method, occurrence, and
`upstreamForwarded: false` in `scenario.telegramApiRequestRejections`; an empty
list means the fault did not fire and cannot support a failure claim.

```json
{
  "actions": [
    { "type": "telegramApiReject", "method": "sendMessage", "bodyIncludes": "FINAL_MARKER" },
    { "type": "send", "atMs": 1000, "text": "Reply exactly FINAL_MARKER" }
  ]
}
```

For flood control, add `retryAfter` (seconds): the proxy answers with Bot API
429 `Too Many Requests` and `parameters.retry_after`. `times` (default 1)
rejects that many consecutive matching requests before the control disarms.
`retryAfter: 0` returns a bare 429 without `parameters.retry_after`. The summary's
`scenario.telegramApiRequestLog` lists proxied Bot API calls as
`{ method, at, doneAt, status, chat }`, where `doneAt` marks response completion
and `chat` is only `private` or `group` (never an id). Nonempty `getUpdates`
responses use `{ method, at, doneAt, status, updates }` with only the update count;
empty long-poll responses stay unlogged. File downloads appear as log-only
`file` rows without paths; hold/reject controls do not match them. The log can
show that no call reached Telegram inside a flood window.

```json
{
  "type": "telegramApiReject",
  "method": "sendMessage",
  "bodyIncludes": "FINAL_MARKER",
  "times": 3,
  "retryAfter": 5
}
```

Select `deleteMessage` without a body filter to reject the next cleanup deletion.
Use the existing hold/release controls for accepted-but-unacknowledged delivery;
a pre-upstream rejection does not model uncertainty.

Follow-up drain controls hold one session callback at a known point, then
release it after the behavior checkpoint:

```json
{
  "actions": [
    { "type": "followupDrainHold", "sessionKey": "agent:main:main" },
    { "type": "followupDrainWaitHeld", "atMs": 1000 },
    { "type": "followupDrainRelease", "atMs": 5000 }
  ]
}
```

Scenario action `cron` runs one isolated, announced agent job while the recorder is active. The runner waits for TDLib readiness before starting action offsets, sends DM delivery to the selected tester, sends group delivery to the recorder-resolved chat id, and removes the job after the run. Require the summary action row to contain `jobId`, `runId`, `runStatus`, `cronDeliveryTarget`, and `cleanup`.

```json
{
  "actions": [
    {
      "type": "cron",
      "message": "Write the exact recipient-facing schedule confirmation."
    }
  ]
}
```
