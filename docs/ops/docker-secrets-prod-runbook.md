# OpenClaw Docker Secrets Migration Runbook (Single Environment: Production)

This runbook is designed for your current single-host production deployment:

- Compose project directory: `/home/jpow/openclaw`
- Runtime data directory: `/home/jpow/.openclaw`
- Current service: `openclaw-gateway`
- Current port: `18789`

## 1) Guardrails and Timing

- Schedule a maintenance window.
- Use a hard rollback trigger: **15 minutes after cutover**.
- Do **not** revoke old credentials until all verification checks pass and a human approves.
- Rotation order is mandatory: **create new credentials -> deploy with new -> verify -> revoke old**.

### Important assumptions for this runbook

- This is a **single-host Docker Compose** deployment. File-backed Compose secrets harden host file access, but are not a substitute for centralized secret managers.
- In this OpenClaw version, `_FILE`-style secret vars are not treated as native secret sources by default. Use an explicit entrypoint loader if the app needs env vars.
- Do not assume undocumented built-in secret-backend env vars without verifying in the exact version you run.

Set these session variables first:

```bash
export PROJECT_DIR=/home/jpow/openclaw
export DATA_DIR=/home/jpow/.openclaw
export SECRETS_DIR=/home/jpow/.openclaw/secrets
export SNAPSHOT_DIR=/home/jpow/.openclaw/backups
export CURRENT_PORT=18789
export CANARY_PORT=18791
export ROLLBACK_DEADLINE_MIN=15
export CUTOFF_EPOCH="$(($(date +%s) + ROLLBACK_DEADLINE_MIN*60))"
```

## 2) Pre-flight Snapshot (Explicit)

Take a point-in-time backup before changing anything.

```bash
set -euo pipefail
mkdir -p "$SNAPSHOT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Compose + env snapshot
tar -C "$PROJECT_DIR" -czf "$SNAPSHOT_DIR/openclaw-compose-$STAMP.tgz" docker-compose.yml .env

# Runtime state snapshot
tar -C / -czf "$SNAPSHOT_DIR/openclaw-state-$STAMP.tgz" "${DATA_DIR#/}"

# Secrets snapshot (if already present)
if [ -d "$SECRETS_DIR" ]; then
  tar -C / -czf "$SNAPSHOT_DIR/openclaw-secrets-$STAMP.tgz" "${SECRETS_DIR#/}"
fi

sha256sum "$SNAPSHOT_DIR"/*"$STAMP"*.tgz > "$SNAPSHOT_DIR/sha256-$STAMP.txt"
echo "Pre-flight snapshots created under: $SNAPSHOT_DIR"
```

## 3) Prepare Secret Files (No Plaintext in `.env`)

Create host secret files with strict permissions.

```bash
set -euo pipefail
sudo install -d -m 0700 -o root -g root "$SECRETS_DIR"

# Create files (paste values interactively; avoid shell history)
# OAuth mode: OpenAI API key secret intentionally disabled
sudo sh -c 'umask 077; cat > /home/jpow/.openclaw/secrets/discord_bot_token'
sudo sh -c 'umask 077; cat > /home/jpow/.openclaw/secrets/discord_application_id'
sudo sh -c 'umask 077; cat > /home/jpow/.openclaw/secrets/gateway_token'
sudo sh -c 'umask 077; cat > /home/jpow/.openclaw/secrets/gog_keyring_password'
sudo sh -c 'umask 077; cat > /home/jpow/.openclaw/secrets/perplexity_api_key'
sudo sh -c 'umask 077; cat > /home/jpow/.openclaw/secrets/gemini_api_key'
sudo sh -c 'umask 077; cat > /home/jpow/.openclaw/secrets/notion_api_key'
sudo sh -c 'umask 077; cat > /home/jpow/.openclaw/secrets/dune_api_key'

sudo chown root:root "$SECRETS_DIR"/*
sudo chmod 0400 "$SECRETS_DIR"/*
```

For `notion_api_key`, use a Notion **internal integration token** from the integration `Configuration` tab (commonly `secret_...` or `ntn_...`). Do not use OAuth client secrets from public integration setup.

Also prepare `entrypoint-secrets.sh` in your project to read `/run/secrets/*`, export required env vars in-memory, and `exec` OpenClaw. The loader must fail closed on missing/empty required secret files.

Important:

- Do **not** run a secret file path as a command (for example, `/home/jpow/.openclaw/secrets/gemini_api_key`).
- Secret files are data inputs for the loader, not executables.

## 4) Compose Refactor (Secrets + Canary Service)

Create a temporary override file for canary validation on a second port.

```bash
cat > "$PROJECT_DIR/docker-compose.secrets-canary.yml" <<'YAML'
services:
  openclaw-gateway-secrets:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    network_mode: host
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      - OPENCLAW_BROWSER_WS=${OPENCLAW_BROWSER_WS}
      # Loader reads these files and exports env vars before exec
      # OAuth mode: OpenAI API key secret intentionally disabled
      - OPENAI_API_KEY=
      - DISCORD_BOT_TOKEN=
      - DISCORD_APPLICATION_ID=
      - OPENCLAW_GATEWAY_TOKEN=
      - GOG_KEYRING_PASSWORD=
      - PERPLEXITY_API_KEY=
      - GEMINI_API_KEY=
      - NOTION_API_KEY=
      - DUNE_API_KEY=
      - DISCORD_BOT_TOKEN_PATH=/run/secrets/discord_bot_token
      - DISCORD_APPLICATION_ID_PATH=/run/secrets/discord_application_id
      - OPENCLAW_GATEWAY_TOKEN_PATH=/run/secrets/gateway_token
      - GOG_KEYRING_PASSWORD_PATH=/run/secrets/gog_keyring_password
      - PERPLEXITY_API_KEY_PATH=/run/secrets/perplexity_api_key
      - GEMINI_API_KEY_PATH=/run/secrets/gemini_api_key
      - NOTION_API_KEY_PATH=/run/secrets/notion_api_key
      - DUNE_API_KEY_PATH=/run/secrets/dune_api_key
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
      - ./entrypoint-secrets.sh:/usr/local/bin/entrypoint-secrets.sh:ro
    secrets:
      - source: discord_bot_token
        target: discord_bot_token
        mode: 0400
      - source: discord_application_id
        target: discord_application_id
        mode: 0400
      - source: gateway_token
        target: gateway_token
        mode: 0400
      - source: gog_keyring_password
        target: gog_keyring_password
        mode: 0400
      - source: perplexity_api_key
        target: perplexity_api_key
        mode: 0400
      - source: gemini_api_key
        target: gemini_api_key
        mode: 0400
      - source: notion_api_key
        target: notion_api_key
        mode: 0400
      - source: dune_api_key
        target: dune_api_key
        mode: 0400
    entrypoint: ["/usr/local/bin/entrypoint-secrets.sh"]
    command: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18791"]

secrets:
  discord_bot_token:
    file: /home/jpow/.openclaw/secrets/discord_bot_token
  discord_application_id:
    file: /home/jpow/.openclaw/secrets/discord_application_id
  gateway_token:
    file: /home/jpow/.openclaw/secrets/gateway_token
  gog_keyring_password:
    file: /home/jpow/.openclaw/secrets/gog_keyring_password
  perplexity_api_key:
    file: /home/jpow/.openclaw/secrets/perplexity_api_key
  gemini_api_key:
    file: /home/jpow/.openclaw/secrets/gemini_api_key
  notion_api_key:
    file: /home/jpow/.openclaw/secrets/notion_api_key
  dune_api_key:
    file: /home/jpow/.openclaw/secrets/dune_api_key
YAML
```

Bring up canary:

```bash
cd "$PROJECT_DIR"
docker compose -f docker-compose.yml -f docker-compose.secrets-canary.yml up -d openclaw-gateway-secrets
```

## 5) Verification Command Block (Single Script)

Create and run one script that performs all post-cutover checks.

```bash
cat > /tmp/openclaw-secrets-verify.sh <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

CANARY_PORT="${CANARY_PORT:-18791}"
CANARY_SERVICE_NAME="${CANARY_SERVICE_NAME:-openclaw-openclaw-gateway-secrets-1}"
TOKEN_FILE="${TOKEN_FILE:-/home/jpow/.openclaw/secrets/gateway_token}"
DISCORD_TARGET="${DISCORD_TARGET:-}"  # Example: channel:1234567890
EXPECT_CLEAN_PROC_ENV="${EXPECT_CLEAN_PROC_ENV:-0}"  # 1 only when app reads secret files natively (no env export shim)
RUN_OPENAI_HTTP_PROBE="${RUN_OPENAI_HTTP_PROBE:-0}"  # OAuth mode default: off

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [ ! -s "$TOKEN_FILE" ]; then
  echo "Missing token file: $TOKEN_FILE" >&2
  exit 1
fi
GATEWAY_TOKEN="$(sudo cat "$TOKEN_FILE")"

echo "[1/6] Gateway health endpoint (RPC via CLI)..."
openclaw gateway health --url "ws://127.0.0.1:${CANARY_PORT}" --token "$GATEWAY_TOKEN" --timeout 10000 >/tmp/openclaw-health.json

echo "[2/6] Gateway status probe..."
openclaw gateway status --url "ws://127.0.0.1:${CANARY_PORT}" --token "$GATEWAY_TOKEN" --json >/tmp/openclaw-status.json

echo "[3/6] docker inspect env must not include plaintext secrets..."
if docker inspect "$CANARY_SERVICE_NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(OPENAI_API_KEY|DISCORD_BOT_TOKEN|OPENCLAW_GATEWAY_TOKEN|GOG_KEYRING_PASSWORD)='; then
  echo "FAIL: plaintext secret env vars found in docker inspect" >&2
  exit 1
fi

echo "[4/6] /proc/1/environ check (conditional)..."
if [ "$EXPECT_CLEAN_PROC_ENV" = "1" ]; then
  if docker exec "$CANARY_SERVICE_NAME" sh -lc 'tr "\0" "\n" </proc/1/environ' \
    | grep -E '^(OPENAI_API_KEY|DISCORD_BOT_TOKEN|OPENCLAW_GATEWAY_TOKEN|GOG_KEYRING_PASSWORD)='; then
    echo "FAIL: plaintext secret env vars found in process environment" >&2
    exit 1
  fi
else
  echo "INFO: EXPECT_CLEAN_PROC_ENV=0 (loader exports env vars); skipping hard fail on /proc/1/environ"
fi

echo "[5/6] Discord ping-pong test..."
if [ -z "$DISCORD_TARGET" ]; then
  echo "SKIP: set DISCORD_TARGET to enable Discord ping test"
else
  openclaw message send --channel discord --target "$DISCORD_TARGET" --message "ping from secrets canary $(date -Is)" --json >/tmp/openclaw-discord-send.json
fi

echo "[6/6] OpenAI HTTP probe (optional, OAuth mode default=skip)..."
if [ "$RUN_OPENAI_HTTP_PROBE" = "1" ]; then
  curl -sS "http://127.0.0.1:${CANARY_PORT}/v1/chat/completions" \
    -H "Authorization: Bearer ${GATEWAY_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"reply exactly with pong"}],"max_tokens":8}' \
    | jq -e '.choices[0].message.content' >/tmp/openclaw-openai-probe.json
else
  echo "SKIP: RUN_OPENAI_HTTP_PROBE=0 (OAuth mode)"
fi

echo "PASS: all required checks completed"
BASH

chmod +x /tmp/openclaw-secrets-verify.sh
CANARY_PORT="$CANARY_PORT" EXPECT_CLEAN_PROC_ENV=0 /tmp/openclaw-secrets-verify.sh
```

Gemini wiring verification after canary is up:

```bash
cd "$PROJECT_DIR"
RUNTIME_CHECK=1 bash scripts/test-gemini-secret-wiring.sh
```

Expected result: exits `0` and prints `PASS: Secret wiring checks succeeded`.

Notion wiring verification after canary is up:

```bash
cd "$PROJECT_DIR"
RUNTIME_CHECK=1 bash scripts/test-gemini-secret-wiring.sh --check-notion
```

Expected result: exits `0` and prints `PASS: Secret wiring checks succeeded`.

Why this check uses `/proc/1/environ`:

- The loader exports secrets inside PID 1 before `exec`.
- `docker exec ... env` may not reflect those PID 1 exports.
- `/proc/1/environ` validates what the running gateway process actually received.

Notion runtime alias behavior:

- `NOTION_API_KEY` is the primary variable from Docker secret loading.
- For backward compatibility, runtime also exposes `NOTION_KEY` and `NOTION_TOKEN`.

Common failures and quick fixes:

- `Permission denied` on secret path:
  - You attempted to execute a file path; do not run secret files directly.
- `missing or empty secret file`:
  - Recreate the file and ensure non-empty content with owner `root:root` and mode `0400`.
- `Notion API error 401 unauthorized` after token update:
  - Confirm the token in `notion_api_key` is an internal integration token for the intended workspace.
  - Confirm the target page/database is shared with the integration (`...` -> `Add connections`).
  - Verify token directly with `GET /v1/users/me` using the mounted secret value.
- `OPENCLAW_BROWSER_WS is not set` warning:
  - Non-fatal for Gemini secret wiring; configure later if browser tooling is required.
- `Missing env var "PERPLEXITY_API_KEY" referenced at config path ...` on host CLI:
  - This happens when `openclaw.json` hard-references `"${PERPLEXITY_API_KEY}"` but the host shell lacks that env var.
  - In secrets-based deployments, prefer omitting `tools.web.search.perplexity.apiKey` from config and injecting `PERPLEXITY_API_KEY` at runtime.

## 6) Timed Rollback Trigger (Hard Cutoff)

If all checks are not green before the deadline, rollback immediately.

```bash
if [ "$(date +%s)" -ge "$CUTOFF_EPOCH" ]; then
  echo "Rollback deadline reached; initiating rollback"
  cd "$PROJECT_DIR"
  docker compose -f docker-compose.yml -f docker-compose.secrets-canary.yml rm -sf openclaw-gateway-secrets
  # Ensure original service is running
  docker compose -f docker-compose.yml up -d openclaw-gateway
  exit 1
fi
```

## 7) Cutover Procedure

After canary verification passes:

1. Stop old service.
2. Promote secrets-based service to primary (port 18789).
3. Re-run the verification script against primary port.

Recommended approach:

- Update primary `docker-compose.yml` service to use file-based secrets and remove plaintext secret env vars.
- Keep `docker-compose.secrets-canary.yml` for future rehearsals.

## 8) Old Credential Revocation (Explicit Human Gate)

This step is **separate and manual**. Do not automate.

Required gate before revocation:

- Verification script passed on primary.
- No alerts/regressions for at least 15 minutes.
- Human approver signs off.

Then rotate/revoke old credentials in provider systems:

- OpenAI API key (only if still provisioned)
- Discord bot token
- OpenClaw gateway token
- Keyring password

Record revocation timestamps and ticket/change references.

## 9) Post-Migration Cleanup

- Remove plaintext secrets from `.env`.
- Scrub shell history and CI logs that may contain old secret values.
- Ensure `.openclaw/secrets` remains excluded from backups/artifacts you do not trust.
- Keep this runbook and canary override file for repeatable future rotations.

Optional hardening for single-host deployments:

- Store secrets directory on encrypted storage or tmpfs when possible.
- Use BuildKit secrets for build-time credentials (`RUN --mount=type=secret`) so they are not embedded in layers.

## 10) Quick Rollback Commands

```bash
cd /home/jpow/openclaw
docker compose -f docker-compose.yml -f docker-compose.secrets-canary.yml rm -sf openclaw-gateway-secrets
docker compose -f docker-compose.yml up -d openclaw-gateway
openclaw gateway status --json
```
