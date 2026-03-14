# Telegram Thread Model Inheritance E2E

Goal: run live Telegram end-to-end checks for thread model inheritance without re-discovering setup every time.

This validates:

1. Group forum topics: `/model` in topic A becomes default for newly created topic B in the same group.
2. DM threaded mode: `/model` in thread X becomes default for newly created thread Y in the same DM chat.
3. Existing threads stay unchanged.
4. `/models` catalog is lean allowlisted and disallowed models are rejected.

## One-time setup

### 1) Build `tg` (bot-side poll/inspect)

Fork used in this workflow:

- <https://github.com/artemgetmann/tg>

Build:

```bash
git clone https://github.com/artemgetmann/tg.git
cd tg
go build -o tg .
```

### 2) Prepare Telethon (user-side sends)

```bash
cd scripts/telegram-e2e
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

First login will ask for Telegram code in your app:

```bash
python3 userbot_send.py \
  --api-id "$TELEGRAM_API_ID" \
  --api-hash "$TELEGRAM_API_HASH" \
  --chat "<chat-id-or-username>" \
  --reply-to <thread-anchor-message-id> \
  --text "hello from userbot"
```

### 3) Create local env file

```bash
cp scripts/telegram-e2e/.env.example scripts/telegram-e2e/.env.local
```

Fill `scripts/telegram-e2e/.env.local` with your real values.

## Required values and anchors

`scripts/telegram-e2e/.env.local` keys:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TG_BOT_TOKEN` (`<botId>:<token>`)
- `TG_BIN` (absolute path to built `tg`)
- `TG_FORUM_CHAT_ID` (group chat id, usually `-100...`)
- `TG_DM_CHAT_ID` (bot DM chat id)

Anchors are the message ids used as `reply_to` targets:

- Group: `TG_TOPIC_A_ID`, `TG_TOPIC_B_ID`, `TG_TOPIC_C_ID`
- DM: `TG_DM_THREAD_X_ID`, `TG_DM_THREAD_Y_ID`, `TG_DM_THREAD_Z_ID`

Keep these as stable thread roots and reuse them between runs.

## Apply allowlist preset

```bash
cd scripts/telegram-e2e
./apply-lean-model-allowlist.sh
```

Reference payload:

- `scripts/telegram-e2e/lean-model-allowlist.jsonc`

Default remains `openai-codex/gpt-5.3-codex`.

## Critical runtime rule (prevents false negatives)

Run the gateway from the same branch/worktree you are validating:

```bash
node dist/index.js gateway run --bind loopback --port 18789 --force
```

If another checkout/global runtime is serving Telegram, your E2E result is invalid for this branch.

## Run E2E checks

### Group forum inheritance (A -> new B, C unchanged)

```bash
set -a
source scripts/telegram-e2e/.env.local
set +a

scripts/telegram-e2e/run-model-inheritance-e2e.sh \
  --chat "$TG_FORUM_CHAT_ID" \
  --set-model "anthropic/claude-sonnet-4-6" \
  --expect-model "anthropic/claude-sonnet-4-6" \
  --thread-a-reply-to "$TG_TOPIC_A_ID" \
  --thread-b-reply-to "$TG_TOPIC_B_ID" \
  --thread-b-id "$TG_TOPIC_B_ID"
```

### DM threaded inheritance (X -> new Y, Z unchanged)

```bash
set -a
source scripts/telegram-e2e/.env.local
set +a

scripts/telegram-e2e/run-model-inheritance-e2e.sh \
  --chat "$TG_DM_CHAT_ID" \
  --set-model "openai-codex/gpt-5.3-codex" \
  --expect-model "openai-codex/gpt-5.3-codex" \
  --thread-a-reply-to "$TG_DM_THREAD_X_ID" \
  --thread-b-reply-to "$TG_DM_THREAD_Y_ID" \
  --thread-b-id "$TG_DM_THREAD_Y_ID"
```

Pass signal is `PASS: thread B reports expected model (...)`.

## Known behavior and failure recovery

- `409 Conflict` from `tg poll` is expected when gateway owns `getUpdates`.
  - Runner auto-falls back to MTProto assertion (`userbot_wait.py`), no action needed.
- `tg poll returned non-JSON output` means `tg` is not configured for polling in that shell.
  - Set `TG_BOT_TOKEN` in `.env.local` (recommended) or configure `tg bot add`.
- `userbot_send failed: EOF when reading a line` means Telethon session is not authenticated.
  - Re-run `userbot_send.py` once interactively to refresh login.
- HTTP `503` or no bot replies usually means gateway is not fully started yet.
  - Wait for provider-start logs and retry.
- If inherited model fails while unchanged-existing-thread passes, verify gateway runtime path and branch first.

## Notes

- Thread targeting uses `reply_to` anchoring.
- For private topics, thread id can appear as `message_thread_id` or `direct_messages_topic.topic_id`.
- Runner session selection order:
  - `USERBOT_SESSION` env var
  - `scripts/telegram-e2e/userbot.session` (if present)
  - `scripts/telegram-e2e/tmp/userbot.session`
