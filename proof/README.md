# Telegram edit-vs-send live proof harness

Opt-in, manual reproduction harness for the Telegram in-flight-preamble
edit-vs-send bug. It drives the **real** `dispatchTelegramMessage` +
`createTelegramDraftStream` against the **live** Telegram Bot API and logs every
outbound call (`sendMessage` / `editMessageText` with `message_id` + text).

It exists because a unit test cannot catch the bug: the failure is an async race
that only appears under real Bot API send latency. Mocked sends resolve
synchronously, so vitest/offline runs are a false green.

## Not part of the test suite

This is a standalone script (`*.ts`, not `*.test.ts`) under `proof/`, which is
outside every vitest include root (`src/**`, `test/**`, `packages/**`, extension
roots). It is **never collected** by the default test run and adds **zero** test
time. It also **no-ops** unless `TG_BOT_TOKEN` is set, so it can never run
unintentionally.

## Usage

```bash
# A test bot token + a chat the bot can post to are required.
TG_BOT_TOKEN=<token> TG_CHAT_ID=<chat_id> \
  node --import tsx proof/telegram-edit-vs-send-proof.ts <label>

# Timing is controlled by TOOL_DELAY_MS (ms between preamble and tool boundary):
#   0    = fast   (tool fires while the preamble send is still in flight) — the failing case
#   2500 = delayed (preamble send acks first)
TOOL_DELAY_MS=0    ... node --import tsx proof/telegram-edit-vs-send-proof.ts postfix-fast
TOOL_DELAY_MS=2500 ... node --import tsx proof/telegram-edit-vs-send-proof.ts postfix-delayed
```

Logs are written to `proof/out/<label>.log` (git-ignored). The token is never
printed (errors are scrubbed).

## Expected outcome

- **Fixed:** `sends=2 edits=0 preamblePreserved=true` at BOTH timings — the
  preamble is its own message and the post-tool text is a second message.
- **Buggy:** `sends=1 edits=1 preamblePreserved=false` — the preamble bubble is
  overwritten by an `editMessageText` carrying the post-tool text.
