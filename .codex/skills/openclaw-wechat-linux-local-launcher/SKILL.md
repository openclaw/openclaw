---
name: openclaw-wechat-linux-local-launcher
description: Configure `openclaw.json` and `.env` for the local `wechat-linux` channel, then start, tail, inspect, and stop the gateway with the helper scripts in the OpenClaw repo. Use when the user wants a repeatable bring-up flow for local WeChat Linux testing on one machine.
---

# OpenClaw WeChat Linux Local Launcher

## Overview

Use this skill when the OpenClaw checkout already contains these helper scripts:

- `scripts/run-wechat-linux-local.sh`
- `scripts/start-tail-wechat-linux-local.sh`
- `scripts/status-wechat-linux-local.sh`
- `scripts/stop-wechat-linux-local.sh`

This skill covers two things:

1. Prepare the config files before startup.
2. Start, tail, inspect, and stop the local `wechat-linux` gateway safely.

## Before you start

Confirm these prerequisites first:

- The host already has Node.js 22+ and `corepack` enabled.
- The OpenClaw repo dependencies are installed.
- The Linux desktop WeChat client is installed and already signed in.
- PyWxDump is checked out on the same machine.
- The WeChat key file and `dbDir` are already prepared and verified.

If those prerequisites are still missing, stop and set them up before using the launcher scripts.

## Config files to prepare

The launcher scripts read these paths by default:

- Config JSON: `~/.openclaw/openclaw.json`
- Env file: `~/.openclaw/.env`

Bundled templates:

- `assets/templates/openclaw.json`
- `assets/templates/wechat-linux.env.example`

Copy them into the state directory first:

```bash
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
mkdir -p "$STATE_DIR"
cp "skills/openclaw-wechat-linux-local-launcher/assets/templates/openclaw.json" \
  "$STATE_DIR/openclaw.json"
cp "skills/openclaw-wechat-linux-local-launcher/assets/templates/wechat-linux.env.example" \
  "$STATE_DIR/.env"
```

If the skill lives outside `skills/`, resolve the same two files relative to the skill folder instead of hardcoding this example path.

## Required edits before startup

Edit `openclaw.json` and replace these placeholders:

- `__PYWXDUMP_ROOT__`
- `__PYTHON_PATH__`
- `__WX_KEY_FILE__`
- `__WX_DB_DIR__`
- `__WX_OUTPUT_DIR__`
- `__GATEWAY_AUTH_TOKEN__`

Edit `.env` and replace these placeholders:

- `__OPENAI_API_KEY__`
- optional `OPENAI_BASE_URL`
- optional `OPENAI_MODEL`
- optional vision model settings
- `DISPLAY`
- optional `XAUTHORITY`

Do not keep placeholder values in the real files. If any required placeholder is still present, startup should be treated as incomplete.

## Recommended bring-up order

1. Edit `~/.openclaw/.env`.
2. Edit `~/.openclaw/openclaw.json`.
3. Verify that the PyWxDump paths, key file, and `dbDir` point to the active WeChat account.
4. Start the gateway in background and tail logs.
5. Check listening state and recent log lines.
6. Run a direct-message round trip.
7. Stop the gateway cleanly when finished.

## Script usage

### Start in background and tail logs

```bash
scripts/start-tail-wechat-linux-local.sh
```

Useful overrides:

```bash
scripts/start-tail-wechat-linux-local.sh --port 18789 --bind loopback
```

### Start in foreground

```bash
scripts/run-wechat-linux-local.sh --foreground
```

Use foreground mode when the user wants to watch startup errors directly instead of tailing a log file.

### Check status

```bash
scripts/status-wechat-linux-local.sh
```

This should confirm:

- whether the gateway is listening on the expected port
- whether the pid file points to a live process
- where the latest log file lives

### Stop the gateway

```bash
scripts/stop-wechat-linux-local.sh
```

This stops the pid from the pid file first, then falls back to listener detection on the configured port.

## Common overrides

The scripts support these environment overrides:

- `OPENCLAW_STATE_DIR`
- `OPENCLAW_CONFIG_PATH`
- `OPENCLAW_ENV_FILE`
- `OPENCLAW_GATEWAY_PID_FILE`
- `OPENCLAW_LOG_DIR`
- `OPENCLAW_GATEWAY_PORT`
- `OPENCLAW_GATEWAY_BIND`
- `TAIL_LINES`

Use them when the user does not want to reuse `~/.openclaw`.

## What to verify in logs

After startup, check for these signals:

- the gateway bound to the expected local port
- the `wechat-linux` plugin is enabled
- the Python bridge starts successfully
- the bridge reaches a ready state instead of failing on `contact.db`

If startup fails, check in this order:

1. missing `pnpm` or `corepack`
2. missing API key or provider config
3. wrong PyWxDump path or Python path
4. wrong WeChat key file or `dbDir`
5. display or X11 environment issues

## Safety rules

- Never publish a real `.env`, token, API key, or personal WeChat path.
- Keep public templates sanitized with placeholders only.
- Treat `.tmp-send/`, copied configs, decrypted databases, and other local runtime artifacts as private local state, not publishable assets.

## Resources

- `assets/templates/openclaw.json`: sanitized config template for local `wechat-linux` gateway bring-up
- `assets/templates/wechat-linux.env.example`: sanitized env template for model provider and display settings
