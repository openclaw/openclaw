# Docker Secrets Runbook (OpenClaw / Clawdbot)

This document is the operational reference for the secrets-based deployment on this host.

## Current Deployment Mode

- Single-host production deployment
- Secrets source directory: `/home/jpow/.openclaw/secrets`
- Compose override in use: `/home/jpow/openclaw/docker-compose.secrets-canary.yml`
- Loader script: `/home/jpow/openclaw/entrypoint-secrets.sh`
- Runtime auth model: OpenAI Codex OAuth (no static OpenAI API key required)

## Required Secret Files

All files must be:

- owner: `root:root`
- mode: `0400`
- directory `/home/jpow/.openclaw/secrets` mode: `0700`

Required files:

- `/home/jpow/.openclaw/secrets/discord_bot_token`
- `/home/jpow/.openclaw/secrets/discord_application_id`
- `/home/jpow/.openclaw/secrets/gateway_token`
- `/home/jpow/.openclaw/secrets/gog_keyring_password`
- `/home/jpow/.openclaw/secrets/perplexity_api_key`
- `/home/jpow/.openclaw/secrets/gemini_api_key`
- `/home/jpow/.openclaw/secrets/notion_api_key`

## Verify Secret Files

```bash
sudo ls -la /home/jpow/.openclaw/secrets
sudo sh -c 'for f in /home/jpow/.openclaw/secrets/discord_bot_token /home/jpow/.openclaw/secrets/discord_application_id /home/jpow/.openclaw/secrets/gateway_token /home/jpow/.openclaw/secrets/gog_keyring_password /home/jpow/.openclaw/secrets/perplexity_api_key /home/jpow/.openclaw/secrets/gemini_api_key /home/jpow/.openclaw/secrets/notion_api_key; do [ -s "$f" ] && echo "$f OK" || echo "$f MISSING_OR_EMPTY"; done'
```

Create/update Gemini secret:

```bash
read -rsp "GEMINI_API_KEY: " V; echo; printf '%s\n' "$V" | sudo tee /home/jpow/.openclaw/secrets/gemini_api_key >/dev/null; unset V
sudo chown root:root /home/jpow/.openclaw/secrets/gemini_api_key
sudo chmod 0400 /home/jpow/.openclaw/secrets/gemini_api_key
```

Important:

- Do **not** run the secret file path as a command (for example, `/home/jpow/.openclaw/secrets/gemini_api_key`).
- Secret files are data, not executables.

## Update a Secret (Rotation)

Example: rotate Discord bot token

```bash
read -rsp "DISCORD_BOT_TOKEN: " V; echo; printf '%s\n' "$V" | sudo tee /home/jpow/.openclaw/secrets/discord_bot_token >/dev/null; unset V
sudo chown root:root /home/jpow/.openclaw/secrets/discord_bot_token
sudo chmod 0400 /home/jpow/.openclaw/secrets/discord_bot_token
```

Then restart container:

```bash
cd /home/jpow/openclaw
docker compose -f docker-compose.yml -f docker-compose.secrets-canary.yml up -d --force-recreate openclaw-gateway-secrets
```

## Health Checks

```bash
TOKEN=$(sudo cat /home/jpow/.openclaw/secrets/gateway_token)
cd /tmp
OPENCLAW_STATE_DIR=/home/jpow/.openclaw OPENCLAW_CONFIG_PATH=/home/jpow/.openclaw/openclaw.json openclaw gateway health --url ws://127.0.0.1:18789 --token "$TOKEN" --timeout 10000
```

Quick runtime checks:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
ss -lnt | awk 'NR==1 || $4 ~ /:18789$/'
docker logs --tail 120 openclaw-openclaw-gateway-secrets-1 2>&1 | egrep -i 'discord|logged in|fatal|error|channel exited'
```

## Gemini Wiring Smoke Test

Run this flow after creating/updating the Gemini secret:

1) Recreate the secrets service:

```bash
cd /home/jpow/openclaw
docker compose -f docker-compose.yml -f docker-compose.secrets-canary.yml up -d --force-recreate openclaw-gateway-secrets
```

2) Run the smoke test (static checks + secret file check):

```bash
cd /home/jpow/openclaw
bash scripts/test-gemini-secret-wiring.sh
```

3) Run runtime verification (checks secret is present in the running gateway process):

```bash
cd /home/jpow/openclaw
RUNTIME_CHECK=1 bash scripts/test-gemini-secret-wiring.sh
```

Expected result: command exits `0` and prints `PASS: Secret wiring checks succeeded`.

Why runtime verification reads `/proc/1/environ`:

- `entrypoint-secrets.sh` exports secrets in PID 1 before launching OpenClaw.
- `docker exec ... env` can miss those exports for the exec process.
- Reading `/proc/1/environ` verifies what the running gateway process actually received.

## Notion Wiring Smoke Test

Run this after creating/updating the Notion secret:

```bash
cd /home/jpow/openclaw
bash scripts/test-gemini-secret-wiring.sh --check-notion
```

Runtime verification:

```bash
cd /home/jpow/openclaw
RUNTIME_CHECK=1 bash scripts/test-gemini-secret-wiring.sh --check-notion
```

Expected result: command exits `0` and prints `PASS: Secret wiring checks succeeded`.

## Notion Token Type and Runtime Names

- Use a **Notion internal integration token** from the integration `Configuration` tab (for example `secret_...` or `ntn_...`).
- Do **not** use OAuth client secrets from public integration setup for this flow.
- Store that token in `/home/jpow/.openclaw/secrets/notion_api_key`.
- At runtime, OpenClaw exports all of these for compatibility:
	- `NOTION_API_KEY` (primary)
	- `NOTION_KEY` (legacy)
	- `NOTION_TOKEN` (legacy)

Quick API credential check from running container:

```bash
docker exec openclaw-openclaw-gateway-secrets-1 sh -lc 'key=$(cat /run/secrets/notion_api_key); curl -sS -o /tmp/notion-users-me.json -w "%{http_code}\n" -X GET https://api.notion.com/v1/users/me -H "Authorization: Bearer $key" -H "Notion-Version: 2025-09-03" -H "Content-Type: application/json"; sed -n "1,60p" /tmp/notion-users-me.json'
```

Expected: HTTP `200`.

Common failures and fixes:

- `Permission denied` on `/home/jpow/.openclaw/secrets/gemini_api_key`:
	- You tried to execute the file; create/read it with shell commands instead.
- `FAIL: missing or empty secret file`:
	- Recreate it and ensure non-empty content, owner `root:root`, mode `0400`.
- `Notion API error 401 unauthorized` even after secret rotation:
	- Verify the token is an **internal integration token** and belongs to the correct workspace.
	- Ensure the target page/database is explicitly shared with the integration (`...` -> `Add connections`).
- Agent asks for token/database paste in chat:
	- This usually indicates stale conversation context or old prompt behavior. Run `/reset` in the channel and retry.
- Compose warning `OPENCLAW_BROWSER_WS is not set`:
	- This warning is non-fatal for Gemini secret wiring tests.
- `Missing env var "PERPLEXITY_API_KEY" referenced at config path ...` when running host CLI:
	- If `openclaw.json` contains `tools.web.search.perplexity.apiKey: "${PERPLEXITY_API_KEY}"`, host-side commands require that env var in the shell.
	- In this Docker-secrets setup, prefer omitting `apiKey` from config and supplying `PERPLEXITY_API_KEY` via container runtime secrets/env.

## Rollback

If startup/health fails:

```bash
cd /home/jpow/openclaw
docker compose -f docker-compose.yml -f docker-compose.secrets-canary.yml stop openclaw-gateway-secrets
docker compose -f docker-compose.yml -f docker-compose.secrets-canary.yml rm -f openclaw-gateway-secrets
# optional fallback
# docker compose -f docker-compose.yml up -d openclaw-gateway
```

## Notes

- `.env` has been sanitized (secrets blanked). Keep secrets in files only.
- `entrypoint-secrets.sh` exports secrets to env for runtime compatibility.
- Because of that export step, `/proc/1/environ` in the container may contain secret env vars.
- On low-memory hosts, avoid running dual containers for long periods.
