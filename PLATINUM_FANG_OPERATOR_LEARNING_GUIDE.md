# Platinum Fang Operator Learning Guide

This guide explains what each command changes and why.

## Command flow you can run now

```bash
cd "/mnt/e/Sterling Storage/openclaw"
chmod +x scripts/platinumfang-mode.sh scripts/platinumfang-setup.sh scripts/platinumfang-tour.sh scripts/platinumfang-demo.sh
scripts/platinumfang-tour.sh
```

## Guided desktop demo (agent-style)

```bash
cd "/mnt/e/Sterling Storage/openclaw"
scripts/platinumfang-demo.sh
```

What this demo walks through:
1. Baseline status
2. Architecture/capability tour
3. Safe mode enforcement
4. Discord pairing checkpoint
5. Individual toggles
6. Toggle-all behavior
7. Return to safe end state

## Fast secure setup

Run this once after rotating your Discord token:

```bash
cd "/mnt/e/Sterling Storage/openclaw"
export DISCORD_BOT_TOKEN="PASTE_NEW_BOT_TOKEN_HERE"
SET_TOKEN=1 scripts/platinumfang-setup.sh
unset DISCORD_BOT_TOKEN
```

What it does:
1. Starts `openclaw-gateway` container
2. Enables Discord and enforces pairing
3. Applies your guild allowlist with your user ID
4. Applies strict tool policy
5. Forces loopback bind and local mode
6. Applies Platinum Fang safe mode
7. Runs `security audit --deep`

## Mode commands and what they change

### `scripts/platinumfang-mode.sh safe`

Changes:
- `tools.profile = messaging`
- `tools.deny` includes runtime/fs/automation + control-plane delegation
- `tools.elevated.enabled = false`
- `session.dmScope = per-channel-peer`
- `tools.fs.workspaceOnly = true`
- `tools.exec.applyPatch.workspaceOnly = true`
- guild policy set to allowlist + mention required
- model chain: local primary, cloud fallbacks

Why:
- Minimize blast radius from prompt injection
- Keep user/session isolation stronger for Discord DM workflows

### `scripts/platinumfang-mode.sh power`

Changes:
- `tools.profile = full` (broader capabilities)
- keeps key dangerous control-plane delegations denied
- guild mention requirement off
- model chain shifts cloud-first

Why:
- Higher capability for trusted, supervised work sessions

### `scripts/platinumfang-mode.sh local-only`

Changes:
- model primary set to local model
- fallbacks set to local only

Why:
- Maximum privacy, predictable cost

### `scripts/platinumfang-mode.sh cloud-only`

Changes:
- model primary set to cloud free route
- fallbacks to cloud free/premium chain

Why:
- Higher quality/availability when local model is constrained

### Toggle commands

- `scripts/platinumfang-mode.sh discord-toggle`
  - Flips `channels.discord.enabled` true/false.
- `scripts/platinumfang-mode.sh mention-toggle`
  - Flips guild `requireMention` true/false.
- `scripts/platinumfang-mode.sh model-toggle`
  - Flips model chain between local-only and cloud-only.
- `scripts/platinumfang-mode.sh profile-toggle`
  - Flips `tools.profile` between `messaging` and `full`.
- `scripts/platinumfang-mode.sh toggle-all`
  - Runs all four toggles above in sequence and prints status.

## Visual capability map

Read-only live visual:

```bash
scripts/platinumfang-tour.sh
```

It shows:
1. architecture diagram
2. mode semantics
3. live config snapshot
4. command palette

## Pairing workflow

1. DM bot in Discord with `hi`
2. Bot sends pairing code
3. Approve:

```bash
docker compose run --rm openclaw-cli pairing list discord
docker compose run --rm openclaw-cli pairing approve discord <CODE>
```

## Daily operations

Start work:

```bash
scripts/platinumfang-mode.sh safe
```

During work:

```bash
scripts/platinumfang-tour.sh
scripts/platinumfang-mode.sh status
scripts/platinumfang-mode.sh toggle-all
```

End work:

```bash
scripts/platinumfang-mode.sh off
```

## Security reminders

1. Rotate token immediately if leaked
2. Keep mention gating on unless intentionally relaxing it
3. Prefer allowlists over open policies
4. Run weekly:

```bash
docker compose run --rm openclaw-cli security audit --deep
```
