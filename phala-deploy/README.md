# Deploy OpenClaw on Phala Cloud

Run an OpenClaw gateway inside a Phala Confidential VM (CVM) with optional encrypted S3-backed storage.

## Storage modes

| Mode                 | State location                            | Persistence              | Best for              |
| -------------------- | ----------------------------------------- | ------------------------ | --------------------- |
| **S3 (recommended)** | Encrypted S3 bucket via rclone FUSE mount | Survives CVM destruction | Production            |
| **Local volume**     | Docker volume inside the CVM              | Lost if CVM is destroyed | Testing / development |

S3 mode is enabled by setting `S3_BUCKET`. Without it, the CVM uses a local Docker volume.

## Prerequisites

- A [Phala Cloud](https://cloud.phala.com) account
- The [Phala CLI](https://docs.phala.network/cli) installed: `npm install -g phala`
- Docker installed locally (for building the image)
- An SSH key pair (for accessing the CVM)
- (S3 mode) An S3-compatible bucket (Cloudflare R2, AWS S3, MinIO, etc.)

## Quick start

### 1. Create an S3 bucket (skip for local-only mode)

**Cloudflare R2** (recommended for simplicity):

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) > R2 > **Create bucket**
2. Go to R2 > **Manage R2 API Tokens** > **Create API Token**
3. Set permissions to **Object Read & Write**, scope to your bucket
4. Save the **Access Key ID** and **Secret Access Key**

### 2. Generate a master key

The master key derives all encryption passwords and the gateway auth token. Keep it safe — if you lose it, your encrypted data is unrecoverable.

```sh
head -c 32 /dev/urandom | base64
```

### 3. Generate `OPENCLAW_CONFIG_B64`

Every CVM deployment needs a bootstrap config. Use `gen-cvm-config.sh` to generate it — it derives the gateway auth token from `MASTER_KEY`, sets up mux registration, channels, and agent defaults:

```sh
OPENCLAW_CONFIG_B64=$(MASTER_KEY="<your-master-key>" \
  MUX_BASE_URL="https://<mux_app_id>-18891.<gateway>.phala.network" \
  MUX_REGISTER_KEY="<your-register-key>" \
  ./phala-deploy/gen-cvm-config.sh)
```

You need the **mux base URL** and **register key** from the mux-server deployment. The **inbound URL** (where mux delivers messages back to your OpenClaw) is derived automatically at runtime from `DSTACK_APP_ID` and `DSTACK_GATEWAY_DOMAIN` env vars injected by the Phala platform — you don't need to know your app ID upfront.

Optional env vars for `gen-cvm-config.sh`:

| Variable         | Default     | Description          |
| ---------------- | ----------- | -------------------- |
| `MODEL_BASE_URL` | _(omitted)_ | AI provider base URL |
| `MODEL_API_KEY`  | _(omitted)_ | AI provider API key  |

> **Tip:** With [Redpill Vault](https://github.com/aspect-build/redpill-vault), pull secrets from the vault instead of passing them inline:
>
> ```sh
> OPENCLAW_CONFIG_B64=$(rv-exec --project openclaw \
>   MASTER_KEY MUX_REGISTER_KEY \
>   -- bash -c 'MUX_BASE_URL="https://<mux_app_id>-18891.<gateway>.phala.network" \
>     ./phala-deploy/gen-cvm-config.sh')
> ```

### 4. Prepare deploy env file

Create a deploy env file with your secrets:

```sh
cat > /tmp/deploy.env <<EOF
MASTER_KEY=<your-master-key>
REDPILL_API_KEY=<your-redpill-api-key>
S3_BUCKET=<your-bucket-name>
S3_ENDPOINT=<your-s3-endpoint>
S3_PROVIDER=Other
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>
OPENCLAW_CONFIG_B64=${OPENCLAW_CONFIG_B64}
EOF
chmod 600 /tmp/deploy.env
```

Local-only mode only needs `MASTER_KEY`, `REDPILL_API_KEY`, and `OPENCLAW_CONFIG_B64` — omit the S3 variables.

Get a Redpill API key at [redpill.ai](https://redpill.ai). This gives access to GPU TEE models (DeepSeek, Qwen, Llama, etc.) with end-to-end encrypted inference.

> **Tip:** With Redpill Vault, generate the env file from vault secrets:
>
> ```sh
> rv-exec --dotenv /tmp/deploy.env \
>   MASTER_KEY REDPILL_API_KEY \
>   S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION \
>   AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
>   -- bash -lc 'test -s /tmp/deploy.env && echo "deploy env ready"'
> # Then append OPENCLAW_CONFIG_B64 (generated in step 3)
> echo "OPENCLAW_CONFIG_B64=${OPENCLAW_CONFIG_B64}" >> /tmp/deploy.env
> ```

### 5. Docker image

A pre-built image is available on Docker Hub. The `docker-compose.yml` already pins the image by digest. No build step needed unless you want a custom image.

To build your own:

```sh
pnpm build
pnpm ui:install
pnpm ui:build
npm pack
mv openclaw-<version>.tgz phala-deploy/openclaw.tgz
docker build -f phala-deploy/Dockerfile -t your-dockerhub-user/openclaw-cvm:latest .
docker push your-dockerhub-user/openclaw-cvm:latest
# Then update the image: line in docker-compose.yml
```

### 6. Deploy to Phala Cloud

```sh
phala deploy \
  -n my-openclaw \
  -c phala-deploy/docker-compose.yml \
  -e /tmp/deploy.env \
  -t tdx.medium \
  --dev-os \
  --wait
```

The `-e /tmp/deploy.env` flag passes your secrets as encrypted environment variables. They are injected at runtime and never stored in plaintext.

The CLI will output your CVM ID and dashboard URL. Save these.

### 7. Verify

Check the container logs:

```sh
phala logs openclaw --cvm-id <your-cvm-name-or-uuid>
```

**S3 mode** — you should see:

```
Deriving keys from MASTER_KEY...
Keys derived (crypt password, crypt salt, gateway token).
S3 storage configured (bucket: ...), setting up rclone...
Attempting FUSE mount...
rclone FUSE mount ready at /data
Home symlinks created (~/.openclaw, ~/.config → /data)
SSH daemon started.
Docker daemon ready.
```

**Local-only mode** — you should see:

```
Deriving keys from MASTER_KEY...
Keys derived (crypt password, crypt salt, gateway token).
Home symlinks created (~/.openclaw, ~/.config → /data)
SSH daemon started.
Docker daemon ready.
```

### 8. What's next

1. **Open the dashboard** — go to `https://<app_id>-18789.<gateway>.phala.network?token=<your-gateway-token>` (see [Connecting to your gateway](#connecting-to-your-gateway) for how to construct this URL)

2. **Create your agent** — send `wake up` in the dashboard chat. The agent will walk you through creating a persona (name, personality, instructions).

3. **Connect Telegram** — once your agent is set up, send a message in the dashboard chat asking it to connect to your Telegram bot. Provide your Telegram bot token (from [@BotFather](https://t.me/BotFather)) and the agent will set up the connection and pair itself with the bot.

After that, your agent is live on Telegram and you can chat with it there.

## Mux registration

Every OpenClaw CVM registers with a mux-server on boot. The bootstrap config (`OPENCLAW_CONFIG_B64`, generated in [step 3](#3-generate-openclaw_config_b64)) contains the mux endpoint, register key, and channel routing.

### How it works

1. OpenClaw boots and reads `openclaw.json` with the mux config.
2. It derives a stable device identity from `MASTER_KEY` (via HKDF).
3. It calls `POST /v1/instances/register` on the mux-server with the `registerKey`.
4. Mux-server issues a runtime JWT (24h TTL). OpenClaw caches and auto-refreshes it.
5. Inbound messages (mux -> OpenClaw) are delivered to `inboundUrl`, authenticated via JWKS.

The `inboundUrl` uses `${DSTACK_APP_ID}` and `${DSTACK_GATEWAY_DOMAIN}` placeholders, resolved by the config loader's env-substitution at boot time.

Runtime JWT contract details: `mux-server/JWT_INSTANCE_RUNTIME_DESIGN.md`.

### Pair channels

Once the CVM is running, generate a pairing token to link a chat to your instance:

```sh
./phala-deploy/mux-pair-token.sh telegram
```

This calls `POST /v1/admin/pairings/token` on the mux-server. Send the returned token as a message in the Telegram bot to complete pairing.

### Manual pairing (without mux-pair-token.sh)

If you don't have `.env.rollout-targets`, issue tokens directly:

```sh
# 1. Get the device ID from the OpenClaw CVM
phala ssh <openclaw-cvm-id> -- \
  'docker exec openclaw cat /root/.openclaw/identity/device.json' \
  | jq -r .deviceId

# 2. Build the payload (telegram example — change channel for whatsapp/discord)
jq -nc \
  --arg oid "<deviceId>" \
  --arg iu "https://<openclaw-app-id>-18789.<gateway>/v1/mux/inbound" \
  '{openclawId:$oid, inboundUrl:$iu, inboundTimeoutMs:15000, channel:"telegram", ttlSec:900}' \
  > /tmp/pair.json

# 3. Issue the token
curl -sS -X POST "https://<mux-app-id>-18891.<gateway>/v1/admin/pairings/token" \
  -H "Authorization: Bearer <MUX_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d @/tmp/pair.json | jq .
```

The response includes `token` (and `startCommand` for Telegram). Send the token as a message in the chat to complete pairing.

### Modifying config on an existing CVM

> **Important:** `OPENCLAW_CONFIG_B64` is only written on **first boot** (when no `openclaw.json` exists). Subsequent deploys with `phala deploy` preserve the existing config on the data volume. To change config after first boot, edit the file directly.

Use `phala ssh` and `phala cp` to transfer files — this works even on images without SSH:

```sh
# 1. Download: container → CVM host → local
phala ssh <cvm-id> -- docker cp openclaw:/root/.openclaw/openclaw.json /tmp/openclaw.json
phala cp <cvm-id>:/tmp/openclaw.json ./openclaw.json

# 2. Edit locally
vi ./openclaw.json   # or jq, node -e, etc.

# 3. Upload: local → CVM host → container
phala cp ./openclaw.json <cvm-id>:/tmp/openclaw.json
phala ssh <cvm-id> -- docker cp /tmp/openclaw.json openclaw:/root/.openclaw/openclaw.json

# 4. Restart to pick up changes
phala ssh <cvm-id> -- docker restart openclaw
```

> **Note:** A few fields hot-reload without restart (e.g., `skills`, `agents.defaults.model.primary`), but structural changes (model providers, gateway config) require a container restart.

Key config fields:

1. `gateway.http.endpoints.mux` — `enabled`, `baseUrl`, `registerKey`, `inboundUrl`
   - For `inboundUrl`, use `https://${DSTACK_APP_ID}-18789.${DSTACK_GATEWAY_DOMAIN}/v1/mux/inbound` — the placeholders are resolved at boot time
2. `channels.<channel>.accounts.mux` — `enabled: true` and `mux: { enabled: true, timeoutMs: 30000 }`
3. `plugins.entries.<channel>.enabled` — `true` for each channel

### Config migrations

`migrate-openclaw.sh` applies idempotent patches to a running CVM's `openclaw.json`. It downloads the config, runs each migration locally, and uploads it back only if something changed.

Available migrations:

| Migration  | Trigger env var       | What it does                                                                            |
| ---------- | --------------------- | --------------------------------------------------------------------------------------- |
| `composio` | `COMPOSEIO_ADMIN_API` | Creates a Composio Tool Router session, injects `COMPOSIO_MCP_URL` + `COMPOSIO_API_KEY` |

Usage:

```sh
# With Composio API key from vault:
rv-exec COMPOSEIO_ADMIN_API -- bash phala-deploy/migrate-openclaw.sh <cvm-id>

# With API key directly:
COMPOSEIO_ADMIN_API=ak_xxx bash phala-deploy/migrate-openclaw.sh <cvm-id>
```

After migration, restart the container so the entrypoint writes the mcporter config:

```sh
phala ssh <cvm-id> -- docker restart openclaw
```

Verify Composio is working:

```sh
phala ssh <cvm-id> -- 'docker exec openclaw mcporter list clawdi-mcp'
# Should show 6 tools
```

## How S3 storage works

The entrypoint tries two S3 sync strategies in order:

### FUSE mount (preferred)

If `/dev/fuse` is available, rclone mounts the encrypted S3 bucket directly at `/data/openclaw` as a FUSE filesystem. The VFS cache layer handles syncing automatically:

- Writes are cached locally and flushed to S3 after 5 seconds idle
- Reads go through the local cache
- No background sync jobs needed — rclone handles everything
- SQLite (memory.db) works directly on the mount via the VFS write cache

```
/data/openclaw  (FUSE mount)
  └── rclone crypt (NaCl SecretBox)
       └── S3 bucket (encrypted blobs + encrypted filenames)
```

### Sync fallback

If FUSE is unavailable, the entrypoint falls back to periodic `rclone copy`:

- On boot: pulls all state from S3 to the local Docker volume
- Every 60 seconds: pushes changes back to S3
- SQLite files are kept in a separate local directory and synced independently
- Symlinks redirect `memory.db` from the state dir to local storage

Maximum data loss in sync mode: 60 seconds of writes.

## How encryption works

```
MASTER_KEY (one secret)
  ├── HKDF("rclone-crypt-password")  → file encryption key
  ├── HKDF("rclone-crypt-salt")      → encryption salt
  └── HKDF("gateway-auth-token")     → gateway auth
```

- All files are encrypted client-side before upload (NaCl SecretBox)
- Filenames are encrypted (S3 bucket contents are unreadable)
- S3 provider never sees plaintext

For full details, see [S3_STORAGE.md](S3_STORAGE.md).

## Connecting to your gateway

The gateway listens on port 18789. The CVM exposes it via the Phala network at:

```
https://<app_id>-18789.<gateway>.phala.network
```

Find your `app_id` and `gateway` in the Phala dashboard under your CVM's details, or from the deploy output.

To open the dashboard with authentication, append your gateway token to the URL:

```
https://<app_id>-18789.<gateway>.phala.network?token=<your-gateway-token>
```

The gateway auth token is derived from your master key, so it is stable across restarts. You can derive it locally:

```sh
node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', '<your-master-key>', '', 'gateway-auth-token', 32);
  console.log(Buffer.from(key).toString('base64').replace(/[/+=]/g, '').slice(0, 32));
"
```

## SSH access

The container runs an SSH daemon on port 1022. The CVM exposes it via the Phala network.

### Setup

Set the SSH host (find `app_id` and `gateway` from the Phala dashboard):

```sh
export CVM_SSH_HOST=<app_id>-1022.<gateway>.phala.network
```

Your SSH public key is automatically injected into the container from the CVM host.

### Usage

```sh
# Interactive shell
./phala-deploy/cvm-ssh

# Run a command
./phala-deploy/cvm-exec 'openclaw channels status --probe'

# Copy files to/from the container
./phala-deploy/cvm-scp pull /root/.openclaw ./backup
./phala-deploy/cvm-scp push ./backup /root/.openclaw
```

**Note:** The entrypoint creates symlinks `~/.openclaw → /data/openclaw` and `~/.config → /data/.config`, so `openclaw` commands work without any env var prefixes.

### Restart policy

The entrypoint keeps SSH available even if the gateway crashes and restarts it with backoff.

- `OPENCLAW_GATEWAY_RESTART_DELAY` sets the initial backoff in seconds (default `5`).
- `OPENCLAW_GATEWAY_RESTART_MAX_DELAY` caps backoff in seconds (default `60`).
- `OPENCLAW_GATEWAY_RESET_AFTER` resets backoff after a stable run (seconds, default `600`).

## Updating

Two commands: build, then deploy.

```sh
# Build and push images
./phala-deploy/build-pin-openclaw.sh
./phala-deploy/build-pin-mux.sh        # only when mux changed

# Deploy OpenClaw CVM
rv-exec MASTER_KEY REDPILL_API_KEY S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY MUX_REGISTER_KEY \
  -- bash phala-deploy/deploy-openclaw.sh

# Deploy mux-server CVM
rv-exec MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN_PROD DISCORD_BOT_TOKEN_PROD \
  -- bash phala-deploy/deploy-mux.sh
```

Both deploy scripts accept `--dry-run`, `--test-only` (smoke tests without deploying), and `--skip-test`.

All scripts read CVM IDs from `phala-deploy/.env.rollout-targets` (see `cvm-rollout-targets.env.example`).

### Manual deploy (without deploy-openclaw.sh)

If you manage secrets outside rv vault (e.g., a local env file), deploy manually:

```sh
# 1. Build and push a new image (pins digest in docker-compose.yml)
./phala-deploy/build-pin-openclaw.sh

# 2. Download the existing config from the CVM (preserved across deploys)
phala ssh <cvm-id> -- docker cp openclaw:/root/.openclaw/openclaw.json /tmp/openclaw.json
phala cp <cvm-id>:/tmp/openclaw.json ./openclaw.json

# 3. Base64-encode it
OPENCLAW_CONFIG_B64=$(base64 -w0 ./openclaw.json)

# 4. Build your env file (S3 vars optional — omit for local-only mode)
cat > /tmp/deploy.env <<EOF
MASTER_KEY=<from-your-env-file>
REDPILL_API_KEY=<your-key>
OPENCLAW_CONFIG_B64=${OPENCLAW_CONFIG_B64}
EOF
chmod 600 /tmp/deploy.env

# 5. Deploy
phala deploy --cvm-id <cvm-id> -c phala-deploy/docker-compose.yml -e /tmp/deploy.env

# 6. Wait for the CVM to come up (image pull can take 5-10 min on a new node)
phala cvms list    # check status: starting → running

# 7. Verify
phala ssh <cvm-id> -- docker logs openclaw 2>&1 | grep -iE '(mcporter|Starting|error)'
```

> **Tip:** If you only need to update the config (not the image), skip steps 1 and 4-5 and use the [download-edit-upload](#modifying-config-on-an-existing-cvm) workflow instead.

**Verification:** each deploy script runs smoke tests automatically. For manual checks:

```sh
./phala-deploy/cvm-exec 'openclaw --version'
./phala-deploy/cvm-exec 'openclaw channels status --probe'
```

Full runbook with fallback procedures: `phala-deploy/UPDATE_RUNBOOK.md`.

## Disaster recovery

If your CVM is destroyed (S3 mode only):

1. Create a new CVM with the same `MASTER_KEY` and S3 credentials
2. The entrypoint derives the same keys, mounts S3, and everything is restored
3. Config, agents, and memory are all recovered automatically
4. The gateway auth token is the same — existing clients reconnect without changes
5. The OpenClaw device identity is also the same — mux pairings remain stable as long as the mux DB is intact

## File reference

| File                     | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `Dockerfile`             | CVM image (Ubuntu 24.04 + Node 24 + rclone + Docker-in-Docker)    |
| `entrypoint.sh`          | Boot sequence: key derivation, S3 mount, SSH, Docker, gateway     |
| `docker-compose.yml`     | Compose file for `phala deploy`                                   |
| `mux-server-compose.yml` | Compose file for mux-server CVM deployment                        |
| `build-pin-openclaw.sh`  | Rebuild tarball + image, push, and pin compose image digest       |
| `build-pin-mux.sh`       | Rebuild mux image, push, and pin mux compose digest               |
| `deploy-openclaw.sh`     | Deploy OpenClaw CVM, wait for health, run smoke tests             |
| `deploy-mux.sh`          | Deploy mux-server CVM, wait for health, run smoke tests           |
| `migrate-openclaw.sh`    | Apply config migrations to a running CVM via SSH                  |
| `gen-cvm-config.sh`      | Generate `OPENCLAW_CONFIG_B64` from env vars (MASTER_KEY, etc.)   |
| `mux-pair-token.sh`      | Mint mux pairing token for a tenant OpenClaw instance (admin API) |
| `UPDATE_RUNBOOK.md`      | Detailed update runbook with fallback procedures                  |
| `cvm-ssh`                | Interactive SSH into the container                                |
| `cvm-exec`               | Run a command in the container                                    |
| `cvm-scp`                | Copy files to/from the container                                  |
| `S3_STORAGE.md`          | Detailed S3 encryption documentation                              |

## CVM environment notes

- The Ubuntu base image is minimal: install `unzip` (for bun), `tmux`, and use nodesource repo for Node 24 (default apt gives Node 12).
- Entrypoint starts SSH before dockerd — SSH is always available for debugging, even if dockerd fails.
- Backgrounding over non-interactive SSH is unreliable; use tmux inside the CVM.
- Docker uses static binaries from `download.docker.com/linux/static/stable/` (not `apt docker-ce`). Do **not** bind-mount Docker binaries from the CVM host (ELF interpreter mismatch: host `/lib/ld-linux-x86-64.so.2` vs container `/lib64/`).
- Dockerfile: `build-essential` is installed, used for `npm install`, then purged in the same `RUN` layer. Never split install and purge across layers.
- Auto-update is disabled in bootstrap config (`update.checkOnStart=false`); updates happen via Docker image rebuilds.

## Local Mux E2E

For local end-to-end testing of `mux-server + openclaw` with real channel credentials but isolated test state, see `phala-deploy/local-mux-e2e/README.md`.

Important guardrail: never reuse production WhatsApp auth/session files in the local mux e2e stack.

## Troubleshooting

**FUSE mount falls back to sync mode**

- This is expected if `/dev/fuse` is not available. Sync mode works but has up to 60s data loss on destruction.
- Check logs for "FUSE mount failed, falling back to sync mode."

**Gateway says "Missing config"**

- The S3 mount may not be ready. Check `mount | grep fuse.rclone` via SSH.

**"container name already in use" on redeploy**

- The old container auto-restarts before compose runs. Wait a moment and retry, or check `journalctl -u app-compose` on the VM host.

**Docker daemon fails inside CVM**

- This is non-critical (gateway works without it). The CVM kernel may not support all iptables modules. Check logs for details.

**dockerd fails to start on container restart**

- Stale PID files cause "process with PID N is still running". The entrypoint cleans them (`rm -f /var/run/docker.pid /var/run/containerd/containerd.pid`), but if you start dockerd manually, clean them yourself.

**Docker networking / iptables errors**

- The CVM kernel does **not** support `nf_tables`. Ubuntu 24.04 defaults to the nft backend, which fails with "Could not fetch rule set generation id: Invalid argument". Fix: `update-alternatives --set iptables /usr/sbin/iptables-legacy` in the Dockerfile. ip6tables warnings are harmless.

**Docker-in-Docker storage**

- DinD inside the CVM requires `--storage-driver=vfs` (overlay-on-overlay fails inside the TEE VM).
