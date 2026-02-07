# Encrypted S3 Storage for CVM

The CVM can use S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, etc.) as its state backend. All data is encrypted client-side before upload using rclone's crypt overlay, so the storage provider never sees plaintext.

Without `S3_BUCKET` set, the entrypoint skips all S3 logic and uses a local Docker volume instead.

## Architecture

Two sync strategies, tried in order:

### FUSE mount (preferred)

```
/data/openclaw  (rclone FUSE mount — apps read/write normally)
  └── rclone crypt  (NaCl SecretBox encryption)
       └── S3 remote  (any S3-compatible provider)
```

If `/dev/fuse` is available, rclone mounts the encrypted S3 bucket directly as a filesystem. The VFS cache layer handles all syncing automatically:

- `--vfs-cache-mode writes` — writes are cached locally, reads go through cache
- `--vfs-write-back 5s` — local writes flush to S3 after 5 seconds idle
- `--dir-cache-time 30s` — directory listings cached for 30 seconds
- `--vfs-cache-max-size 500M` — local cache limited to 500MB

No background sync jobs, no SQLite workarounds. SQLite works directly on the mount because the VFS write cache keeps writes local until flushed.

### Sync fallback

If FUSE is unavailable, the entrypoint falls back to periodic `rclone copy`:

- On boot: restores SQLite files from S3 to local storage, then pulls remaining state to the Docker volume
- Every 60 seconds: pushes state dir changes and SQLite backups to S3
- SQLite `memory.db` files are kept on local storage (`/data/openclaw-local/sqlite/`) with symlinks from the agent directories
- Maximum data loss: 60 seconds of writes

## Key management

A single `MASTER_KEY` derives all cryptographic secrets via HKDF-SHA256:

```
MASTER_KEY (one secret to back up)
  ├── HKDF(info="rclone-crypt-password")  → rclone encryption password
  ├── HKDF(info="rclone-crypt-salt")      → rclone encryption salt
  └── HKDF(info="gateway-auth-token")     → gateway auth token
```

This means:

- **One secret** to manage, back up, and rotate
- Keys are deterministic — same `MASTER_KEY` always produces the same derived keys
- The gateway auth token is stable across container restarts (not random each boot)
- S3 credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are provider-issued and stay separate

You can also set `RCLONE_CRYPT_PASSWORD` directly (without `MASTER_KEY`) for manual control.

## How it works

### FUSE mount mode

1. **Derive keys**: if `MASTER_KEY` is set, derive crypt passwords and gateway token via HKDF
2. **Unmount Docker volume**: remove the pre-existing Docker volume mount at the state dir
3. **FUSE mount**: rclone mounts the encrypted S3 bucket at `/data/openclaw`
4. **Bootstrap**: if no config exists, create one with the derived gateway token
5. **Run**: the gateway starts and reads/writes the state dir normally
6. rclone VFS cache handles all syncing to S3 automatically

### Sync fallback mode

1. **Derive keys**: same as above
2. **Restore SQLite**: pull SQLite files from S3 to local storage
3. **Initial sync**: pull remaining state from S3 to the Docker volume
4. **Bootstrap**: create config if needed
5. **Run**: gateway starts
6. **Background sync**: every 60 seconds, push changes back to S3

## Environment variables

| Variable                 | Required     | Default          | Description                                               |
| ------------------------ | ------------ | ---------------- | --------------------------------------------------------- |
| `MASTER_KEY`             | Recommended  | —                | Master secret. Derives crypt passwords + gateway token.   |
| `S3_BUCKET`              | Yes (for S3) | —                | Bucket name. Presence enables S3 mode.                    |
| `S3_ENDPOINT`            | Yes (for S3) | —                | S3 endpoint URL                                           |
| `AWS_ACCESS_KEY_ID`      | Yes (for S3) | —                | S3 access key                                             |
| `AWS_SECRET_ACCESS_KEY`  | Yes (for S3) | —                | S3 secret key                                             |
| `S3_PROVIDER`            | No           | `Other`          | rclone provider hint (`Cloudflare`, `AWS`, `Minio`)       |
| `S3_PREFIX`              | No           | `openclaw-state` | Key prefix inside the bucket                              |
| `S3_REGION`              | No           | `us-east-1`      | S3 region                                                 |
| `RCLONE_CRYPT_PASSWORD`  | No           | derived          | Override derived crypt password (must be rclone-obscured) |
| `RCLONE_CRYPT_PASSWORD2` | No           | derived          | Override derived crypt salt (must be rclone-obscured)     |

## Setup

### 1. Create an S3 bucket

For Cloudflare R2:

- Dashboard > R2 > Create bucket
- Create an API token with **Object Read & Write** scoped to the bucket

### 2. Generate a master key

```sh
head -c 32 /dev/urandom | base64
```

Save this value securely. If you lose it, the encrypted data on S3 is unrecoverable.

### 3. Prepare deploy env vars

Preferred (vault-backed):

```sh
rv-exec --dotenv /tmp/deploy.env \
  MASTER_KEY REDPILL_API_KEY \
  S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
  -- bash -lc 'test -s /tmp/deploy.env && echo "deploy env ready: /tmp/deploy.env"'
```

Legacy fallback (local-only): save credentials to `phala-deploy/secrets/.env` (gitignored):

```env
MASTER_KEY=your-base64-master-key
REDPILL_API_KEY=your-redpill-api-key
S3_BUCKET=your-bucket
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_PROVIDER=Cloudflare
S3_REGION=auto
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

### 4. Deploy

For local testing:

```sh
docker build -f phala-deploy/Dockerfile -t openclaw-cvm:test .
docker run -d --name openclaw --privileged \
  --env-file /tmp/deploy.env \
  -e OPENCLAW_STATE_DIR=/data/openclaw \
  -e NODE_ENV=production \
  -p 18789:18789 \
  openclaw-cvm:test
```

For Phala Cloud, pass the env vars through the encrypted environment configuration (never put secrets in `docker-compose.yml`).

## Verification

Check the boot log for key derivation and mount:

```
Deriving keys from MASTER_KEY...
Keys derived (crypt password, crypt salt, gateway token).
S3 storage configured (bucket: ...), setting up rclone...
Attempting FUSE mount...
rclone FUSE mount ready at /data/openclaw
```

Check mount status:

```sh
# Inside the container
mount | grep fuse.rclone         # should show s3-crypt on /data/openclaw
ls /data/openclaw/                # should show openclaw.json, agents/, etc.
```

Check that S3 contents are encrypted:

```sh
rclone ls s3:your-bucket/openclaw-state/
# Filenames should be encrypted gibberish like "kh1v5oec8hqh01519qhuit8nc8"
```

## Disaster recovery

If the container is destroyed:

1. Create a new container with the same `MASTER_KEY` and S3 credentials
2. The entrypoint derives the same encryption keys and mounts S3
3. All config, agent data, and memory is restored automatically
4. The gateway auth token is the same (derived, not random)

In FUSE mount mode, there is no data loss — all writes are flushed to S3 within 5 seconds. In sync fallback mode, the maximum data loss is 60 seconds.

## Encryption details

rclone crypt uses:

- **NaCl SecretBox** (XSalsa20 + Poly1305) for file contents
- **EME** (ECB-Mix-ECB) wide-block encryption for filenames
- Standard filename encryption with encrypted directory names

Key derivation uses **HKDF-SHA256** (Node.js `crypto.hkdfSync`) with empty salt and purpose-specific info strings. Derived keys are 32 bytes, base64-encoded, then passed through `rclone obscure` for the crypt config.

The S3 provider sees only encrypted blobs with encrypted paths. Without the master key, the data is unrecoverable.
