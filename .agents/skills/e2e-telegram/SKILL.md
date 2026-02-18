---
name: e2e-telegram
description: Run the full Telegram end-to-end test against the local mux-server + OpenClaw docker-compose stack. Use when asked to run e2e tests, integration tests, or verify Telegram pipeline.
---

# Telegram E2E Test

Exercises the full pipeline: tgcli (real MTProto sender) → Telegram API → mux-server (Bot API poll) → OpenClaw (HTTP inbound) → OpenClaw reply → mux-server (outbound send) → Telegram API.

## Environment setup

Before the first run, set up the tools, credentials, and secrets. Each step only needs to be done once per machine.

### 1. Install system dependencies

```bash
# Rust toolchain (needed for tgcli)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# tgcli — pure Rust Telegram MTProto CLI (no TDLib)
cargo install tgcli

# Other required tools (usually already present)
# jq, curl, docker, uuidgen
```

### 2. Authenticate tgcli

tgcli needs a dedicated Telegram **user** account (not a bot) to act as the sender. This is interactive — it prompts for phone number, verification code, and optional 2FA password.

```bash
tgcli auth
```

Session is stored in `~/.tgcli/` and persists across runs. Re-authenticate only if the session expires or the store is wiped.

### 3. Establish bot access hash

Telegram requires an access hash before a user can message a bot. Send any message to the bot once, then sync metadata:

```bash
# Get the bot's user ID
rv-exec TELEGRAM_BOT_TOKEN -- bash -c \
  'curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | jq .result.id'

# Send a throwaway message (replace <BOT_USER_ID> with the ID above)
tgcli send --to <BOT_USER_ID> --message "hi"

# Cache chat metadata locally
tgcli sync
```

### 4. Store secrets in rv vault

The e2e script reads secrets via `rv-exec`. These should already exist from other workflows, except for the bot chat ID:

```bash
# Approve the project for rv (once per checkout)
rv approve

# Store the bot's user ID (from step 3)
echo <BOT_USER_ID> | rv set TELEGRAM_E2E_BOT_CHAT_ID

# Verify all required secrets are present
rv list | grep -E 'TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|TELEGRAM_E2E_BOT_CHAT_ID'
```

Required secrets: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `TELEGRAM_E2E_BOT_CHAT_ID`.

### 5. Build the openclaw tarball

The Docker image needs `phala-deploy/openclaw.tgz`. Rebuild whenever source changes:

```bash
pnpm build
npm pack --pack-destination phala-deploy
mv phala-deploy/openclaw-*.tgz phala-deploy/openclaw.tgz
```

This step is only needed if the containers haven't been built yet or if you changed OpenClaw source code.

## Running the test

```bash
rv-exec TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN TELEGRAM_E2E_BOT_CHAT_ID \
  -- bash phala-deploy/local-mux-e2e/scripts/e2e-telegram.sh
```

The script:

1. Checks prerequisites (tgcli, jq, curl, docker, env vars)
2. Ensures the docker-compose stack is running (calls `up.sh` if not)
3. Issues a pairing token and sends `/start <token>` to the bot
4. Runs 4 tests: text message, photo with caption, document with caption, file proxy fetch
5. Prints pass/fail summary; exits non-zero on any failure

## Key details

- **tgcli flags**: `--message` for text-only, `--caption` for media. `--photo` for images, `--file` for documents.
- **Detection**: polls mux-server structured log (`/data/mux-server.log`) for `telegram_inbound_forwarded` entries.
- **File proxy test**: sends a photo via Bot API, extracts `file_id`, fetches through proxy with runtime JWT auth.
- **Stack management**: `up.sh` to start, `down.sh` to stop, `down.sh --wipe` to reset volumes.

## Stack management scripts

All in `phala-deploy/local-mux-e2e/scripts/`:

| Script                    | Purpose                                      |
| ------------------------- | -------------------------------------------- |
| `up.sh`                   | Build + start containers, wait for health    |
| `down.sh`                 | Stop containers (`--wipe` to remove volumes) |
| `pair-token.sh <channel>` | Issue a pairing token                        |
| `logs.sh [service]`       | Tail container logs                          |
| `e2e-telegram.sh`         | Run the full e2e test suite                  |

## Troubleshooting

- **"openclaw.tgz not found"**: Run the build step above.
- **"rv-exec: project not approved"**: Run `rv approve` in the project root.
- **"tgcli is required"**: `cargo install tgcli` then `tgcli auth`.
- **OpenClaw replies with "No API key"**: The e2e test only checks inbound forwarding, not LLM replies. This error is expected if no API key is configured in the container.
- **Containers won't start**: Check `docker compose -f phala-deploy/local-mux-e2e/docker-compose.yml logs`.
