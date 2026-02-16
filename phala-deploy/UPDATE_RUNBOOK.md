# Phala Update Runbook (OpenClaw + mux-server)

This is the dedicated, repeatable update procedure for the two-CVM deployment:

- one CVM runs `openclaw`
- one CVM runs `mux-server`

Do not run both services in one CVM.

## Invariants

1. Keep roles separate:
   - OpenClaw CVM uses `phala-deploy/docker-compose.yml`
   - mux CVM uses `phala-deploy/mux-server-compose.yml`
2. Keep images digest-pinned in compose.
3. `MUX_REGISTER_KEY` must match OpenClaw `gateway.http.endpoints.mux.registerKey`.
4. OpenClaw must have `gateway.http.endpoints.mux.inboundUrl` set to a public URL reachable by mux.
5. OpenClaw device identity is stable when `MASTER_KEY` is stable:
   - `openclawId` is the device `deviceId` from `/root/.openclaw/identity/device.json`
   - when `MASTER_KEY` is set, OpenClaw derives the device keypair deterministically, so deleting `device.json` is recoverable after restart

## One-time local setup

```bash
cp phala-deploy/cvm-rollout-targets.env.example phala-deploy/.env.rollout-targets
```

Edit `phala-deploy/.env.rollout-targets` with your CVM IDs (`PHALA_OPENCLAW_CVM_IDS`, `PHALA_MUX_CVM_IDS`).

## No-rv fallback (manual .env files)

If `rv-exec` is unavailable, use local `.env` files with `phala deploy`-compatible key/value pairs.
Keep these files out of git and set strict permissions.

Create OpenClaw deploy env (example):

```bash
cat >/tmp/openclaw-phala-deploy.env <<'EOF'
MASTER_KEY=replace-with-master-key
REDPILL_API_KEY=replace-with-redpill-key
S3_BUCKET=replace-with-bucket
S3_ENDPOINT=replace-with-s3-endpoint
S3_PROVIDER=Other
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=replace-with-access-key-id
AWS_SECRET_ACCESS_KEY=replace-with-secret-access-key
EOF
chmod 600 /tmp/openclaw-phala-deploy.env
```

Create mux deploy env (example):

```bash
cat >/tmp/mux-phala-deploy.env <<'EOF'
MUX_REGISTER_KEY=replace-with-shared-register-key
MUX_ADMIN_TOKEN=replace-with-mux-admin-token
TELEGRAM_BOT_TOKEN=replace-with-telegram-token
DISCORD_BOT_TOKEN=replace-with-discord-token
EOF
chmod 600 /tmp/mux-phala-deploy.env
```

Deploy without `rv-exec`:

```bash
# OpenClaw
phala deploy \
  --cvm-id "$PHALA_OPENCLAW_CVM_IDS" \
  -c phala-deploy/docker-compose.yml \
  -e /tmp/openclaw-phala-deploy.env

# mux-server
phala deploy \
  --cvm-id "$PHALA_MUX_CVM_IDS" \
  -c phala-deploy/mux-server-compose.yml \
  -e /tmp/mux-phala-deploy.env
```

Generate pairing token without `rv-exec`:

```bash
export MUX_ADMIN_TOKEN=replace-with-mux-admin-token
export PHALA_MUX_CVM_ID=<mux-cvm-uuid>
export PHALA_OPENCLAW_CVM_ID=<openclaw-cvm-uuid>
export CVM_SSH_HOST=<openclaw-app-id>-1022.<gateway-domain>

./phala-deploy/mux-pair-token.sh telegram agent:main:main
```

## Standard update flow

### 1. Preflight

```bash
./phala-deploy/deploy.sh --dry-run
```

This validates vault secrets and prints the deploy commands without executing them.

### 2. Build and pin images

OpenClaw:

```bash
./phala-deploy/build-pin-image.sh
```

mux-server (only when mux changed):

```bash
./phala-deploy/build-pin-mux-image.sh
```

### 3. Deploy

```bash
./phala-deploy/deploy.sh
```

This deploys both CVMs, waits for health, and runs smoke tests.

### 4. Verify runtime

OpenClaw CVM:

```bash
export CVM_SSH_HOST=<openclaw-app-id>-1022.<gateway-domain>
./phala-deploy/cvm-exec 'openclaw --version'
./phala-deploy/cvm-exec 'openclaw channels status --probe'
```

mux CVM:

```bash
curl -fsS https://<mux-app-id>-18891.<gateway-domain>/health
phala logs mux-server --cvm-id <mux-cvm-uuid> --tail 120
```

Transient behavior note:

- During/just after rollout, container SSH may briefly fail (for example `Connection closed by UNKNOWN port 65535`) while Docker/app services are restarting.
- Treat this as transient first, not immediate config breakage.
- Verification order:
  1. Check control plane first: `phala cvms get <openclaw-app-id> --json` and confirm status `running` + expected image digest in compose.
  2. Retry `./phala-deploy/cvm-exec 'openclaw --version'` after a short wait.
  3. Only escalate to debugging if repeated retries still fail.

### 5. Pairing smoke check

Pairing token generation is target-driven:

- use OpenClaw session target (`sessionKey`) to choose where the conversation lands
- do not use inbound sender identity to select OpenClaw target

Issue pairing token (admin token):

```bash
export PHALA_MUX_CVM_ID=<mux-cvm-uuid>
export PHALA_OPENCLAW_CVM_ID=<openclaw-cvm-uuid>
export CVM_SSH_HOST=<openclaw-app-id>-1022.<gateway-domain>

rv-exec MUX_ADMIN_TOKEN -- \
  bash -lc './phala-deploy/mux-pair-token.sh telegram agent:main:main'
```

## Fast fixes for known failures

### Telegram/Discord inbound not working

Cause: missing `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` in mux deploy env.

Fix:

1. Ensure `MUX_DEPLOY_SECRETS` in `deploy.sh` includes the required keys.
2. Re-run: `./phala-deploy/deploy.sh`

### mux healthy but no messages forwarded to OpenClaw

Cause: either no pairing binding yet, or the OpenClaw instance has not registered a reachable `inboundUrl`.

Fix:

1. Verify OpenClaw mux config (OpenClaw CVM):
   - `gateway.http.endpoints.mux.baseUrl`
   - `gateway.http.endpoints.mux.registerKey`
   - `gateway.http.endpoints.mux.inboundUrl` (must be public/reachable by mux)
2. Generate a fresh pairing token and pair again:
   - `./phala-deploy/mux-pair-token.sh telegram agent:main:main`
3. Check mux logs for `instance_registered` and `*_inbound_forwarded` / `*_inbound_retry_deferred`.

### mux startup error: `UNIQUE constraint failed: tenants.api_key_hash`

Cause: stale mux DB tenant rows conflict with current bootstrap seed.

Fix:

1. SSH to the mux CVM host and clear mux state volume:
   - `docker rm -f mux-server || true`
   - `docker volume rm -f mux_data || true`
2. Re-run: `./phala-deploy/deploy.sh`

## Related files

- `phala-deploy/deploy.sh`
- `phala-deploy/cvm-rollout-targets.env.example`
- `phala-deploy/mux-pair-token.sh`
- `phala-deploy/mux-server-compose.yml`
