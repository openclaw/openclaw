#!/bin/bash
# Blink Claw entrypoint — runs as root, prepares /data, seeds auth, drops to node user.
#
# What this does:
#   1. Creates /data directory tree on fresh Fly volumes (root-owned initially).
#   2. Writes default /data/openclaw.json if missing.
#   3. Seeds /data/agents/main/agent/auth-profiles.json with the Blink provider
#      api_key credential (required by upstream v2026.4.15+ auth resolver).
#      Rewritten every boot so BLINK_API_KEY rotations propagate automatically.
#   4. Sanitizes /data/agents/main/agent/models.json so the blink provider
#      baseUrl is always exactly https://core.blink.new/api/v1/ai. Upstream
#      v2026.4.15's openai-completions provider normalization writes an extra
#      trailing "/v1" on first persistence (observed 2026-04-19: produced
#      https://core.blink.new/api/v1/ai/v1), and #67893 then preserves that
#      corrupted baseUrl forever across restarts. This sanitize step breaks
#      the lock — it rewrites the blink baseUrl on every boot regardless of
#      what got persisted, so every new LLM call hits the correct route.
#   5. Sources /data/.env (agent-managed secrets via `blink secrets set`).
#   6. Exports OPENCLAW_NO_RESPAWN=true so the gateway does not daemonize
#      itself (Fly init supervises the process, daemonization breaks this).
#   7. Drops privileges to the `node` user and exec's the gateway command.
set -eu

STATE_DIR="/data"
AGENT_DIR="${STATE_DIR}/agents/main/agent"
AUTH_FILE="${AGENT_DIR}/auth-profiles.json"
MODELS_FILE="${AGENT_DIR}/models.json"
CONFIG_FILE="${STATE_DIR}/openclaw.json"
ENV_FILE="${STATE_DIR}/.env"
# Canonical blink gateway base — keep in sync with getBlinkGatewayBaseUrl() in
# openclaw/src/providers/blink-shared.ts. Trim any trailing slash on BLINK_APIS_URL
# before composing so a stray "https://core.blink.new/" doesn't produce "//api/v1/ai".
_BLINK_APIS_URL_RAW="${BLINK_APIS_URL:-https://core.blink.new}"
BLINK_EXPECTED_BASE_URL="${_BLINK_APIS_URL_RAW%/}/api/v1/ai"
unset _BLINK_APIS_URL_RAW

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

# Sanitize models.json helper — writes a corrected file + SIGHUPs the gateway
# if the blink.baseUrl is not exactly the expected value. Exit status:
#   0 = file present and checked (either already ok or rewritten)
#   2 = file not present (caller should retry later)
#   other = hard error
# Runs as root; all writes are atomic (tempfile + rename) and mode 600 owned by node.
sanitize_models_json() {
  python3 - "${MODELS_FILE}" "${BLINK_EXPECTED_BASE_URL}" <<'PY'
import json, os, sys, tempfile, subprocess
path, expected = sys.argv[1], sys.argv[2]
if not os.path.exists(path):
    sys.exit(2)
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
blink = (data.get("providers") or {}).get("blink")
if not isinstance(blink, dict):
    sys.exit(0)
current = blink.get("baseUrl")
if current == expected:
    sys.exit(0)
blink["baseUrl"] = expected
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2); f.write("\n")
    os.chmod(tmp, 0o600)
    try:
        import pwd
        os.chown(tmp, pwd.getpwnam("node").pw_uid, pwd.getpwnam("node").pw_gid)
    except Exception:
        pass
    os.replace(tmp, path)
except Exception:
    if os.path.exists(tmp): os.unlink(tmp)
    raise
print(f"[entrypoint] blink baseUrl repaired: {current!r} -> {expected!r}", flush=True)
# SIGHUP the live gateway if running, so it reloads models.json immediately.
# openclaw-gateway is 16 chars which exceeds pgrep's 15-char default limit —
# use ps+awk instead.
try:
    out = subprocess.check_output(["ps", "-e", "-o", "pid=,comm="], text=True)
    for line in out.splitlines():
        pid, comm = line.strip().split(None, 1)
        if comm == "openclaw-gateway":
            os.kill(int(pid), 1)  # SIGHUP
            print(f"[entrypoint] sent SIGHUP to openclaw-gateway pid {pid}", flush=True)
            break
except Exception:
    pass
PY
}

# (1) Sanitize now — covers the steady-state case where the container restarted
# and models.json is already on disk (most agents).
sanitize_models_json 2>/dev/null || true

# (2) Background watcher — covers the FIRST-BOOT case: on a fresh volume
# models.json does not yet exist when the entrypoint runs. The gateway lazy-
# writes it during startup with the upstream-corrupted baseUrl (/api/v1/ai/v1).
# We poll for ~60s and sanitize as soon as the file appears, then exit.
# Runs disowned so `exec gosu node` below replaces the shell cleanly; the
# watcher is adopted by init (PID 1) and survives the exec.
(
  for _ in $(seq 1 30); do
    sleep 2
    if sanitize_models_json 2>/dev/null; then
      # Exit 0 means file was present and checked. We've done our job.
      exit 0
    fi
  done
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

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
