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

Manual setup is optional now. `userbot-send-live.sh` auto-bootstraps `.venv` only when missing/broken and stays quiet when healthy.

First login will ask for Telegram code in your app:

```bash
python3 userbot_send.py \
  --api-id "$TELEGRAM_API_ID" \
  --api-hash "$TELEGRAM_API_HASH" \
  --chat "<chat-id-or-username>" \
  --reply-to <thread-anchor-message-id> \
  --text "hello from userbot"
```

Canonical userbot path for reliability checks:

```bash
scripts/telegram-e2e/userbot-send-live.sh \
  --chat "<chat-id-or-username>" \
  --reply-to <thread-anchor-message-id> \
  --text "hello from userbot"
```

What it does:

1. Loads `scripts/telegram-e2e/.env.local` when present.
2. Resolves/bootstraps Python deps only if needed.
3. Runs `userbot_precheck.py` (creds/session/chat checks).
4. Sends message with `userbot_send.py` only if precheck passes.

### 3) Create local env file

```bash
cp scripts/telegram-e2e/.env.example scripts/telegram-e2e/.env.local
```

Fill `scripts/telegram-e2e/.env.local` with your real values.

## AI/operator handoff (credentials continuity)

Use one source of truth in your main checkout, then copy into each worktree.

1. Keep local-only credentials in main checkout:
   - `scripts/telegram-e2e/.env.local`
   - `scripts/telegram-e2e/tmp/userbot.session`
2. Never commit or print raw secrets (`TELEGRAM_API_HASH`, `TG_BOT_TOKEN`, session contents).
3. For every new worktree, run:
   - `bash scripts/bootstrap-worktree-telegram.sh`
4. Smoke check from that worktree:
   - `scripts/telegram-e2e/userbot-send-live.sh --chat "<chat-id-or-username>" --text "handoff smoke"`
5. First runtime claim happens on first canonical ensure run:
   - `scripts/telegram-live-runtime.sh ensure`
   - This auto-claims a tester bot token for the worktree (or hard-fails if none are available).
   - Pool tokens that are already present in the stable/main Telegram config are treated as reserved and are never claimed by worktree live tests.

## Scaling the tester bot pool

If you want multiple Codex worktrees or agents to run Telegram live validation in parallel, grow the tester bot pool first.

Rule of thumb:

- one concurrently live-tested worktree needs one tester bot token
- if you expect `5` parallel Telegram live lanes, provision at least `5` tester bots
- keep stable/default, personal, and research bots out of the tester pool

Create additional tester bots with BotFather:

1. In Telegram, open `@BotFather`.
2. Run `/newbot`.
3. Give it a clear tester name (for example `Jarvis Email 2`).
4. Save the bot token somewhere local-only.
5. Add the bot to your dedicated Telegram E2E chats/topics.
6. Grant whatever Telegram permissions your live checks require.

Register new tester bots locally by appending them to `.env.bots`:

```bash
# email-2
BOT_TOKEN=<botId>:<token>
```

Then rerun:

```bash
scripts/telegram-live-runtime.sh ensure
```

New worktrees auto-claim on first `ensure` run. They do not need a token claim at worktree creation time.

## Token claim lifecycle

Tester bot claims are worktree-scoped, not PR-scoped.

This is intentional:

- one worktree may produce multiple PRs over time
- the same worktree should keep the same tester bot across reruns
- PR merge/close/archive does not necessarily mean the worktree is done

Current behavior:

- first `ensure` auto-claims a tester bot for the current worktree
- later `ensure` runs retain the same token when it is still valid for that worktree
- `release` explicitly frees the current worktree claim and stops its isolated runtime
- if no unclaimed tester bot exists, `ensure` hard-fails with `pool_exhausted`
- merged or archived PRs do not automatically free tester tokens today

Supported release flow for an inactive worktree:

```bash
scripts/telegram-live-runtime.sh release
```

After release, rerun `scripts/telegram-live-runtime.sh ensure` in the worktree that should claim next.

Recommended follow-up after this PR:

- add a stale-claim garbage collector that only releases claims for missing/inactive worktrees
- keep release logic tied to worktree lifecycle, not PR lifecycle
- optionally add a lease/queue mechanism if you want worktrees to wait for a free tester bot instead of hard-failing immediately

## Required values and anchors

`scripts/telegram-e2e/.env.local` keys:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `USERBOT_SESSION` (optional override; default is `scripts/telegram-e2e/tmp/userbot.session`)
- `TG_BOT_TOKEN` (optional; worktree live runner prefers the claimed `TELEGRAM_BOT_TOKEN` from repo-root `.env.local`)
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

Use the canonical runtime entrypoint before live assertions:

```bash
scripts/telegram-live-runtime.sh ensure
```

This enforces:

1. named branch (not detached `HEAD`)
2. tester token claim/pool guard
3. deterministic isolated runtime (`runtime_port`, `runtime_state_dir`)
4. ownership and health proof lines
5. plugin isolation for live runtime (`plugins.allow=["telegram"]`, `plugins.slots.memory=none`)

Do not manually start `gateway run` for Telegram live tests.

When a worktree is done with Telegram live testing, free its claim explicitly:

```bash
scripts/telegram-live-runtime.sh release
```

### Plugin isolation note (important)

The canonical worktree live runtime intentionally allows only the bundled Telegram plugin to keep startup deterministic and prevent cross-worktree plugin side effects.

If your test case depends on plugin behavior, do not use the isolated Telegram live runtime path for that assertion. Run that plugin-specific validation in the appropriate plugin-focused test lane instead.

## Deterministic gateway recovery (main runtime)

When gateway health is flaky during live E2E, use the deterministic recovery helper.

```bash
scripts/gateway-recover-main.sh
```

What it does:

1. Captures baseline evidence (`status --require-rpc`, listener, launchctl state).
2. Performs aggressive clean stop (`bootout`, `pkill`).
3. Rebuilds/reinstalls from `/Users/user/Programming_Projects/openclaw`.
4. Bootstraps gateway + watchdog launch agents.
5. Waits with readiness gates:
   - listener gate on `18789` (poll every 2s, timeout 300s),
   - RPC gate (`openclaw gateway status --deep --require-rpc`) after listener.
6. Runs one controlled kickstart retry if listener is still down after 30s.
7. On timeout/failure, prints exact failing command output plus:
   - last 120 lines of `~/.openclaw/logs/gateway.err.log`
   - last 120 lines of `/tmp/openclaw/gateway-watchdog.err.log`

Optional env overrides:

- `OPENCLAW_MAIN_REPO` (default: `/Users/user/Programming_Projects/openclaw`)
- `OPENCLAW_GATEWAY_PORT` (default: `18789`)
- `OPENCLAW_GATEWAY_LISTENER_TIMEOUT_SECONDS` (default: `300`)
- `OPENCLAW_GATEWAY_RPC_TIMEOUT_SECONDS` (default: `120`)
- `OPENCLAW_GATEWAY_RETRY_KICKSTART_AFTER_SECONDS` (default: `30`)
- `OPENCLAW_GATEWAY_POLL_INTERVAL_SECONDS` (default: `2`)

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
The runner auto-calls `scripts/telegram-live-runtime.sh handoff-main` on exit.
The runner also clears the isolated runtime's saved session for thread B before
querying it, so a reused anchor topic behaves like a new thread for deterministic
inheritance checks.

## Known behavior and failure recovery

- `409 Conflict` from `tg poll` is expected when gateway owns `getUpdates`.
  - Runner auto-falls back to MTProto assertion (`userbot_wait.py`), no action needed.
- `tg poll returned non-JSON output` means `tg` is not configured for polling in that shell.
  - Set `TG_BOT_TOKEN` in `.env.local` (recommended) or configure `tg bot add`.
- `userbot_send failed: EOF when reading a line` means Telethon session is not authenticated.
  - Re-run `userbot_send.py` once interactively to refresh login.
- `E_MISSING_SESSION`: no session file at canonical path.
  - Sync `scripts/telegram-e2e/tmp/userbot.session` or set `USERBOT_SESSION`.
- `E_UNAUTHORIZED_SESSION`: session exists but is not logged in.
  - Re-auth once with interactive `userbot_send.py`.
- `E_CHAT_NOT_RESOLVABLE`: precheck cannot resolve `--chat`.
  - Verify chat id/username and account access.
- `E_AMBIGUOUS_SESSION`: both legacy and canonical session files exist.
  - Set `USERBOT_SESSION` explicitly or remove one file.
- HTTP `503` or no bot replies usually means gateway is not fully started yet.
  - Wait for provider-start logs and retry.
- If inherited model fails while unchanged-existing-thread passes, verify gateway runtime path and branch first.

## Notes

- Thread targeting uses `reply_to` anchoring.
- For private topics, thread id can appear as `message_thread_id` or `direct_messages_topic.topic_id`.
- Runner session selection order:
  - `USERBOT_SESSION` env var
  - `scripts/telegram-e2e/tmp/userbot.session`
  - `scripts/telegram-e2e/userbot.session` (legacy fallback if canonical missing)
