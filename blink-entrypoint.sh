#!/bin/bash
# Blink Claw entrypoint — runs as root, prepares /data, seeds auth, drops to node user.
#
# What this does:
#   1. Creates /data directory tree on fresh Fly volumes (root-owned initially).
#   2. Writes default /data/openclaw.json if missing.
#   3. Seeds /data/agents/main/agent/auth-profiles.json with the Blink provider
#      api_key credential (required by upstream v2026.4.15+ auth resolver).
#      Rewritten every boot so BLINK_API_KEY rotations propagate automatically.
#   4. Sanitizes EVERY /data/agents/*/agent/models.json so the blink provider
#      baseUrl is always exactly https://core.blink.new/api/v1/ai. Upstream
#      v2026.4.15's openai-completions provider normalization writes an extra
#      trailing "/v1" on first persistence (observed 2026-04-19: produced
#      https://core.blink.new/api/v1/ai/v1), and #67893 then preserves that
#      corrupted baseUrl forever across restarts. This sanitize step breaks
#      the lock — it rewrites the blink baseUrl on every boot regardless of
#      what got persisted, so every new LLM call hits the correct route.
#
#      A persistent background watcher also re-scans every 5 s to cover:
#        - fresh-volume first-boot race (gateway lazy-writes > 60 s after boot),
#        - sub-agent creation triggered by non-default sessionKeys (e.g.
#          `agent:foo:foo` → /data/agents/foo/agent/models.json).
#      We deliberately do NOT SIGHUP the gateway on repair: on v2026.4.15 the
#      Node process does not catch SIGHUP and exits, which Fly treats as a
#      stop request → machine reboot mid-chat. Rewriting the file alone is
#      sufficient because the gateway reads the blink provider config fresh
#      per LLM request, so the next chat picks up the repaired baseUrl.
#   5. Sources /data/.env (agent-managed secrets via `blink secrets set`).
#   6. Exports OPENCLAW_NO_RESPAWN=true so the gateway does not daemonize
#      itself (Fly init supervises the process, daemonization breaks this).
#   7. Drops privileges to the `node` user and exec's the gateway command.
set -eu

STATE_DIR="/data"
AGENTS_ROOT="${STATE_DIR}/agents"
AGENT_DIR="${AGENTS_ROOT}/main/agent"
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

# Pool mode: overwrite config with skeleton ONLY if not yet adopted.
# The claim flow writes /data/.adopted after writing the real openclaw.json.
# Without this guard, every restart clobbers the user's config with the skeleton.
if [ "${BLINK_POOL_MODE:-}" = "true" ] && [ ! -f "${STATE_DIR}/.adopted" ]; then
  rm -f "${STATE_DIR}/logs/config-health.json" "${CONFIG_FILE}.bak"
  cat > "${CONFIG_FILE}" <<'POOL_SKELETON'
{"agents":{"defaults":{"workspace":"/data/workspace"}},"plugins":{"slots":{"memory":"none"}},"gateway":{"auth":{"mode":"token"},"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true},"http":{"endpoints":{"chatCompletions":{"enabled":true}}}},"browser":{"headless":true,"noSandbox":true,"profiles":{"user":{"driver":"openclaw","cdpPort":18800,"color":"#00AA00"}}},"session":{"maintenance":{"mode":"enforce","pruneAfter":"30d","maxEntries":200}}}
POOL_SKELETON
  chown node:node "${CONFIG_FILE}"
fi

# Ensure agent dir always exists (for machines with pre-existing volumes that
# never had this subdirectory — OpenClaw v2026.4.15 requires it).
mkdir -p "${AGENT_DIR}"
chown node:node "${AGENT_DIR}"

# Source agent secrets (set via `blink secrets set` → /data/.env).
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

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

# Sanitize models.json helper — scans ALL agent subdirectories under
# /data/agents/*/agent/models.json (not just main/), writes a corrected file +
# SIGHUPs the gateway if any blink.baseUrl is not exactly the expected value.
#
# Why scan all agents, not just main/:
#   OpenClaw creates a separate agent subdirectory per sessionKey prefix (e.g.
#   `agent:verify:verify` → /data/agents/verify/agent/). Each gets its OWN
#   models.json, and each is written with the upstream-corrupted /api/v1/ai/v1
#   baseUrl on first persistence. If we only sanitize main/, any non-default
#   sessionKey hits 404 "Route not found" → agent run error=model_not_found.
#
# Exit status:
#   0 = at least one matching file was found and checked
#   2 = no matching file found (caller should retry later)
sanitize_models_json() {
  python3 - "${AGENTS_ROOT}" "${BLINK_EXPECTED_BASE_URL}" <<'PY'
import json, os, sys, glob, tempfile
agents_root, expected = sys.argv[1], sys.argv[2]
pattern = os.path.join(agents_root, "*", "agent", "models.json")
paths = glob.glob(pattern)
if not paths:
    sys.exit(2)

repaired_any = False
for path in paths:
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        continue
    blink = (data.get("providers") or {}).get("blink")
    if not isinstance(blink, dict):
        continue
    current = blink.get("baseUrl")
    if current == expected:
        continue
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
        continue
    print(f"[entrypoint] blink baseUrl repaired in {path}: {current!r} -> {expected!r}", flush=True)
    repaired_any = True

# Do NOT SIGHUP the gateway. On upstream v2026.4.15 SIGHUP is not caught by
# the Node process — it exits with signal=SIGHUP, Fly's init supervisor treats
# that as a requested stop and reboots the machine. Empirically verified
# 2026-04-20: rewriting models.json alone is sufficient; the gateway reads the
# blink provider config fresh per LLM request, so the next chat picks up the
# corrected baseUrl without any process-level signal.
PY
}

# (1) Sanitize now — covers the steady-state case where the container restarted
# and models.json files are already on disk (most agents).
sanitize_models_json 2>/dev/null || true

# (2) Persistent background watcher — runs for the entire lifetime of the
# machine. Re-scans every 2 s (matches the old poll cadence) and heals any
# corrupted blink.baseUrl in place. Covers three cases the old 60-second-only
# watcher missed:
#   a) First-boot: gateway lazy-writes main/models.json > 60 s after start
#      (rare but observed on slow cold starts).
#   b) Sub-agent creation: a sessionKey other than `agent:main:main` creates
#      /data/agents/<name>/agent/models.json on first use, which upstream
#      normalization writes with the corrupted /api/v1/ai/v1 baseUrl.
#   c) Upstream re-persistence: any future OpenClaw upgrade that re-runs the
#      normalization would re-corrupt the file; this watcher repairs it on
#      the next 2 s tick before any subsequent LLM call.
# The race window for a freshly-created sub-agent is at most 2 s — the first
# LLM call may still 404 if it fires in that narrow gap, but the rewrite
# is in place before the user can retry, and the web UI's always-warm
# main/ sessionKey is sanitized by the on-boot pass above.
# Runs disowned so `exec gosu node` below replaces the shell cleanly; the
# watcher is adopted by init (PID 1) and survives the exec.
(
  while true; do
    sleep 2
    sanitize_models_json 2>/dev/null || true
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

# Never let the gateway daemonize — Fly init supervises this process.
export OPENCLAW_NO_RESPAWN=true

# Drop privileges to node and exec the gateway command.
exec gosu node "$@"
