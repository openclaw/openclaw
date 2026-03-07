# Platinum Fang Next Steps Runbook

This is the post-setup flow after `DISCORD_SETUP_WALKTHROUGH.md`.

## 1) Start gateway in safe mode

Run in WSL:

```bash
cd "/mnt/e/Sterling Storage/openclaw"
scripts/platinumfang-mode.sh safe
```

## 2) Pair Discord DM

1. In Discord, DM your bot with: `hi`
2. Bot returns a pairing code
3. Approve code in WSL:

```bash
docker compose run --rm openclaw-cli pairing list discord
docker compose run --rm openclaw-cli pairing approve discord <CODE>
```

## 3) Verify configuration

```bash
docker compose run --rm openclaw-cli config get channels.discord
docker compose run --rm openclaw-cli config get tools.profile
docker compose run --rm openclaw-cli config get tools.deny
docker compose run --rm openclaw-cli security audit --deep
```

Expected:
- Discord enabled
- `dmPolicy=pairing`
- your guild/user allowlist present
- tools profile set to `messaging` in safe mode

## 4) Test in Discord

DM tests:
1. `what tools can you use right now?`
2. `summarize my tasks for today in 5 bullets`
3. `create a focused work plan for 90 minutes`

Guild test:
1. In your allowed server, mention the bot with a prompt
2. Confirm it only responds when mentioned (safe mode)

## 5) Use on/off switches

```bash
scripts/platinumfang-mode.sh status
scripts/platinumfang-mode.sh mention-off    # allow replies without mention in guild
scripts/platinumfang-mode.sh mention-on     # require mention again
scripts/platinumfang-mode.sh mention-toggle # flip mention requirement
scripts/platinumfang-mode.sh local-only     # local model chain only
scripts/platinumfang-mode.sh cloud-only     # cloud model chain only
scripts/platinumfang-mode.sh model-toggle   # flip local/cloud chain
scripts/platinumfang-mode.sh discord-off    # disable Discord channel
scripts/platinumfang-mode.sh discord-on     # re-enable Discord channel
scripts/platinumfang-mode.sh discord-toggle # flip Discord enabled state
scripts/platinumfang-mode.sh profile-toggle # flip tools profile messaging/full
scripts/platinumfang-mode.sh toggle-all     # flip all main switches at once
scripts/platinumfang-mode.sh power          # more permissive mode
scripts/platinumfang-mode.sh safe           # hardened default
scripts/platinumfang-mode.sh off            # stop containers
```

## 6) Daily routine

Start work:

```bash
cd "/mnt/e/Sterling Storage/openclaw"
scripts/platinumfang-mode.sh safe
```

Finish work:

```bash
cd "/mnt/e/Sterling Storage/openclaw"
scripts/platinumfang-mode.sh off
```

Weekly security check:

```bash
cd "/mnt/e/Sterling Storage/openclaw"
docker compose run --rm openclaw-cli security audit --deep
```
