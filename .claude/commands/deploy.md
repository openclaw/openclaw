Deploy the OpenClaw gateway with Telegram bot.

Usage: `/deploy <mode>` where mode is `prod` (default) or `dev`.
Argument: $ARGUMENTS (default: "prod")

---

## Prod mode (`prod` or empty)

1. **Check config exists**: verify `~/.openclaw/openclaw.json` exists.
   - If missing, run `pnpm openclaw onboard` and wait for interactive wizard to complete.

2. **Check Telegram configured**: read the config and verify `channels.telegram.enabled` is `true`.
   - If not configured, run `pnpm openclaw channels add --channel telegram` interactively.

3. **Check auth token**: verify `gateway.auth.token` is set in the config.
   - If missing, warn the user and ask whether to proceed without auth.

4. **Build**: run `pnpm build` and verify it succeeds.

5. **Start gateway**: run `env -u CLAUDECODE pnpm openclaw gateway --force` in the background.
   - IMPORTANT: Must unset `CLAUDECODE` env var to avoid "nested session" error when running inside Claude Code.

6. **Verify health** (wait ~8 seconds first): run `pnpm openclaw health`.
   - If health check fails, read the gateway log at `/tmp/openclaw/openclaw-*.log` (most recent) and report the error.

7. **Check channels**: run `pnpm openclaw channels status --probe` and report status.

8. **Report**: summarize what's running (port, bot username, health status).

## Dev mode (`dev`)

1. **Check dev config**: if `~/.openclaw-dev/openclaw.json` doesn't exist, it will be auto-created by the `--dev` flag.

2. **Check Telegram token**: if `TELEGRAM_BOT_TOKEN` env var is not set AND the dev config doesn't have `channels.telegram.botToken`, warn the user that Telegram won't be available in dev mode unless configured.

3. **Build**: run `pnpm build` and verify it succeeds.

4. **Start gateway**: run `env -u CLAUDECODE pnpm openclaw gateway --dev --force` in the background.
   - The `--dev` flag auto-creates config and uses port 19001 by default.

5. **Verify health**: wait ~8 seconds, then run `pnpm openclaw --dev health`.

6. **Report**: summarize what's running.

## Key differences

| Aspect      | Dev                    | Prod                |
| ----------- | ---------------------- | ------------------- |
| Config      | Auto-created (`--dev`) | Requires `onboard`  |
| Auth        | Not needed (loopback)  | Token required      |
| Channels    | Off by default         | Enabled from config |
| Port        | 19001                  | 18789               |
| Config path | `~/.openclaw-dev/`     | `~/.openclaw/`      |

## Critical notes

- Always use `env -u CLAUDECODE` when starting the gateway from within Claude Code to avoid nested session errors.
- Always use `--force` to kill any existing gateway process on the port.
- Run the gateway command in the background so it doesn't block the conversation.
- After starting, always verify with health check before reporting success.
