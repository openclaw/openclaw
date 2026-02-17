#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# O.R.I.O.N. Universal Deployer — macOS / Linux
#
# One-liner:
#   bash <(curl -fsSL https://raw.githubusercontent.com/zacharyjleach-stack/O.R.I.O.N./main/bin/setup.sh)
#
# What it does:
#   1. Ensures Node.js ≥ 22, pnpm, and Ollama are installed
#   2. Pulls the llama3 model via Ollama
#   3. Installs dependencies & builds the project
#   4. Writes ~/.openclaw/openclaw.json with a local Ollama provider
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No colour

info()  { printf "${CYAN}[O.R.I.O.N.]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[O.R.I.O.N.]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[O.R.I.O.N.]${NC} %s\n" "$*"; }
fail()  { printf "${RED}[O.R.I.O.N.]${NC} %s\n" "$*" >&2; exit 1; }

# ── Detect OS ────────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      fail "Unsupported OS: $OS" ;;
esac
info "Detected platform: $PLATFORM"

# ── Helper: version comparison (returns 0 if $1 >= $2) ──────────────────────
version_gte() {
  printf '%s\n%s' "$1" "$2" | sort -V | head -n1 | grep -qx "$2"
}

# ── 1. Node.js ≥ 22 ─────────────────────────────────────────────────────────
install_node() {
  if command -v node &>/dev/null; then
    NODE_VER="$(node -v | sed 's/^v//')"
    if version_gte "$NODE_VER" "22.0.0"; then
      ok "Node.js $NODE_VER already installed (≥ 22)"
      return
    fi
    warn "Node.js $NODE_VER found but < 22; installing newer version…"
  else
    info "Node.js not found; installing…"
  fi

  if [[ "$PLATFORM" == "macos" ]]; then
    if ! command -v brew &>/dev/null; then
      fail "Homebrew not found. Install it first: https://brew.sh"
    fi
    brew install node@22
    brew link --overwrite node@22 || true
  else
    # Linux: use NodeSource
    if command -v curl &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    else
      fail "curl is required to install Node.js on Linux"
    fi
  fi

  # Verify
  NODE_VER="$(node -v | sed 's/^v//')"
  version_gte "$NODE_VER" "22.0.0" || fail "Failed to install Node.js ≥ 22 (got $NODE_VER)"
  ok "Node.js $NODE_VER installed"
}

# ── 2. pnpm ──────────────────────────────────────────────────────────────────
install_pnpm() {
  if command -v pnpm &>/dev/null; then
    ok "pnpm $(pnpm -v) already installed"
    return
  fi
  info "Installing pnpm via corepack…"
  corepack enable 2>/dev/null || npm install -g pnpm
  command -v pnpm &>/dev/null || fail "Failed to install pnpm"
  ok "pnpm $(pnpm -v) installed"
}

# ── 3. Ollama ────────────────────────────────────────────────────────────────
install_ollama() {
  if command -v ollama &>/dev/null; then
    ok "Ollama already installed"
    return
  fi
  info "Installing Ollama…"
  if [[ "$PLATFORM" == "macos" ]]; then
    if command -v brew &>/dev/null; then
      brew install ollama
    else
      fail "Homebrew not found. Install Ollama manually: https://ollama.com/download"
    fi
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  command -v ollama &>/dev/null || fail "Failed to install Ollama"
  ok "Ollama installed"
}

# ── 4. Pull llama3 model ────────────────────────────────────────────────────
pull_model() {
  info "Ensuring Ollama is running…"

  # Start Ollama in the background if it is not already serving
  if ! ollama list &>/dev/null 2>&1; then
    ollama serve &>/dev/null 2>&1 &
    OLLAMA_PID=$!
    # Give it a moment to bind the port
    for i in {1..15}; do
      if ollama list &>/dev/null 2>&1; then break; fi
      sleep 1
    done
  fi

  info "Pulling llama3 (this may take a while on first run)…"
  ollama pull llama3
  ok "llama3 model ready"
}

# ── 5. Build project ────────────────────────────────────────────────────────
build_project() {
  # If we're inside the repo already, use that; otherwise try the cwd
  if [[ -f "package.json" ]] && grep -q '"openclaw"' package.json 2>/dev/null; then
    PROJECT_DIR="$(pwd)"
  elif [[ -f "openclaw.mjs" ]]; then
    PROJECT_DIR="$(pwd)"
  else
    fail "Run this script from the openclaw project root (where package.json lives)"
  fi

  info "Installing dependencies…"
  pnpm install

  info "Building project…"
  pnpm build
  ok "Build complete"
}

# ── 6. Generate config ──────────────────────────────────────────────────────
generate_config() {
  CONFIG_DIR="$HOME/.openclaw"
  CONFIG_FILE="$CONFIG_DIR/openclaw.json"

  if [[ -f "$CONFIG_FILE" ]]; then
    warn "Config already exists at $CONFIG_FILE — skipping generation."
    warn "To regenerate, delete it and re-run this script."
    return
  fi

  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"

  # Generate a random gateway auth token
  if command -v openssl >/dev/null 2>&1; then
    GW_TOKEN=$(openssl rand -hex 16)
  else
    GW_TOKEN=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  fi

  cat > "$CONFIG_FILE" <<CONFIGEOF
{
  "env": {
    "vars": {
      "OLLAMA_API_KEY": "ollama"
    }
  },
  "models": {
    "providers": {
      "local_ollama": {
        "baseUrl": "http://127.0.0.1:11434/v1",
        "api": "openai-completions",
        "apiKey": "ollama",
        "models": [
          {
            "id": "llama3",
            "name": "Llama 3",
            "reasoning": false,
            "contextWindow": 8192,
            "maxTokens": 4096,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "compat": { "maxTokensField": "max_tokens" }
          }
        ]
      }
    }
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "token": "${GW_TOKEN}"
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "local_ollama/llama3"
      }
    }
  }
}
CONFIGEOF

  chmod 600 "$CONFIG_FILE"
  ok "Config written to $CONFIG_FILE"
  ok "Gateway token: $GW_TOKEN"
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  printf "\n${BOLD}${CYAN}  ╔═══════════════════════════════════════════╗${NC}\n"
  printf "${BOLD}${CYAN}  ║   O.R.I.O.N. — Universal Deployer (v1)   ║${NC}\n"
  printf "${BOLD}${CYAN}  ╚═══════════════════════════════════════════╝${NC}\n\n"

  install_node
  install_pnpm
  install_ollama
  pull_model
  build_project
  generate_config

  printf "\n${GREEN}${BOLD}✓ O.R.I.O.N. is ready!${NC}\n\n"
  printf "  Start the gateway:\n"
  printf "    ${CYAN}node openclaw.mjs gateway run --dev${NC}\n\n"
  printf "  Then open the web UI at:\n"
  printf "    ${CYAN}http://localhost:18789/__openclaw__/canvas/${NC}\n\n"
}

main "$@"
