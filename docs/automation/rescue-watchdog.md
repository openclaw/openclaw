---
summary: "Run an external watchdog that captures failures and optionally hands incidents to Claude Code"
read_when:
  - Setting up a last-resort recovery flow outside the gateway process
  - Routing OpenClaw runtime failures into Claude Code
title: "Rescue Watchdog"
---

# Rescue watchdog

If OpenClaw stops replying because the gateway or a channel runtime broke, the
smallest safe recovery flow is an **external watchdog**. Keep it outside the
gateway process so it still runs when OpenClaw itself is unhealthy.

This repo includes:

- `scripts/rescue-watchdog.sh` - polls `openclaw health --json`, captures an
  incident bundle, de-duplicates repeated failures, optionally notifies you, and
  optionally runs a rescue command.
- `scripts/claude-rescue-runner.sh` - sample rescue command that hands the
  incident to Claude Code in non-interactive `--print` mode.
- `scripts/systemd/openclaw-rescue-watchdog.{service,timer}` - Linux user
  service templates.

## What it detects

The watchdog triggers when either of these happens:

- `openclaw health --json` exits non-zero
- a channel health snapshot contains a non-empty `lastError`

When triggered, it writes an incident bundle under:

```bash
~/.openclaw/rescue-watchdog/incidents/<timestamp>/
```

The bundle includes:

- `summary.txt`
- `health.json` / `health.stderr`
- `status.txt`
- `gateway-status.json`
- latest gateway log tail
- git head / status / diff stat
- runner stdout / stderr when a rescue runner is configured

## Quick start

From a source checkout:

```bash
export OPENCLAW_RESCUE_RUNNER="$PWD/scripts/claude-rescue-runner.sh"
export OPENCLAW_RESCUE_NOTIFY_CHANNEL=telegram
export OPENCLAW_RESCUE_NOTIFY_TARGET=@mychat

./scripts/rescue-watchdog.sh
```

If an incident is found, the script:

1. captures the current failure
2. invokes the runner
3. sends a short notification with the incident id and runner result

## Claude runner

`scripts/claude-rescue-runner.sh` expects the local `claude` CLI on `PATH`. It:

- reads the captured incident bundle
- opens the workspace plus the incident directory
- asks Claude Code for the smallest safe fix
- captures Claude's final output to `claude-output.txt`

Useful environment variables:

- `CLAUDE_BIN` - override the Claude CLI path
- `CLAUDE_RESCUE_MODEL` - default `sonnet`
- `CLAUDE_RESCUE_PERMISSION_MODE` - default `acceptEdits`
- `CLAUDE_RESCUE_APPEND_SYSTEM_PROMPT` - optional extra guardrails

`acceptEdits` is the conservative default. If you want unattended shell command
execution too, configure Claude's permission policy explicitly for your
environment before relying on auto-fix flows.

## Watchdog environment

- `OPENCLAW_RESCUE_RUNNER` - shell command to run when an incident is detected
- `OPENCLAW_RESCUE_NOTIFY_CHANNEL` - channel for `openclaw message send`
- `OPENCLAW_RESCUE_NOTIFY_TARGET` - target for `openclaw message send`
- `OPENCLAW_RESCUE_NOTIFY_PREFIX` - notification prefix
- `OPENCLAW_RESCUE_HEALTH_TIMEOUT_MS` - health probe timeout, default `10000`
- `OPENCLAW_RESCUE_COOLDOWN_SEC` - duplicate suppression window, default `900`
- `OPENCLAW_RESCUE_TAIL_LINES` - log tail size, default `200`
- `OPENCLAW_RESCUE_STATE_DIR` - state directory, default `~/.openclaw/rescue-watchdog`
- `OPENCLAW_RESCUE_INCIDENT_ROOT` - incident output directory
- `OPENCLAW_RESCUE_LOG_DIR` - default `/tmp/openclaw`
- `OPENCLAW_RESCUE_LOG_PATTERN` - default `openclaw-*.log`

## systemd user timer

Templates are provided under `scripts/systemd/`.

```bash
mkdir -p ~/.config/systemd/user
cp scripts/systemd/openclaw-rescue-watchdog.service ~/.config/systemd/user/
cp scripts/systemd/openclaw-rescue-watchdog.timer ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now openclaw-rescue-watchdog.timer
```

Edit the copied service and set:

- `OPENCLAW_RESCUE_RUNNER`
- `OPENCLAW_RESCUE_NOTIFY_CHANNEL`
- `OPENCLAW_RESCUE_NOTIFY_TARGET`

## macOS note

No LaunchAgent file is bundled here. On macOS, run the same
`scripts/rescue-watchdog.sh` from `launchd` or cron. Keep it outside the
OpenClaw launchd job for the same reason: if the gateway dies, the rescue path
must stay alive.

## Manual verification

1. Force a synthetic incident:

```bash
OPENCLAW_BIN=false OPENCLAW_RESCUE_STATE_DIR="$PWD/.artifacts/rescue-watchdog-test" ./scripts/rescue-watchdog.sh
```

2. Confirm the incident directory contains:

- `summary.txt`
- `status.txt`
- `health.exit`

3. Then configure the Claude runner and reproduce a real health failure:

```bash
export OPENCLAW_RESCUE_RUNNER="$PWD/scripts/claude-rescue-runner.sh"
./scripts/rescue-watchdog.sh
```
