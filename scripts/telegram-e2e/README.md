# Telegram Thread Model Inheritance E2E

This folder gives you a fast bot+user end-to-end loop:

- `tg` (Bot API) for observing bot updates and thread metadata.
- Telethon (MTProto user session) for sending messages as your user account.

## 0) Fork + build `tg`

Fork already created for this workflow:

- <https://github.com/artemgetmann/tg>

Build it locally:

```bash
git clone https://github.com/artemgetmann/tg.git
cd tg
go build -o tg .
```

## 1) Prepare Telethon user session

```bash
cd scripts/telegram-e2e
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

First run will ask for Telegram login code:

```bash
python3 userbot_send.py \
  --api-id "$TELEGRAM_API_ID" \
  --api-hash "$TELEGRAM_API_HASH" \
  --chat "<chat-id-or-username>" \
  --reply-to <message-id-in-target-thread> \
  --text "hello from userbot"
```

## 2) Apply lean model allowlist

Apply the preset directly to your active OpenClaw config:

```bash
./apply-lean-model-allowlist.sh
```

Reference payload:

- `lean-model-allowlist.jsonc`

This keeps default model at `openai-codex/gpt-5.3-codex` and trims `/models` to the agreed Lean+Gemini set.

## 3) Run inheritance smoke

```bash
export TELEGRAM_API_ID=...
export TELEGRAM_API_HASH=...
export TG_BIN=/absolute/path/to/tg
# optional if needed:
# export TG_BOT=Jarvis

./run-model-inheritance-e2e.sh \
  --chat "<chat-id-or-username>" \
  --set-model "openai-codex/gpt-5.3-codex" \
  --thread-a-reply-to <thread-a-anchor-message-id> \
  --thread-b-reply-to <thread-b-anchor-message-id> \
  --thread-b-id <thread-b-topic-or-thread-id>
```

Pass criteria:

- Step A sets model in thread A.
- Step B queries model in thread B.
- Runner sees bot response in thread B containing `Current: <expected-model>`.

## Notes

- Thread targeting in userbot send uses `reply_to` anchoring.
- For private chat topics, `tg` output may expose either `message_thread_id` or `direct_messages_topic.topic_id`; the runner checks both.
