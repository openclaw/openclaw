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
# Patches $OPENCLAW_STATE_DIR/openclaw.json at boot from env vars
# so a Railway-style "config-via-env" workflow stays viable without
# SSH'ing into the container. Idempotent: rerunning is a no-op.
#
# Env-driven config:
#   OPENCLAW_PUBLIC_ORIGIN          gateway.controlUi.allowedOrigins
#   OPENCLAW_DISABLE_DEVICE_AUTH    gateway.controlUi.dangerouslyDisableDeviceAuth
#   OPENCLAW_OLLAMA_MODEL           registers Ollama as an OpenAI-
#                                   compatible provider, sets it as
#                                   the default agent model. Key is
#                                   read from OPENAI_API_KEY at
#                                   runtime via Openclaw's env-ref
#                                   shape.
#   OPENCLAW_COMPACTION_RESERVE     agents.defaults.compaction
#                                   .reserveTokensFloor — bytes the
#                                   agent must keep free for compaction
#                                   to survive a long session. Default
#                                   20000 if unset (covers Kimi K2's
#                                   recommended floor; raise if you
#                                   still hit "context limit
#                                   exceeded — reset our conversation").
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
mkdir -p "$STATE_DIR"

# Patch is unconditional now: compaction reserve floor always applied
# (default 20k) so a fresh deployment doesn't crashloop the very first
# long chat. Other config blocks remain env-gated.
if true; then
  CONFIG_PATH="$STATE_DIR/openclaw.json"
  # Merge (or create) gateway config idempotently. Uses python because
  # jq isn't installed in the upstream image.
  python3 - "$CONFIG_PATH" \
    "${OPENCLAW_PUBLIC_ORIGIN:-}" \
    "${OPENCLAW_DISABLE_DEVICE_AUTH:-0}" \
    "${OPENCLAW_OLLAMA_MODEL:-}" \
    "${OPENCLAW_COMPACTION_RESERVE:-20000}" <<'PY' || true
import json, os, sys
config_path, public_origin, disable_dev_auth, ollama_model, compaction_reserve = sys.argv[1:6]
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
agents = config.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
try:
    reserve_tokens = int(compaction_reserve)
except ValueError:
    reserve_tokens = 20000
compaction = defaults.setdefault("compaction", {})
compaction["reserveTokensFloor"] = reserve_tokens
if ollama_model:
    models = config.setdefault("models", {})
    providers = models.setdefault("providers", {})
    providers["ollama"] = {
        "baseUrl": "https://ollama.com/v1",
        "apiKey": {"source": "env", "provider": "default", "id": "OPENAI_API_KEY"},
        "api": "openai-completions",
        "models": [
            {
                "id": ollama_model,
                "name": ollama_model,
                "reasoning": False,
                "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": 32000,
                "maxTokens": 8000,
            }
        ],
    }
    model_cfg = defaults.setdefault("model", {})
    model_cfg["primary"] = f"ollama/{ollama_model}"
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
print(
    "openclaw.json patched: "
    f"origins={ui.get('allowedOrigins')} "
    f"disableDeviceAuth={ui.get('dangerouslyDisableDeviceAuth', False)} "
    f"primaryModel={defaults.get('model', {}).get('primary')} "
    f"compactionReserve={compaction['reserveTokensFloor']}",
    file=sys.stderr,
)
PY
fi

exec /usr/bin/tini -s -- "$@"
