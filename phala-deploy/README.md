# Deploy OpenClaw on Phala Cloud

Run an OpenClaw gateway inside a Phala Confidential VM (CVM) with optional encrypted S3-backed storage.

## Local Mux E2E (Control-Plane Dry Run)

For local end-to-end testing of `mux-server + openclaw` with real channel credentials but isolated test state, use:

- `phala-deploy/local-mux-e2e/README.md`

Important guardrail:

- Never reuse production WhatsApp auth/session files in the local mux e2e stack.

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

### 3. Prepare deploy env vars (recommended: Redpill Vault)

Generate a temporary deploy env file with `rv-exec`:

```sh
cd phala-deploy
rv-exec --dotenv /tmp/deploy.env \
  MASTER_KEY REDPILL_API_KEY \
  S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
  -- bash -lc 'test -s /tmp/deploy.env && echo "deploy env ready: /tmp/deploy.env"'
```

Notes:

- S3 mode needs all S3 variables above.
- Local-only mode only needs `MASTER_KEY` and `REDPILL_API_KEY`.
- Prefer this flow over plaintext `.env` files for production deploys.

Get a Redpill API key at [redpill.ai](https://redpill.ai). This gives access to GPU TEE models (DeepSeek, Qwen, Llama, etc.) with end-to-end encrypted inference.

### 4. Docker image

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

### 5. Deploy to Phala Cloud

```sh
cd phala-deploy

phala deploy \
  -n my-openclaw \
  -c docker-compose.yml \
  -e /tmp/deploy.env \
  -t tdx.medium \
  --dev-os \
  --wait
```

The `-e /tmp/deploy.env` flag passes your secrets as encrypted environment variables. They are injected at runtime and never stored in plaintext.

The CLI will output your CVM ID and dashboard URL. Save these.

### 6. Verify

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

### 7. What's next

1. **Open the dashboard** — go to `https://<app_id>-18789.<gateway>.phala.network?token=<your-gateway-token>` (see [Connecting to your gateway](#connecting-to-your-gateway) for how to construct this URL)

2. **Create your agent** — send `wake up` in the dashboard chat. The agent will walk you through creating a persona (name, personality, instructions).

3. **Connect Telegram** — once your agent is set up, send a message in the dashboard chat asking it to connect to your Telegram bot. Provide your Telegram bot token (from [@BotFather](https://t.me/BotFather)) and the agent will set up the connection and pair itself with the bot.

After that, your agent is live on Telegram and you can chat with it there.

## Mux + OpenClaw Rollout Checklist

Use this when rolling out shared mux bots plus tenant OpenClaw instances.

1. Deploy mux-server as its own CVM with persistent storage for:
   - mux SQLite/log path (`/data`)
   - WhatsApp auth snapshot path (`/wa-auth/default`)
2. Inject mux runtime secrets from `rv`:
   - `MUX_REGISTER_KEY` (must match tenant OpenClaw `gateway.http.endpoints.mux.registerKey`)
   - `MUX_ADMIN_TOKEN` (required for control-plane pairing token issuance)
   - optional: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `MUX_JWT_PRIVATE_KEY`
3. For each tenant OpenClaw instance:
   - set `gateway.http.endpoints.mux.baseUrl`
   - set `gateway.http.endpoints.mux.registerKey`
   - set `gateway.http.endpoints.mux.inboundUrl` (public URL reachable by mux)
   - enable channel account `mux` for `telegram`, `discord`, `whatsapp`
4. OpenClaw auto-registers itself with mux on boot (register key -> runtime JWT).
5. Validate with live checks:
   - pair chat using token (`/v1/admin/pairings/token`)
   - send `/help` via mux channel
   - verify OpenClaw version and health via `./phala-deploy/cvm-exec`

Runtime JWT contract details live in `mux-server/JWT_INSTANCE_RUNTIME_DESIGN.md`.

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

Use the dedicated runbook:

- `phala-deploy/UPDATE_RUNBOOK.md`

Minimal sequence:

1. Build/pin images:
   - `./phala-deploy/build-pin-image.sh`
   - `./phala-deploy/build-pin-mux-image.sh` (if mux changed)
2. Load rollout targets and deploy:
   - `set -a; source phala-deploy/.env.rollout-targets; set +a`
   - `./phala-deploy/cvm-rollout-targets.sh all --wait`
3. Generate pairing token and run a quick smoke check:
   - `./phala-deploy/mux-pair-token.sh telegram agent:main:main`

The new image pulls in the background. The old container keeps running until the new one is ready.

**Verification notes:**

- `phala deploy` is the reliable rollout path. `phala cvms logs` can lag, so confirm with a live version check via `cvm-exec` (for example: `./phala-deploy/cvm-exec 'openclaw --version'`).
- `rv-exec` with `CVM_SSH_HOST` is sufficient to verify the live container without exposing secrets.
- Full runbook: `phala-deploy/UPDATE_RUNBOOK.md`.

## Disaster recovery

If your CVM is destroyed (S3 mode only):

1. Create a new CVM with the same `MASTER_KEY` and S3 credentials
2. The entrypoint derives the same keys, mounts S3, and everything is restored
3. Config, agents, and memory are all recovered automatically
4. The gateway auth token is the same — existing clients reconnect without changes
5. The OpenClaw device identity is also the same — mux pairings remain stable as long as the mux DB is intact

## File reference

| File                     | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `Dockerfile`             | CVM image (Ubuntu 24.04 + Node 22 + rclone + Docker-in-Docker)        |
| `entrypoint.sh`          | Boot sequence: key derivation, S3 mount, SSH, Docker, gateway         |
| `docker-compose.yml`     | Compose file for `phala deploy`                                       |
| `mux-server-compose.yml` | Compose file for mux-server CVM deployment                            |
| `build-pin-image.sh`     | Rebuild tarball + image, push, and pin compose image digest           |
| `build-pin-mux-image.sh` | Rebuild mux image, push, and pin mux compose digest                   |
| `cvm-rollout.sh`         | Standardized multi-CVM deploy flow with `rv-exec` env materialization |
| `cvm-rollout-targets.sh` | Role-aware deploy wrapper with CVM role safety checks                 |
| `mux-pair-token.sh`      | Mint mux pairing token for a tenant OpenClaw instance (admin API)     |
| `UPDATE_RUNBOOK.md`      | Dedicated repeatable update runbook                                   |
| `secrets/.env`           | Legacy local env-file workflow (prefer `rv-exec --dotenv`)            |
| `cvm-ssh`                | Interactive SSH into the container                                    |
| `cvm-exec`               | Run a command in the container                                        |
| `cvm-scp`                | Copy files to/from the container                                      |
| `S3_STORAGE.md`          | Detailed S3 encryption documentation                                  |

## CVM environment notes

- The Ubuntu base image is minimal: install `unzip` (for bun), `tmux`, and use nodesource repo for Node 22 (default apt gives Node 12).
- Entrypoint starts SSH before dockerd — SSH is always available for debugging, even if dockerd fails.
- Backgrounding over non-interactive SSH is unreliable; use tmux inside the CVM.
- Docker uses static binaries from `download.docker.com/linux/static/stable/` (not `apt docker-ce`). Do **not** bind-mount Docker binaries from the CVM host (ELF interpreter mismatch: host `/lib/ld-linux-x86-64.so.2` vs container `/lib64/`).
- Dockerfile: `build-essential` is installed, used for `npm install`, then purged in the same `RUN` layer. Never split install and purge across layers.
- Auto-update is disabled in bootstrap config (`update.checkOnStart=false`); updates happen via Docker image rebuilds.

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
