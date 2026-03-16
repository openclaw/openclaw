#!/usr/bin/env bash
# scripts/add-token.sh — Add or update an API key in a running OpenClaw container
#
# Usage:
#   ./scripts/add-token.sh                          # interactive mode
#   ./scripts/add-token.sh openai sk-...            # non-interactive
#   ./scripts/add-token.sh anthropic sk-ant-...
#   ./scripts/add-token.sh google AIza...
#   ./scripts/add-token.sh openrouter sk-or-...
#   ./scripts/add-token.sh ollama http://localhost:11434  # base URL as "key"
#
# Optional env vars:
#   OPENCLAW_CONTAINER  — container name (default: auto-detect)
#   OPENCLAW_SET_MODEL  — also set agents.defaults.model (default: yes if first key)
set -euo pipefail

# ── Helpers ───────────────────────────────────────────────────────────────────
bold()    { printf '\033[1m%s\033[0m' "$*"; }
info()    { echo "  → $*"; }
success() { echo "  ✓ $*"; }
warn()    { echo "  ⚠ $*"; }
die()     { echo "✗ $*" >&2; exit 1; }
prompt()  { printf "  %s: " "$(bold "$1")"; read -r REPLY; echo "$REPLY"; }
pick()    {
  local label="$1"; shift
  local options=("$@")
  echo "  $(bold "$label")"
  for i in "${!options[@]}"; do
    printf "    [%d] %s\n" "$((i+1))" "${options[$i]}"
  done
  while true; do
    printf "  Choice [1-%d]: " "${#options[@]}"
    read -r choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#options[@]} )); then
      echo "${options[$((choice-1))]}"
      return
    fi
    warn "Enter a number between 1 and ${#options[@]}"
  done
}

# ── Provider table ────────────────────────────────────────────────────────────
# Format: "id|display_name|default_model|key_hint"
PROVIDERS=(
  "openai|OpenAI|openai/gpt-4o|sk-..."
  "anthropic|Anthropic (Claude)|anthropic/claude-sonnet-4-6|sk-ant-..."
  "google|Google (Gemini)|google/gemini-3.1-pro-preview|AIza..."
  "openrouter|OpenRouter|openrouter/anthropic/claude-sonnet-4-6|sk-or-..."
  "mistral|Mistral AI|mistral/mistral-large-latest|..."
  "groq|Groq|groq/llama-3.3-70b-versatile|gsk_..."
  "xai|xAI (Grok)|xai/grok-3-beta|xai-..."
  "deepseek|DeepSeek|deepseek/deepseek-chat|sk-..."
  "together|Together AI|together/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo|..."
  "ollama|Ollama (local)|ollama/llama3.2|http://localhost:11434"
  "litellm|LiteLLM proxy|litellm/gpt-4o|http://localhost:4000"
  "openai-codex|OpenAI Codex|openai/gpt-5.1-codex|sk-..."
)

provider_field() {
  local id="$1" field="$2"  # field: 0=id 1=display 2=model 3=hint
  for entry in "${PROVIDERS[@]}"; do
    IFS='|' read -r pid disp model hint <<< "$entry"
    if [[ "$pid" == "$id" ]]; then
      case "$field" in
        display) echo "$disp" ;;
        model)   echo "$model" ;;
        hint)    echo "$hint" ;;
      esac
      return
    fi
  done
}

provider_ids() {
  for entry in "${PROVIDERS[@]}"; do echo "${entry%%|*}"; done
}

# ── Detect container ──────────────────────────────────────────────────────────
detect_container() {
  # Try docker compose first, then plain docker
  local name
  name="$(docker compose ps --format json 2>/dev/null \
    | python3 -c "import sys,json; cs=[c.get('Name','') for c in json.load(sys.stdin) if 'gateway' in c.get('Name','').lower()]; print(cs[0] if cs else '')" 2>/dev/null || true)"
  if [[ -z "$name" ]]; then
    name="$(docker ps --filter name=openclaw --format "{{.Names}}" 2>/dev/null | grep -i gateway | head -1 || true)"
  fi
  echo "$name"
}

run_in_container() {
  docker exec -i "$CONTAINER" "$@"
}

# ── Parse args ────────────────────────────────────────────────────────────────
PROVIDER_ARG="${1:-}"
KEY_ARG="${2:-}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🦞 OpenClaw — Add API Token"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Find container ────────────────────────────────────────────────────────────
CONTAINER="${OPENCLAW_CONTAINER:-}"
if [[ -z "$CONTAINER" ]]; then
  CONTAINER="$(detect_container)"
fi
[[ -z "$CONTAINER" ]] && die "No running OpenClaw gateway container found. Start with ./scripts/launch.sh first."
info "Container: $CONTAINER"

# ── Choose provider ───────────────────────────────────────────────────────────
if [[ -n "$PROVIDER_ARG" ]]; then
  PROVIDER="$PROVIDER_ARG"
  # Validate
  if ! echo "$(provider_ids)" | grep -qx "$PROVIDER"; then
    die "Unknown provider '$PROVIDER'. Valid: $(provider_ids | tr '\n' ' ')"
  fi
else
  echo ""
  DISPLAY_NAMES=()
  for entry in "${PROVIDERS[@]}"; do
    IFS='|' read -r pid disp model hint <<< "$entry"
    DISPLAY_NAMES+=("$disp  ($pid)")
  done
  SELECTED="$(pick "Select provider:" "${DISPLAY_NAMES[@]}")"
  # Extract id from the selected display string
  PROVIDER="$(echo "$SELECTED" | grep -oE '\([a-z0-9_-]+\)$' | tr -d '()')"
fi

DISPLAY="$(provider_field "$PROVIDER" display)"
DEFAULT_MODEL="$(provider_field "$PROVIDER" model)"
KEY_HINT="$(provider_field "$PROVIDER" hint)"
echo ""
info "Provider: $DISPLAY"

# ── Get API key ───────────────────────────────────────────────────────────────
if [[ -n "$KEY_ARG" ]]; then
  API_KEY="$KEY_ARG"
else
  printf "  %s [%s]: " "$(bold "API key")" "$KEY_HINT"
  read -rs API_KEY
  echo ""
fi
[[ -z "$API_KEY" ]] && die "API key cannot be empty"

# ── Profile ID ────────────────────────────────────────────────────────────────
PROFILE_ID="${PROVIDER}-default"

# ── Read or create auth-profiles.json in container ───────────────────────────
AUTH_PATH="/home/node/.openclaw/agents/main/agent/auth-profiles.json"

echo ""
info "Reading existing auth profiles..."

# Ensure the directory exists
run_in_container mkdir -p /home/node/.openclaw/agents/main/agent

EXISTING="$(run_in_container sh -c "cat $AUTH_PATH 2>/dev/null || echo '{}'")"

# Merge the new profile using python3 (available in the container).
# API_KEY is passed via -e so it never gets interpolated into Python source code.
UPDATED="$(echo "$EXISTING" | docker exec -i -e "OPENCLAW_NEW_API_KEY=$API_KEY" "$CONTAINER" python3 -c "
import json, sys, os

data = json.load(sys.stdin)
if 'version' not in data:
    data['version'] = 1
if 'profiles' not in data or not isinstance(data.get('profiles'), dict):
    data['profiles'] = {}

data['profiles']['$PROFILE_ID'] = {
    'type': 'api_key',
    'provider': '$PROVIDER',
    'key': os.environ['OPENCLAW_NEW_API_KEY']
}

print(json.dumps(data, indent=2))
")"

# Write back
echo "$UPDATED" | run_in_container sh -c "cat > $AUTH_PATH"
success "Saved profile '$PROFILE_ID' to $AUTH_PATH"

# ── Optionally set default model ──────────────────────────────────────────────
SET_MODEL="${OPENCLAW_SET_MODEL:-ask}"

if [[ "$SET_MODEL" == "ask" ]]; then
  echo ""
  printf "  %s (y/N): " "$(bold "Set '$DEFAULT_MODEL' as the default agent model?")"
  read -r yn
  [[ "$yn" =~ ^[Yy] ]] && SET_MODEL="yes" || SET_MODEL="no"
fi

if [[ "$SET_MODEL" == "yes" ]]; then
  run_in_container node dist/index.js config set agents.defaults.model "$DEFAULT_MODEL" 2>&1 \
    | grep -v "^$\|plugins\|Cannot\|Require" || true
  success "Default model set to: $DEFAULT_MODEL"
  echo ""
  warn "Restart the gateway for the model change to take effect:"
  echo "    docker compose restart openclaw-gateway"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Token added — profile: $PROFILE_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
