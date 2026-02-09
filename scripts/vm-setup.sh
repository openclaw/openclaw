#!/usr/bin/env bash
# vm-setup.sh — Prepare a fresh macOS Sequoia 15 (UTM) VM for OpenClaw development.
# Idempotent: safe to re-run. Each step checks if already done before acting.
# Usage: bash scripts/vm-setup.sh

set -euo pipefail

REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_FULL="22.12.0"
REQUIRED_PNPM="10.23.0"
REPO_URL="https://github.com/zendizmo/openclaw.git"
BRANCH="fix/security-vulnerabilities-critical-high"
CLONE_DIR="$HOME/openclaw"

# ---------- helpers ----------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

step=0
current_step=""

ok()   { printf "${GREEN}  [OK]${RESET} %s\n" "$*"; }
skip() { printf "${YELLOW}[SKIP]${RESET} %s\n" "$*"; }
fail() { printf "${RED}[FAIL]${RESET} %s\n" "$*"; }
info() { printf "${BOLD}  [>>]${RESET} %s\n" "$*"; }

begin_step() {
  step=$((step + 1))
  current_step="$1"
  printf "\n${BOLD}Step %d: %s${RESET}\n" "$step" "$current_step"
}

on_error() {
  fail "Failed at step $step: $current_step"
  exit 1
}
trap on_error ERR

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  local IFS=.
  local i a=($1) b=($2)
  for ((i = 0; i < ${#b[@]}; i++)); do
    local av="${a[i]:-0}" bv="${b[i]:-0}"
    if ((av > bv)); then return 0; fi
    if ((av < bv)); then return 1; fi
  done
  return 0
}

# ---------- Step 1: Xcode Command Line Tools ----------

begin_step "Xcode Command Line Tools"

if xcode-select -p &>/dev/null; then
  skip "Already installed at $(xcode-select -p)"
else
  info "Installing Xcode Command Line Tools (a dialog may appear)..."
  xcode-select --install
  info "Waiting for installation to complete..."
  until xcode-select -p &>/dev/null; do
    sleep 5
  done
  ok "Installed"
fi

# ---------- Step 2: Homebrew ----------

begin_step "Homebrew"

if command -v brew &>/dev/null; then
  skip "Already installed at $(command -v brew)"
else
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Add Homebrew to current shell
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  # Persist in ~/.zprofile if not already there
  if ! grep -q 'brew shellenv' "$HOME/.zprofile" 2>/dev/null; then
    if [[ -f /opt/homebrew/bin/brew ]]; then
      echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
    elif [[ -f /usr/local/bin/brew ]]; then
      echo 'eval "$(/usr/local/bin/brew shellenv)"' >> "$HOME/.zprofile"
    fi
    info "Added brew shellenv to ~/.zprofile"
  fi

  ok "Installed"
fi

# ---------- Step 3: Node 22 ----------

begin_step "Node $REQUIRED_NODE_MAJOR (>=$REQUIRED_NODE_FULL)"

node_ok=false
if command -v node &>/dev/null; then
  node_ver="$(node --version | sed 's/^v//')"
  if version_gte "$node_ver" "$REQUIRED_NODE_FULL"; then
    skip "Already installed: v$node_ver"
    node_ok=true
  else
    info "Current node v$node_ver is too old"
  fi
fi

if [[ "$node_ok" == false ]]; then
  info "Installing node@$REQUIRED_NODE_MAJOR via Homebrew..."
  brew install "node@$REQUIRED_NODE_MAJOR"

  node_bin="/opt/homebrew/opt/node@$REQUIRED_NODE_MAJOR/bin"
  if [[ ! -d "$node_bin" ]]; then
    node_bin="/usr/local/opt/node@$REQUIRED_NODE_MAJOR/bin"
  fi

  # Add to PATH for this session
  export PATH="$node_bin:$PATH"

  # Persist in ~/.zshrc if not already there
  if ! grep -q "node@$REQUIRED_NODE_MAJOR/bin" "$HOME/.zshrc" 2>/dev/null; then
    echo "export PATH=\"$node_bin:\$PATH\"" >> "$HOME/.zshrc"
    info "Added node@$REQUIRED_NODE_MAJOR to PATH in ~/.zshrc"
  fi

  node_ver="$(node --version | sed 's/^v//')"
  ok "Installed: v$node_ver"
fi

# ---------- Step 4: Corepack + pnpm ----------

begin_step "Corepack + pnpm $REQUIRED_PNPM"

if ! command -v corepack &>/dev/null; then
  fail "corepack not found — it should ship with Node $REQUIRED_NODE_MAJOR"
  exit 1
fi

info "Enabling corepack..."
corepack enable

info "Preparing pnpm@$REQUIRED_PNPM..."
corepack prepare "pnpm@$REQUIRED_PNPM" --activate

pnpm_ver="$(pnpm --version 2>/dev/null || echo "unknown")"
ok "pnpm $pnpm_ver active"

# ---------- Step 5: Clone repo ----------

begin_step "Clone repository"

# Determine project directory — use existing repo if we're inside one
project_dir=""

if git rev-parse --show-toplevel &>/dev/null; then
  toplevel="$(git rev-parse --show-toplevel)"
  if [[ -f "$toplevel/package.json" ]] && grep -q '"openclaw"' "$toplevel/package.json" 2>/dev/null; then
    project_dir="$toplevel"
    skip "Already inside openclaw repo at $project_dir"
  fi
fi

if [[ -z "$project_dir" ]]; then
  if [[ -d "$CLONE_DIR/.git" ]]; then
    project_dir="$CLONE_DIR"
    skip "Repo already cloned at $project_dir"
  else
    info "Cloning $REPO_URL into $CLONE_DIR..."
    git clone "$REPO_URL" "$CLONE_DIR"
    project_dir="$CLONE_DIR"
    ok "Cloned"
  fi
fi

cd "$project_dir"
info "Working directory: $(pwd)"

# ---------- Step 6: Checkout security branch ----------

begin_step "Checkout branch $BRANCH"

current_branch="$(git branch --show-current)"
if [[ "$current_branch" == "$BRANCH" ]]; then
  skip "Already on $BRANCH"
else
  info "Switching to $BRANCH..."
  git checkout "$BRANCH"
fi

info "Pulling latest changes..."
git pull origin "$BRANCH"
ok "Branch up to date"

# ---------- Step 7: Install dependencies ----------

begin_step "Install dependencies (pnpm install)"

info "Running pnpm install --frozen-lockfile..."
pnpm install --frozen-lockfile
ok "Dependencies installed"

# ---------- Step 8: Build ----------

begin_step "Build project"

info "Running pnpm build..."
pnpm build
ok "Build complete"

# ---------- Done ----------

printf "\n${GREEN}${BOLD}Setup complete!${RESET}\n\n"
printf "  Node:  %s\n" "$(node --version)"
printf "  pnpm:  %s\n" "$(pnpm --version)"
printf "  Dir:   %s\n" "$(pwd)"
printf "\n${BOLD}Next steps:${RESET}\n"
printf "  pnpm openclaw onboard    # Initial setup wizard\n"
printf "  pnpm openclaw gateway    # Start the gateway\n"
printf "  pnpm openclaw doctor     # Check system health\n\n"
