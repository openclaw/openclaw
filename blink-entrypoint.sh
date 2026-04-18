#!/bin/bash
# Blink Claw entrypoint — runs as root, prepares /data, seeds auth, drops to node user.
#
# What this does:
#   1. Creates /data directory tree on fresh Fly volumes (root-owned initially).
#   2. Writes default /data/openclaw.json if missing.
#   3. Seeds /data/agents/main/agent/auth-profiles.json with the Blink provider
#      api_key credential (required by upstream v2026.4.15+ auth resolver).
#      Rewritten every boot so BLINK_API_KEY rotations propagate automatically.
#   4. Sources /data/.env (agent-managed secrets via `blink secrets set`).
#   5. Exports OPENCLAW_NO_RESPAWN=true so the gateway does not daemonize
#      itself (Fly init supervises the process, daemonization breaks this).
#   6. Drops privileges to the `node` user and exec's the gateway command.
set -eu

STATE_DIR="/data"
AGENT_DIR="${STATE_DIR}/agents/main/agent"
AUTH_FILE="${AGENT_DIR}/auth-profiles.json"
CONFIG_FILE="${STATE_DIR}/openclaw.json"
ENV_FILE="${STATE_DIR}/.env"

# Fresh-volume setup: create directory tree and default config.
if [ "$(stat -c %U "${STATE_DIR}" 2>/dev/null || echo root)" != "node" ]; then
  mkdir -p "${STATE_DIR}/workspace" "${AGENT_DIR}" "${STATE_DIR}/agents/main/sessions" \
           "${STATE_DIR}/scripts" "${STATE_DIR}/npm-global"
  if [ ! -f "${CONFIG_FILE}" ]; then
    echo '{"agents":{"defaults":{"workspace":"/data/workspace"}},"browser":{"noSandbox":true},"gateway":{"auth":{"mode":"token"}}}' > "${CONFIG_FILE}"
  fi
  chown -R node:node "${STATE_DIR}"
fi

# Ensure agent dir always exists (for machines with pre-existing volumes that
# never had this subdirectory — OpenClaw v2026.4.15 requires it).
mkdir -p "${AGENT_DIR}"
chown node:node "${AGENT_DIR}"

# Seed auth-profiles.json with the Blink provider credential.
# This is required by upstream v2026.4.15+ where the gateway reads API keys
# from this persisted auth store (not static provider config). We always
# rewrite on boot so BLINK_API_KEY env-var rotations propagate.
if [ -n "${BLINK_API_KEY:-}" ]; then
  # Write atomically via a temp file so concurrent readers never see a partial
  # JSON document. chmod 600 so the api_key plaintext is only readable by node.
  TMP_AUTH="${AUTH_FILE}.tmp.$$"
  cat > "${TMP_AUTH}" <<EOF
{
  "version": 1,
  "profiles": {
    "blink:default": {
      "type": "api_key",
      "provider": "blink",
      "key": "${BLINK_API_KEY}"
    }
  }
}
EOF
  chmod 600 "${TMP_AUTH}"
  chown node:node "${TMP_AUTH}"
  mv -f "${TMP_AUTH}" "${AUTH_FILE}"
fi

# Remove legacy secrets.providers.blink exec provider from openclaw.json.
# The old get-secret.sh exec provider curls blink.new at gateway startup,
# which hangs for 30s+ and blocks the entire boot on v2026.4.15+.
# Blink API key is resolved via env var mapping now — no exec needed.
if [ -f "${CONFIG_FILE}" ] && python3 -c "import json,sys; d=json.load(open('${CONFIG_FILE}')); sys.exit(0 if 'secrets' in d else 1)" 2>/dev/null; then
  python3 -c "
import json
with open('${CONFIG_FILE}') as f: d = json.load(f)
if 'secrets' in d: del d['secrets']
with open('${CONFIG_FILE}', 'w') as f: json.dump(d, f, indent=2)
" 2>/dev/null
fi

# Source agent secrets (set via `blink secrets set` → /data/.env).
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

# Never let the gateway daemonize — Fly init supervises this process.
export OPENCLAW_NO_RESPAWN=true

# Drop privileges to node and exec the gateway command.
exec gosu node "$@"
