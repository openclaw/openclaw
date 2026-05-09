#!/bin/sh
# Openclaw container entrypoint.
#
# Runs as root and stays as root for the workload. The upstream
# Dockerfile drops to the `node` user for defense-in-depth, but on
# Railway the persistent volume is mounted root-owned and chown
# inside the container is silently denied — leaving the gateway
# unable to read or write its state dir as `node`. Single-tenant
# Railway services already isolate the container from the host, so
# root-in-container is an acceptable trade. tini stays PID 1 for
# signal forwarding + zombie reaping.
#
# Also seeds gateway.controlUi.allowedOrigins from
# OPENCLAW_PUBLIC_ORIGIN so the browser-served Control UI is allowed
# to connect when the gateway is exposed on a public domain
# (Railway, Fly, etc.). Without this the browser shows
# "Browser origin not allowed" because the gateway only auto-seeds
# loopback origins when bind=auto.
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
mkdir -p "$STATE_DIR"

if [ -n "$OPENCLAW_PUBLIC_ORIGIN" ] || [ "$OPENCLAW_DISABLE_DEVICE_AUTH" = "1" ]; then
  CONFIG_PATH="$STATE_DIR/openclaw.json"
  # Merge (or create) gateway config idempotently. Uses python because
  # jq isn't installed in the upstream image.
  python3 - "$CONFIG_PATH" "${OPENCLAW_PUBLIC_ORIGIN:-}" "${OPENCLAW_DISABLE_DEVICE_AUTH:-0}" <<'PY' || true
import json, os, sys
config_path, public_origin, disable_dev_auth = sys.argv[1], sys.argv[2], sys.argv[3]
config = {}
if os.path.exists(config_path):
    try:
        with open(config_path) as f:
            config = json.load(f)
    except Exception:
        config = {}
config.setdefault("$schema", "https://openclaw.ai/config.json")
gw = config.setdefault("gateway", {})
ui = gw.setdefault("controlUi", {})
if public_origin:
    origins = ui.setdefault("allowedOrigins", [])
    for o in [public_origin, "http://localhost:18789", "http://127.0.0.1:18789"]:
        if o and o not in origins:
            origins.append(o)
if disable_dev_auth == "1":
    ui["dangerouslyDisableDeviceAuth"] = True
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
print(f"openclaw.json patched: origins={ui.get('allowedOrigins')} disableDeviceAuth={ui.get('dangerouslyDisableDeviceAuth', False)}", file=sys.stderr)
PY
fi

exec /usr/bin/tini -s -- "$@"
