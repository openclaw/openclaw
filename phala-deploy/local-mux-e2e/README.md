# Local Mux E2E Stack

This stack mirrors the production shape on one machine:

- `openclaw` container (same `phala-deploy/Dockerfile` path used for CVM image)
- `mux-server` container (Telegram + Discord + WhatsApp inbound/outbound)
- one shared register key (`MUX_REGISTER_KEY`) used only for `POST /v1/instances/register`
- per-instance runtime JWT (mux -> OpenClaw) used for runtime mux APIs (outbound/etc)
- one admin token (`MUX_ADMIN_TOKEN`) used only for control-plane APIs (pairing token issuance)
- per-delivery inbound JWT (mux -> OpenClaw) used for inbound delivery to OpenClaw

## Why this is safe for testing

- Real credentials are used at runtime.
- No production state is reused:
  - OpenClaw state is in local Docker volumes (`openclaw_data`, `openclaw_docker_data`).
  - mux DB/logs are in local Docker volume (`mux_data`).
  - WhatsApp auth is copied to `phala-deploy/local-mux-e2e/state/wa-auth/default` as a test snapshot.

## Credential guardrail (required)

- Do not reuse production WhatsApp auth/session files for local e2e testing.
- Keep a dedicated local test session and point `WA_AUTH_SOURCE` to that test-only path.
- If local auth gets corrupted, relink locally and refresh the local snapshot. Do not copy production creds into local test state.

## Prerequisites

- Docker (Compose v2)
- `curl`, `jq`
- `rv-exec` configured with:
  - `TELEGRAM_BOT_TOKEN`
  - `DISCORD_BOT_TOKEN`
- Optional: a valid WhatsApp auth dir if you want to test WhatsApp:
  - `WA_AUTH_SOURCE=<path-to-local-test-auth>`
- Optional override:
  - `MUX_REGISTER_KEY` (defaults to `local-mux-e2e-register-key`)

## Bring Up

```bash
./phala-deploy/local-mux-e2e/scripts/up.sh
```

What `up.sh` does:

1. Optionally copies WhatsApp auth snapshot into local state (if `WA_AUTH_SOURCE` is set).
2. Injects secrets with `rv-exec` for compose interpolation.
3. Runs `docker compose up -d --build --remove-orphans`.
4. Patches the OpenClaw config in-container to enable mux and restarts OpenClaw.

To enable WhatsApp inbound, set `WA_AUTH_SOURCE` inline or in `phala-deploy/local-mux-e2e/.env.local` (from `.env.example`).

Listener defaults in local e2e:

- Telegram inbound starts automatically when `TELEGRAM_BOT_TOKEN` is present.
- Discord inbound starts automatically when `DISCORD_BOT_TOKEN` is present.
- WhatsApp inbound starts automatically when `state/wa-auth/default/creds.json` exists.

## Pairing UX Test

Generate one-time pairing token:

```bash
./phala-deploy/local-mux-e2e/scripts/pair-token.sh telegram
./phala-deploy/local-mux-e2e/scripts/pair-token.sh discord
./phala-deploy/local-mux-e2e/scripts/pair-token.sh whatsapp
```

What `pair-token.sh` does:

1. Reads `openclawId` from the OpenClaw container device identity.
   - OpenClaw creates this identity on first boot and persists it at `/root/.openclaw/identity/device.json`.
   - When `MASTER_KEY` is set (default in this stack), the device identity is derived deterministically so accidental deletion of `device.json` is recoverable after restart.
2. Calls `POST /v1/admin/pairings/token` using `MUX_ADMIN_TOKEN` (idempotent; also upserts the tenant inbound target).

Then redeem token in channel:

- Telegram: `/start <token>`
- Discord DM: send `<token>`
- WhatsApp DM: send `<token>`

Expected first reply:

- `Paired successfully. You can chat now.`

## Smoke Flow

1. Pair one chat per channel.
2. Send `/help`.
3. Send text + image.
4. Confirm OpenClaw reply arrives through mux path.

Follow logs:

```bash
./phala-deploy/local-mux-e2e/scripts/logs.sh
./phala-deploy/local-mux-e2e/scripts/logs.sh mux-server
./phala-deploy/local-mux-e2e/scripts/logs.sh openclaw
```

## Stop / Reset

Stop only:

```bash
rv-exec TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN -- \
  bash -lc './phala-deploy/local-mux-e2e/scripts/down.sh'
```

Stop and wipe local test state:

```bash
rv-exec TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN -- \
  bash -lc './phala-deploy/local-mux-e2e/scripts/down.sh --wipe'
```
