# Platinum Fang Discord Setup Walkthrough

Use this file if terminal output is scrolling away.

## What you need

- Discord account
- A Discord server you control
- Platinum Fang repo and Docker setup already available

## 1) Create a Discord bot

1. Open `https://discord.com/developers/applications`
2. Click **New Application** and name it (example: `Platinum Fang`)
3. Open the app, then go to **Bot**
4. Under **Privileged Gateway Intents**, enable:
   - `Message Content Intent` (required)
   - `Server Members Intent` (recommended)
5. In **Bot**, click **Reset Token** (or **Copy Token**) and save it securely

## 2) Invite bot to your server

1. In the same app, go to **OAuth2** -> **URL Generator**
2. Select scopes:
   - `bot`
   - `applications.commands`
3. Select bot permissions:
   - `View Channels`
   - `Send Messages`
   - `Read Message History`
   - `Embed Links`
   - `Attach Files`
4. Open generated URL, pick your server, authorize

## 3) Get your IDs from Discord app

1. In Discord app: **User Settings** -> **Advanced** -> turn on **Developer Mode**
2. Right-click your server icon -> **Copy Server ID**
3. Right-click your profile/username -> **Copy User ID**

## 4) Configure Platinum Fang (WSL terminal)

From repo root (`/mnt/e/Sterling Storage/openclaw`):

```bash
export DISCORD_BOT_TOKEN="PASTE_NEW_BOT_TOKEN_HERE"
export DISCORD_SERVER_ID="1478877509285318656"
export DISCORD_USER_ID="1143280146435027108"

docker compose run --rm openclaw-cli config set channels.discord.enabled true --json
docker compose run --rm openclaw-cli config set channels.discord.token "\"$DISCORD_BOT_TOKEN\"" --json
```

## 5) Apply hardened Discord mode

```bash
scripts/platinumfang-mode.sh safe
```

This keeps Discord locked down to your server/user policy with mention gating.

## 6) Pair your Discord DM

1. In Discord, DM your bot with a test message (example: `hi`)
2. Bot returns a pairing code
3. Approve it:

```bash
docker compose run --rm openclaw-cli pairing list discord
docker compose run --rm openclaw-cli pairing approve discord <CODE>
```

## 7) Verify status

```bash
scripts/platinumfang-mode.sh status
```

You should see Discord enabled and your model/tool policy values.

## Troubleshooting

- If bot does not reply in DM:
  - Confirm gateway is running: `docker compose ps`
  - Confirm token was set correctly
  - Confirm bot is online in your server
- If `scripts/platinumfang-mode.sh safe` fails:
  - Make sure `DISCORD_SERVER_ID` and `DISCORD_USER_ID` are exported in the same shell
- If token leaked:
  - Reset token in Discord Developer Portal and update config again

## One-shot command block (tailored to your IDs)

Run in WSL after rotating your Discord bot token:

```bash
cd "/mnt/e/Sterling Storage/openclaw"

export DISCORD_BOT_TOKEN="PASTE_NEW_BOT_TOKEN_HERE"
export DISCORD_SERVER_ID="1478877509285318656"
export DISCORD_USER_ID="1143280146435027108"

docker compose run --rm openclaw-cli config set channels.discord.enabled true --json
docker compose run --rm openclaw-cli config set channels.discord.token "\"$DISCORD_BOT_TOKEN\"" --json
docker compose run --rm openclaw-cli config set channels.discord.dmPolicy pairing
docker compose run --rm openclaw-cli config set channels.discord.groupPolicy allowlist
docker compose run --rm openclaw-cli config set channels.discord.guilds '{"1478877509285318656":{"requireMention":true,"users":["1143280146435027108"]}}' --strict-json

scripts/platinumfang-mode.sh safe

unset DISCORD_BOT_TOKEN
```
