# Telegram Thread Model Inheritance E2E

Goal: run live Telegram end-to-end checks for thread model inheritance without re-discovering setup every time.

Manual Telegram verification is the release gate. The probe/runner is support
tooling and should not block closure if Telegram behavior is correct but the
probe is flaky.

Before you trust any live result, prove the lane is clean:

1. Run `scripts/telegram-live-runtime.sh ensure`.
2. Confirm the printed `runtime_worktree` matches the current worktree.
3. Confirm there is only one active long-poller for the claimed tester bot.
4. Only then trust `/model`, `/think`, or `/status` replies as evidence.

If you skip this, Telegram `getUpdates` conflicts can make another checkout
answer your messages and waste an hour on fake regressions.
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
6. For forum-topic probes, prefer the lane-injected `TELEGRAM_BOT_TOKEN` over any stale `TG_BOT_TOKEN` left in `scripts/telegram-e2e/.env.local`.
   - Reason: `scripts/telegram-e2e/.env.local` can lag behind the currently claimed tester bot.
   - The forum probe now prefers `TELEGRAM_BOT_TOKEN` first.

## Worktree automation workflow

Use these helpers instead of ad-hoc `git worktree add`, manual `.env` copying,
or hand-written `open -n` commands.

### Create a new worktree the repo-native way

```bash
bash scripts/new-worktree.sh my-feature
```

What it does:

1. Fetches `origin`.
2. Chooses the base branch contextually:
   - `origin/codex/consumer-openclaw-project` when the current branch or upstream is the consumer branch
   - otherwise `origin/main`
   - `--base <branch>` still overrides the default explicitly
3. Creates `.codex/worktrees/my-feature` on `codex/my-feature` from that base.
4. Runs `bash scripts/bootstrap-worktree-telegram.sh`.
5. Attempts a bounded `scripts/telegram-live-runtime.sh ensure` so worktree creation does not hang for minutes waiting on runtime health.
6. Writes `.dev-launch.env` with a deterministic `OPENCLAW_STATE_DIR` and `OPENCLAW_GATEWAY_PORT`.

The script prints proof lines including:

- `base_branch=<...>`
- `base_source=auto|flag`

If live Telegram runtime health still matters after creation, rerun:

```bash
scripts/telegram-live-runtime.sh ensure
```

from inside that new worktree.

### Launch an isolated macOS app instance for that worktree

```bash
bash scripts/dev-launch-mac.sh
```

This reads `.dev-launch.env` from the current worktree root and launches
`dist/OpenClaw.app` with a clean `env -i` environment so the app state and
gateway port stay isolated from other worktrees.

Fast failure-mode check:

```bash
bash scripts/dev-launch-mac.sh --no-build
```

### Inspect or clean stale worktrees

Dry-run first:

```bash
bash scripts/gc-worktrees.sh
```

Apply cleanup only after reviewing the table:

```bash
bash scripts/gc-worktrees.sh --auto
```

What `--auto` removes by default:

- prunable worktrees
- merged worktrees

What it does **not** remove by default:

- detached worktrees (`--include-detached` is explicit)
- the current checkout

When a removable worktree still exists on disk and has a claimed tester token,
the GC helper first runs:

```bash
bash scripts/telegram-live-runtime.sh release
```

inside that worktree before removing it.

### Make GC automatic

Install the scheduler once:

```bash
bash scripts/install-worktree-gc.sh install
```

Platform behavior:

- macOS: installs a LaunchAgent that runs `scripts/gc-worktrees.sh --auto` hourly
- Linux: installs a crontab entry that runs the same command hourly

By default the scheduler anchors to the main checkout at
`/Users/user/Programming_Projects/openclaw` so it survives feature-worktree
deletion. Override with `OPENCLAW_WORKTREE_GC_REPO_ROOT` only if you
intentionally want another root.

Useful commands:

```bash
bash scripts/install-worktree-gc.sh status
bash scripts/install-worktree-gc.sh install --dry-run
bash scripts/install-worktree-gc.sh run-now
bash scripts/install-worktree-gc.sh uninstall
```

For safety, the automatic path still uses the same default GC policy:

- dry review is still available via `bash scripts/gc-worktrees.sh`
- detached cleanup is still opt-in
- current checkout is still skipped

## Required values and anchors

`scripts/telegram-e2e/.env.local` keys:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `USERBOT_SESSION` (optional override; default is `scripts/telegram-e2e/tmp/userbot.session`)
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

### Single-poller rule

Telegram Bot API long-polling is single-owner. If two runtimes share one bot
token, one of them will win and the other will log `409 Conflict: terminated by
other getUpdates request`.

Symptoms:

- `/model` or `/think` replies look real but come from the wrong checkout
- `/status` appears inconsistent with local code/tests
- the tester bot sometimes replies and sometimes goes silent

If that happens:

```bash
scripts/telegram-live-runtime.sh release
scripts/telegram-live-runtime.sh ensure
```

Then re-check the proof lines before sending more Telegram traffic.

When a worktree is done with Telegram live testing, free its claim explicitly:

```bash
scripts/telegram-live-runtime.sh release
```

### Plugin isolation note (important)

The canonical worktree live runtime intentionally allows only the bundled Telegram plugin to keep startup deterministic and prevent cross-worktree plugin side effects.

If your test case depends on plugin behavior, do not use the isolated Telegram live runtime path for that assertion. Run that plugin-specific validation in the appropriate plugin-focused test lane instead.

`scripts/telegram-live-preflight.sh` now also prints:

- current branch
- current worktree path
- assigned bot username/id
- token claim count across git worktrees

It fails fast if the same Telegram bot token is claimed by more than one
worktree.

## DM probe helper

Use the MTProto probe for debugging, not as the final ship gate:

```bash
scripts/telegram-e2e/.venv/bin/python scripts/telegram-e2e/probe_dm_thread_inheritance.py \
  --chat "${TG_DM_CHAT_ID:-@Artem_jarvis_exec_bot}" \
  --target-model "anthropic/claude-sonnet-4-6"
```

Despite the name, this probe is also used for Telegram forum-topic inheritance
checks. The filename is legacy.

The probe now:

- prefers the live lane `TELEGRAM_BOT_TOKEN` over stale local `TG_BOT_TOKEN`
- resolves the actual bot user id from the token for forum-group sender matching
- resolves bot identity dynamically from Telegram
- prints bot username/id diagnostics
- accepts multiple valid DM-thread reply shapes
- prints ignored-message diagnostics on timeout
- fails fast when another Telethon process already owns the same userbot session

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

## ACP handoff validation status

Live result (2026-03-20, tester lane `tg-finance`): `ACP one-shot = passed`.

Evidence signature:

- Telegram request: `run this in codex and reply exactly <token>`
- Bot reply contains exact `<token>`
- Gateway log contains ACP success run marker:
  - `:agent:codex:acp:...:ok`
  - `[agent:nested] ... <token>`

Scope note:

- This confirms one-shot ACP delegation from Telegram to Codex and return-to-parent reply flow.
- This does **not** by itself prove persistent thread-bound ACP session behavior across follow-up turns.

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
