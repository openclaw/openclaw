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
#   OPENCLAW_TRUSTED_PROXIES        gateway.trustedProxies — comma-separated
#                                   list of IPs/CIDRs whose X-Forwarded-For
#                                   headers we honor. Default
#                                   100.64.0.0/10 (Tailscale CGNAT range,
#                                   which is what Railway's edge proxy
#                                   uses). Without this set, the gateway
#                                   logs "Proxy headers detected from
#                                   untrusted address" on every WS
#                                   connection and refuses to treat the
#                                   webchat client as local — webchat
#                                   handshakes then close 1008 → browser
#                                   sees code=1006 and chat is broken.
#   OPENCLAW_OLLAMA_MODEL           comma-separated Ollama model ids.
#                                   First entry becomes the default
#                                   (agents.defaults.model.primary);
#                                   every entry is registered in
#                                   models.providers.ollama.models[]
#                                   so the operator can swap between
#                                   them in the Control UI. Auth key
#                                   is read from OPENAI_API_KEY via
#                                   Openclaw's env-ref shape.
#                                   Single-model and multi-model
#                                   shapes both accepted, e.g.:
#                                     OPENCLAW_OLLAMA_MODEL=kimi-k2.6:cloud
#                                     OPENCLAW_OLLAMA_MODEL=kimi-k2.6:cloud,gpt-oss:120b,qwen3-coder:480b
#   OPENCLAW_COMPACTION_RESERVE     agents.defaults.compaction
#                                   .reserveTokensFloor — bytes the
#                                   agent must keep free for compaction
#                                   to survive a long session. Default
#                                   20000 if unset (covers Kimi K2's
#                                   recommended floor; raise if you
#                                   still hit "context limit
#                                   exceeded — reset our conversation").
#   OPENCLAW_OLLAMA_CONTEXT_WINDOW  models.providers.ollama.models[0]
#                                   .contextWindow — total token
#                                   budget. Default 128000 (Kimi K2,
#                                   most modern Ollama Cloud models).
#                                   gpt-oss:120b also 128K; deepseek
#                                   v3.1 supports 128K too. Lower
#                                   for older / smaller models if
#                                   the API rejects the value.
#   OPENCLAW_OLLAMA_MAX_TOKENS      output token cap per turn. Default
#                                   8000.
#   OPENCLAW_PROVIDER_BASE_URL      Override the OpenAI-compatible
#                                   provider base URL. Default
#                                   https://ollama.com/v1 (Ollama
#                                   Cloud). Set to e.g.
#                                   https://api.featherless.ai/v1
#                                   for Featherless, or
#                                   https://openrouter.ai/api/v1
#                                   for OpenRouter, etc. Auth still
#                                   flows through OPENAI_API_KEY.
#                                   Provider key in the config stays
#                                   "ollama" for stability across
#                                   redeploys, but the actual HTTP
#                                   target is whatever URL you set.
#                                   This legacy path is kept for
#                                   backwards compatibility; new
#                                   deployments should use the
#                                   first-class FEATHERLESS_API_KEY
#                                   path below instead.
#   FEATHERLESS_API_KEY             Featherless.ai API key. When set,
#                                   registers a real models.providers
#                                   .featherless block (separate from
#                                   the ollama legacy alias) so the
#                                   operator can route to featherless
#                                   models by their canonical id
#                                   (e.g. featherless/moonshotai/Kimi-K2-Instruct-0905)
#                                   in the Control UI without losing
#                                   ollama as a co-installed option.
#                                   Models are also auto-allowlisted
#                                   in agents.defaults.model.fallbacks
#                                   so the main agent can route to
#                                   them.
#   FEATHERLESS_MODELS              Comma-separated featherless model
#                                   ids to register. Default:
#                                     moonshotai/Kimi-K2-Instruct-0905,
#                                     deepseek-ai/DeepSeek-V3.1-Terminus,
#                                     meta-llama/Meta-Llama-3.1-70B-Instruct,
#                                     zai-org/GLM-4.7,
#                                     Qwen/QwQ-32B
#                                   Verify ids against your featherless
#                                   plan at https://featherless.ai/models
#                                   before changing.
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
    "${OPENCLAW_COMPACTION_RESERVE:-20000}" \
    "${OPENCLAW_OLLAMA_CONTEXT_WINDOW:-128000}" \
    "${OPENCLAW_OLLAMA_MAX_TOKENS:-8000}" \
    "${OPENCLAW_PROVIDER_BASE_URL:-https://ollama.com/v1}" \
    "${OPENCLAW_TRUSTED_PROXIES:-100.64.0.0/10}" \
    "${FEATHERLESS_API_KEY:-}" \
    "${FEATHERLESS_MODELS:-moonshotai/Kimi-K2-Instruct-0905,deepseek-ai/DeepSeek-V3.1-Terminus,meta-llama/Meta-Llama-3.1-70B-Instruct,zai-org/GLM-4.7,Qwen/QwQ-32B}" <<'PY' || true
import json, os, sys
(
    config_path, public_origin, disable_dev_auth, ollama_model,
    compaction_reserve, ollama_ctx, ollama_max, provider_base_url,
    trusted_proxies, featherless_api_key, featherless_models,
) = sys.argv[1:12]
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
# trustedProxies: array of IP/CIDR strings whose X-Forwarded-For we trust.
# Without this set, the gateway flags every WS connection from Railway's
# edge proxy as untrusted and webchat handshakes close 1008.
proxy_list = [p.strip() for p in trusted_proxies.split(",") if p.strip()]
if proxy_list:
    gw["trustedProxies"] = proxy_list
agents = config.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
try:
    reserve_tokens = int(compaction_reserve)
except ValueError:
    reserve_tokens = 20000
compaction = defaults.setdefault("compaction", {})
compaction["reserveTokensFloor"] = reserve_tokens
if ollama_model:
    try:
        ctx_window = int(ollama_ctx)
    except ValueError:
        ctx_window = 128000
    try:
        max_tokens = int(ollama_max)
    except ValueError:
        max_tokens = 8000
    # Comma-separated list. First entry becomes the default; every
    # entry is registered as an available model so the operator can
    # swap in the Control UI without redeploying. Whitespace and
    # empty entries are ignored.
    model_ids = [m.strip() for m in ollama_model.split(",") if m.strip()]
    models = config.setdefault("models", {})
    providers = models.setdefault("providers", {})
    providers["ollama"] = {
        "baseUrl": provider_base_url or "https://ollama.com/v1",
        "apiKey": {"source": "env", "provider": "default", "id": "OPENAI_API_KEY"},
        "api": "openai-completions",
        "models": [
            {
                "id": mid,
                "name": mid,
                "reasoning": False,
                "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": ctx_window,
                "maxTokens": max_tokens,
            }
            for mid in model_ids
        ],
    }
    if model_ids:
        model_cfg = defaults.setdefault("model", {})
        model_cfg["primary"] = f"ollama/{model_ids[0]}"
# Featherless.ai as a first-class provider (separate from the ollama
# legacy alias). When FEATHERLESS_API_KEY is set, register the provider
# block, materialize the configured model list, and auto-allowlist each
# entry in agents.defaults so the main agent can actually route to them.
if featherless_api_key:
    feather_ids = [m.strip() for m in featherless_models.split(",") if m.strip()]
    models = config.setdefault("models", {})
    providers = models.setdefault("providers", {})
    providers["featherless"] = {
        "baseUrl": "https://api.featherless.ai/v1",
        "apiKey": {"source": "env", "provider": "default", "id": "FEATHERLESS_API_KEY"},
        "api": "openai-completions",
        "models": [{"id": mid, "name": mid} for mid in feather_ids],
    }
    if feather_ids:
        model_cfg = defaults.setdefault("model", {})
        fallbacks = model_cfg.setdefault("fallbacks", [])
        models_allowlist = defaults.setdefault("models", {})
        for mid in feather_ids:
            qualified = f"featherless/{mid}"
            if qualified not in fallbacks:
                fallbacks.append(qualified)
            models_allowlist.setdefault(qualified, {})
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
_provider_block = (
    config.get("models", {}).get("providers", {}).get("ollama", {})
)
_provider_models = _provider_block.get("models", [])
_ctx = _provider_models[0].get("contextWindow") if _provider_models else None
_max = _provider_models[0].get("maxTokens") if _provider_models else None
_featherless_block = (
    config.get("models", {}).get("providers", {}).get("featherless", {})
)
_featherless_count = len(_featherless_block.get("models", []))
print(
    "openclaw.json patched: "
    f"origins={ui.get('allowedOrigins')} "
    f"trustedProxies={gw.get('trustedProxies')} "
    f"disableDeviceAuth={ui.get('dangerouslyDisableDeviceAuth', False)} "
    f"providerBaseUrl={_provider_block.get('baseUrl')} "
    f"primaryModel={defaults.get('model', {}).get('primary')} "
    f"contextWindow={_ctx} "
    f"maxTokens={_max} "
    f"compactionReserve={compaction['reserveTokensFloor']} "
    f"featherlessModels={_featherless_count}",
    file=sys.stderr,
)
PY
fi

exec /usr/bin/tini -s -- "$@"
