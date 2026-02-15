#!/bin/sh
set -e

# Persistent storage root (S3 mount or Docker volume)
DATA_DIR="/data"
SQLITE_LOCAL_DIR="/data-local/sqlite"

# --- Derive keys from MASTER_KEY via HKDF-SHA256 ---
# One master secret derives: rclone crypt password, crypt salt, gateway auth token.
# S3 credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) are provider-issued and stay separate.
if [ -n "$MASTER_KEY" ]; then
  echo "Deriving keys from MASTER_KEY..."
  derive_key() {
    node -e "
      const c = require('crypto');
      const key = c.hkdfSync('sha256', process.argv[1], '', process.argv[2], 32);
      process.stdout.write(Buffer.from(key).toString('base64'));
    " "$MASTER_KEY" "$1"
  }

  GATEWAY_AUTH_TOKEN=$(derive_key gateway-auth-token | tr -d '/+=' | head -c 32)
  export GATEWAY_AUTH_TOKEN

  # Derive rclone keys only if rclone is installed
  if command -v rclone >/dev/null 2>&1; then
    RCLONE_CRYPT_PASSWORD=$(rclone obscure "$(derive_key rclone-crypt-password)")
    RCLONE_CRYPT_PASSWORD2=$(rclone obscure "$(derive_key rclone-crypt-salt)")
    export RCLONE_CRYPT_PASSWORD RCLONE_CRYPT_PASSWORD2
    echo "Keys derived (gateway token, crypt password, crypt salt)."
  else
    echo "Keys derived (gateway token)."
  fi
fi

# --- Encrypted S3 storage via rclone crypt + mount ---
if [ -n "$S3_BUCKET" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "Error: S3_BUCKET is set but rclone is not installed. Use the full image for S3 support."
    mkdir -p "$DATA_DIR"
  else
    echo "S3 storage configured (bucket: $S3_BUCKET), setting up rclone..."

    S3_PREFIX="${S3_PREFIX:-openclaw-data}"
    S3_REGION="${S3_REGION:-us-east-1}"

    # Generate rclone config from env vars (write to temp location, not ~/.config)
    mkdir -p /tmp/rclone
    cat > /tmp/rclone/rclone.conf <<RCONF
[s3]
type = s3
provider = ${S3_PROVIDER:-Other}
env_auth = true
endpoint = ${S3_ENDPOINT}
region = ${S3_REGION}
no_check_bucket = true

[s3-crypt]
type = crypt
remote = s3:${S3_BUCKET}/${S3_PREFIX}
password = ${RCLONE_CRYPT_PASSWORD}
password2 = ${RCLONE_CRYPT_PASSWORD2:-}
filename_encryption = standard
directory_name_encryption = true
RCONF
    export RCLONE_CONFIG=/tmp/rclone/rclone.conf

    # Try FUSE mount first; fall back to rclone sync if FUSE unavailable
    mkdir -p "$DATA_DIR"
    S3_MODE=""

    if [ -e /dev/fuse ]; then
      echo "Attempting FUSE mount..."
      # Unmount Docker volume if present (FUSE can't overlay on existing mounts)
      if mountpoint -q "$DATA_DIR" 2>/dev/null; then
        echo "Unmounting existing volume at $DATA_DIR..."
        umount "$DATA_DIR" 2>/dev/null || true
      fi
      rclone mount s3-crypt: "$DATA_DIR" \
        --config "$RCLONE_CONFIG" \
        --vfs-cache-mode writes \
        --vfs-write-back 5s \
        --dir-cache-time 30s \
        --vfs-cache-max-size 500M \
        --allow-other \
        --daemon 2>&1 || true

      # Wait for FUSE mount (up to 10s) — check for fuse.rclone specifically,
      # not just mountpoint (Docker volume is already a mountpoint)
      MOUNT_WAIT=0
      while ! mount | grep -q "on $DATA_DIR type fuse.rclone"; do
        sleep 0.5
        MOUNT_WAIT=$((MOUNT_WAIT + 1))
        if [ $MOUNT_WAIT -ge 20 ]; then
          break
        fi
      done

      if mount | grep -q "on $DATA_DIR type fuse.rclone"; then
        S3_MODE="mount"
        echo "rclone FUSE mount ready at $DATA_DIR"
      else
        echo "FUSE mount failed, falling back to sync mode."
      fi
    fi

    # Fallback: sync mode (pull from S3, periodic push back)
    if [ -z "$S3_MODE" ]; then
      S3_MODE="sync"
      echo "Using rclone sync mode (no FUSE)."
      # Restore SQLite files to local storage (can't run on FUSE, use symlinks instead)
      mkdir -p "$SQLITE_LOCAL_DIR"
      echo "Restoring SQLite files from S3..."
      rclone copy s3-crypt:sqlite/ "$SQLITE_LOCAL_DIR/" --config "$RCLONE_CONFIG" 2>/dev/null || true
      # Pull remaining state
      rclone copy s3-crypt: "$DATA_DIR/" --config "$RCLONE_CONFIG" --exclude "sqlite/**" 2>&1 || true
      echo "Initial sync from S3 complete."
    fi

    # In sync mode, run periodic background jobs to push changes to S3.
    # In mount mode, rclone VFS cache handles syncing automatically.
    if [ "$S3_MODE" = "sync" ]; then
      (
        while true; do
          sleep 60
          rclone copy "$SQLITE_LOCAL_DIR/" s3-crypt:sqlite/ --config "$RCLONE_CONFIG" 2>/dev/null || true
          rclone copy "$DATA_DIR/" s3-crypt: --config "$RCLONE_CONFIG" --exclude "sqlite/**" 2>/dev/null || true
        done
      ) &
      echo "Background sync started (PID $!)"
    fi
  fi
else
  mkdir -p "$DATA_DIR"
fi

# --- Set up home directory symlinks ---
# ~/.openclaw → /data/openclaw (state dir)
# ~/.config → /data/.config (plugin configs)
ensure_symlink_dir() {
  target="$1"
  link="$2"

  mkdir -p "$target"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    if [ "$(ls -A "$link" 2>/dev/null)" ]; then
      find "$link" -mindepth 1 -maxdepth 1 -exec mv -t "$target" {} + || true
    fi
    rmdir "$link" 2>/dev/null || rm -rf "$link"
  fi
  ln -sfn "$target" "$link"
}

ensure_symlink_dir "$DATA_DIR/openclaw" /root/.openclaw
ensure_symlink_dir "$DATA_DIR/.config" /root/.config
echo "Home symlinks created (~/.openclaw, ~/.config → $DATA_DIR)"

# Bootstrap config from OPENCLAW_CONFIG_B64 (sent by clawdi control plane)
CONFIG_FILE="/root/.openclaw/openclaw.json"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -n "$OPENCLAW_CONFIG_B64" ]; then
    echo "Decoding config from OPENCLAW_CONFIG_B64..."
    printf '%s' "$OPENCLAW_CONFIG_B64" | base64 -d > "$CONFIG_FILE"
    echo "Config written to $CONFIG_FILE"
  else
    echo "Warning: No config file and no OPENCLAW_CONFIG_B64 set. Gateway may fail."
  fi
fi

# --- SQLite symlink helper ---
# Called after gateway creates agent dirs to redirect memory.db to local storage
setup_sqlite_symlinks() {
  if [ -z "$S3_BUCKET" ]; then return; fi
  for agent_dir in /root/.openclaw/agents/*/; do
    [ -d "$agent_dir" ] || continue
    agent_id=$(basename "$agent_dir")
    local_db="$SQLITE_LOCAL_DIR/${agent_id}-memory.db"
    target_db="${agent_dir}memory.db"
    # If real file exists on mount, move it to local
    if [ -f "$target_db" ] && [ ! -L "$target_db" ]; then
      cp "$target_db" "$local_db" 2>/dev/null || true
      rm -f "$target_db"
    fi
    # Create symlink if not already there
    if [ ! -L "$target_db" ]; then
      # Ensure local db exists (may have been restored from S3)
      touch "$local_db"
      ln -sf "$local_db" "$target_db"
    fi
  done
}

# Start SSH daemon if installed (full image only)
if [ -x /usr/sbin/sshd ]; then
  mkdir -p /var/run/sshd /root/.ssh
  chmod 700 /root/.ssh 2>/dev/null || true
  chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true
  /usr/sbin/sshd
  echo "SSH daemon started."
fi

# Clean up stale PID files from previous container restarts
rm -f /var/run/docker.pid /var/run/containerd/containerd.pid

# Start Docker daemon in background (best-effort, not critical for gateway)
dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs &
DOCKERD_PID=$!

echo "Waiting for Docker daemon..."
DOCKER_WAIT=0
while ! docker info >/dev/null 2>&1; do
  sleep 1
  DOCKER_WAIT=$((DOCKER_WAIT + 1))
  if [ $DOCKER_WAIT -ge 30 ]; then
    echo "Warning: Docker daemon not ready after 30s, continuing without it."
    break
  fi
  # Check if dockerd process died
  if ! kill -0 $DOCKERD_PID 2>/dev/null; then
    echo "Warning: Docker daemon exited, continuing without it."
    break
  fi
done
if docker info >/dev/null 2>&1; then
  echo "Docker daemon ready."
fi

# Set up SQLite symlinks — only needed in sync mode (no VFS cache).
# In FUSE mount mode, --vfs-cache-mode writes handles SQLite locally.
if [ "$S3_MODE" = "sync" ]; then
  setup_sqlite_symlinks
  (
    while true; do
      sleep 30
      setup_sqlite_symlinks
    done
  ) &
fi

# Gateway supervision (keep container alive for SSH even if gateway fails).
GATEWAY_RESTART_DELAY="${OPENCLAW_GATEWAY_RESTART_DELAY:-5}"
GATEWAY_RESTART_MAX_DELAY="${OPENCLAW_GATEWAY_RESTART_MAX_DELAY:-60}"
GATEWAY_RESET_AFTER="${OPENCLAW_GATEWAY_RESET_AFTER:-600}"

shutdown() {
  echo "Shutting down..."
  if [ -n "${GATEWAY_PID:-}" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -n "${DOCKERD_PID:-}" ] && kill -0 "$DOCKERD_PID" 2>/dev/null; then
    kill "$DOCKERD_PID" 2>/dev/null || true
  fi
  exit 0
}

trap shutdown INT TERM

backoff="$GATEWAY_RESTART_DELAY"
set +e
while true; do
  echo "Starting OpenClaw gateway..."
  start_time=$(date +%s)
  openclaw gateway run --bind lan --port 18789 --force &
  GATEWAY_PID=$!
  wait "$GATEWAY_PID"
  exit_code=$?
  end_time=$(date +%s)
  runtime=$((end_time - start_time))
  echo "Gateway exited with code ${exit_code}."

  if [ "$runtime" -ge "$GATEWAY_RESET_AFTER" ]; then
    backoff="$GATEWAY_RESTART_DELAY"
    echo "Gateway ran for ${runtime}s; resetting backoff to ${backoff}s."
  else
    if [ "$backoff" -lt 1 ]; then
      backoff=1
    fi
    if [ "$backoff" -lt "$GATEWAY_RESTART_MAX_DELAY" ]; then
      backoff=$((backoff * 2))
      if [ "$backoff" -gt "$GATEWAY_RESTART_MAX_DELAY" ]; then
        backoff="$GATEWAY_RESTART_MAX_DELAY"
      fi
    fi
  fi

  echo "Restarting gateway in ${backoff}s..."
  sleep "$backoff"
done
