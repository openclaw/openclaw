#!/usr/bin/env bash
# fly-entrypoint.sh — Self-healing CLI tool installer for Fly.io
#
# Ensures all CLI tools are available on the persistent volume (/data/bin/).
# Three-tier priority: image binary > persistent binary > download from release.
# Runs on every boot but only does work when a tool is missing.
#
# Usage (in fly.toml):
#   app = "/app/scripts/fly-entrypoint.sh node dist/index.js gateway ..."

set -uo pipefail

DATA_DIR="${OPENCLAW_STATE_DIR:-/data}"
BIN_DIR="$DATA_DIR/bin"
NPM_GLOBAL_DIR="$DATA_DIR/npm-global"

# Ensure ~/.openclaw symlinks to persistent volume so agent config
# (exec-approvals, workspace, identity) survives across deploys
OPENCLAW_DOT_DIR="$DATA_DIR/.openclaw"
HOME_DOT_DIR="$HOME/.openclaw"
if [ -d "$OPENCLAW_DOT_DIR" ] && [ ! -L "$HOME_DOT_DIR" ]; then
  rm -rf "$HOME_DOT_DIR"
  ln -s "$OPENCLAW_DOT_DIR" "$HOME_DOT_DIR"
  echo "[fly-entrypoint] symlinked $HOME_DOT_DIR -> $OPENCLAW_DOT_DIR"
fi

mkdir -p "$BIN_DIR" 2>/dev/null || true

# Verify we can write to the bin directory
if ! touch "$BIN_DIR/.write-test" 2>/dev/null; then
  log "WARNING: $BIN_DIR is not writable (owned by root?). Skipping tool sync."
  log "Fix with: fly ssh console -C 'chown -R node:node /data/bin'"
  log "Tools from the Docker image will still be available via PATH."
  exec "$@"
fi
rm -f "$BIN_DIR/.write-test"

# ── Tool manifest ──────────────────────────────────────────────────────────
# Format: "binary_name|download_url|archive_member_path"
#   binary_name   — name of the binary on disk
#   download_url  — direct URL to a .tar.gz release archive
#   archive_member_path — path inside the archive to extract (supports tar strip)
#
# Special handling:
#   - If archive_member_path contains '/', we use --strip-components + wildcard
#   - gh uses a .deb, handled separately

TOOLS=(
  "gog|https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz|gog"
  "himalaya|https://github.com/pimalaya/himalaya/releases/download/v1.1.0/himalaya.x86_64-linux.tgz|himalaya"
  "slack|https://github.com/slackapi/slack-cli/releases/download/v3.12.0/slack_cli_3.12.0_linux_64-bit.tar.gz|bin/slack"
  "sag|https://github.com/steipete/sag/releases/download/v0.2.2/sag_0.2.2_linux_amd64.tar.gz|sag"
  "spotify_player|https://github.com/aome510/spotify-player/releases/download/v0.21.3/spotify_player-x86_64-unknown-linux-gnu.tar.gz|spotify_player"
  "jira|https://github.com/ankitpokhrel/jira-cli/releases/download/v1.7.0/jira_1.7.0_linux_x86_64.tar.gz|jira_1.7.0_linux_x86_64/bin/jira"
)

# gh is distributed as a .deb or tarball — use tarball for non-root extraction
GH_URL="https://github.com/cli/cli/releases/download/v2.86.0/gh_2.86.0_linux_amd64.tar.gz"
GH_VERSION="2.86.0"

# npm global packages to ensure
NPM_PACKAGES=(
  "trello-cli"
  "@litencatt/notion-cli"
  "vercel"
  "@anthropic-ai/claude-code"
  "@shopify/cli"
  "mcporter"
)

# ── Helper functions ───────────────────────────────────────────────────────

log() {
  echo "[fly-entrypoint] $*"
}

ensure_tool() {
  local name="$1"
  local url="$2"
  local member="$3"

  # 1. Available in the Docker image — use it directly (no copy needed)
  if command -v "$name" &>/dev/null; then
    return 0
  fi

  # 2. Already in /data/bin/ — available via PATH
  if [ -x "$BIN_DIR/$name" ]; then
    return 0
  fi

  # 3. Download from release URL (only when missing from both image and /data/bin)
  log "$name: downloading from $url"
  local tmpdir
  tmpdir="$(mktemp -d)"

  if [[ "$member" == */* ]]; then
    # Member path has directories — extract with strip-components
    local depth
    depth=$(echo "$member" | tr '/' '\n' | wc -l)
    depth=$((depth - 1))
    local basename
    basename=$(basename "$member")
    curl -fsSL "$url" | tar xz -C "$tmpdir" --strip-components="$depth" "*/$basename" 2>/dev/null \
      || curl -fsSL "$url" | tar xz -C "$tmpdir"
    if [ -f "$tmpdir/$basename" ]; then
      mv "$tmpdir/$basename" "$BIN_DIR/$name"
    elif [ -f "$tmpdir/$name" ]; then
      mv "$tmpdir/$name" "$BIN_DIR/$name"
    fi
  else
    # Simple member — extract directly
    curl -fsSL "$url" | tar xz -C "$tmpdir"
    if [ -f "$tmpdir/$member" ]; then
      mv "$tmpdir/$member" "$BIN_DIR/$name"
    fi
  fi

  chmod +x "$BIN_DIR/$name" 2>/dev/null || true
  rm -rf "$tmpdir"

  if [ -x "$BIN_DIR/$name" ]; then
    log "$name: installed successfully"
  else
    log "$name: WARNING — installation failed"
  fi
}

ensure_gh() {
  # gh gets special handling because the tarball has a nested structure
  # 1. Available in image — use directly
  if command -v gh &>/dev/null; then
    return 0
  fi

  # 2. Already in /data/bin/
  if [ -x "$BIN_DIR/gh" ]; then
    return 0
  fi

  # 3. Download
  log "gh: downloading v$GH_VERSION"
  local tmpdir
  tmpdir="$(mktemp -d)"
  curl -fsSL "$GH_URL" | tar xz -C "$tmpdir"
  mv "$tmpdir/gh_${GH_VERSION}_linux_amd64/bin/gh" "$BIN_DIR/gh"
  chmod +x "$BIN_DIR/gh"
  rm -rf "$tmpdir"
  log "gh: installed successfully"
}

ensure_npm_packages() {
  # Only install if npm is available
  if ! command -v npm &>/dev/null; then
    log "npm not found, skipping npm global packages"
    return 0
  fi

  mkdir -p "$NPM_GLOBAL_DIR"

  for pkg in "${NPM_PACKAGES[@]}"; do
    # Derive the binary name from the package (last segment, strip @scope/)
    local bin_name
    bin_name="$(echo "$pkg" | sed 's|^@[^/]*/||')"

    # Check if the binary already exists (in image or persistent volume)
    if command -v "$bin_name" &>/dev/null || [ -x "$NPM_GLOBAL_DIR/bin/$bin_name" ]; then
      continue
    fi

    log "npm: installing $pkg"
    npm install -g "$pkg" --prefix "$NPM_GLOBAL_DIR" 2>/dev/null || \
      log "npm: WARNING — failed to install $pkg"
  done
}

# ── Main ───────────────────────────────────────────────────────────────────

log "ensuring CLI tools on persistent volume..."

# Ensure /data/bin is on PATH
export PATH="$BIN_DIR:$NPM_GLOBAL_DIR/bin:$PATH"

# Install tarball-based tools (errors logged but never fatal)
for entry in "${TOOLS[@]}"; do
  IFS='|' read -r name url member <<< "$entry"
  ensure_tool "$name" "$url" "$member" || log "$name: skipped (non-fatal error)"
done

# Install gh (special handling, non-fatal)
ensure_gh || log "gh: skipped (non-fatal error)"

# Install npm global packages (background — don't block gateway startup)
ensure_npm_packages &

log "tool check complete."

# ── Ensure gateway.controlUi.allowedOrigins is set ───────────────────────
# Required by upstream when --bind lan is used. Must be set before gateway starts.
# Idempotent: only writes if the key is missing.
GATEWAY_CONFIG="$DATA_DIR/openclaw.json"
if [ -f "$GATEWAY_CONFIG" ] && command -v python3 &>/dev/null; then
  python3 - "$GATEWAY_CONFIG" <<'PYEOF' 2>/dev/null || true
import json, sys
path = sys.argv[1]
with open(path) as f:
    c = json.load(f)
ui = c.setdefault('gateway', {}).setdefault('controlUi', {})
if 'allowedOrigins' not in ui and not ui.get('dangerouslyAllowHostHeaderOriginFallback'):
    ui['allowedOrigins'] = [
        'https://openclaw-jhs.fly.dev',
        'https://larry.jhsconsulting.net',
        'https://od.jhsconsulting.net'
    ]
    with open(path, 'w') as f:
        json.dump(c, f, indent=2)
PYEOF
fi

# ── Agent workspace versioning ────────────────────────────────────────────
# Clone or pull jhs129/openclaw-agents into /data/agents-config/ on every boot.
# Workspace dirs (/data/workspace-larry etc.) are symlinked into the git checkout
# so agents read/write directly in the versioned tree — no data duplication.
# A background hourly loop commits and pushes any changes the agents made.

AGENTS_CONFIG_DIR="$DATA_DIR/agents-config"
AGENTS_REPO_URL="https://x-access-token:${GH_WORKSPACE_TOKEN:-}@github.com/jhs129/openclaw-agents.git"

# Workspace dirs managed by the agents repo (one dir per agent, all content inside).
# Note: /data/agents/ is openclaw's internal data dir (sessions, memory DB) —
# NOT in the repo; managed by the platform, not version-controlled.
AGENT_WORKSPACES="workspace-larry workspace-peterino workspace-joao"

if [ -n "${GH_WORKSPACE_TOKEN:-}" ]; then
  # Fix "dubious ownership" error — volume files may be owned by root
  git config --global --add safe.directory "$AGENTS_CONFIG_DIR" 2>/dev/null || true

  # ── Clone or pull ───────────────────────────────────────────────────────
  if [ ! -d "$AGENTS_CONFIG_DIR/.git" ]; then
    log "agents-config: cloning jhs129/openclaw-agents..."
    git clone "$AGENTS_REPO_URL" "$AGENTS_CONFIG_DIR" 2>/dev/null \
      && log "agents-config: clone complete" \
      || log "agents-config: WARNING — clone failed, agents may start with stale data"
  else
    log "agents-config: pulling latest..."
    cd "$AGENTS_CONFIG_DIR"
    git remote set-url origin "$AGENTS_REPO_URL" 2>/dev/null || true
    git pull --ff-only origin main 2>/dev/null \
      && log "agents-config: up to date" \
      || log "agents-config: WARNING — pull failed (will use cached state)"
    cd /app
  fi

  # ── Set commit identity ─────────────────────────────────────────────────
  if [ -d "$AGENTS_CONFIG_DIR/.git" ]; then
    git -C "$AGENTS_CONFIG_DIR" config user.email "agents@openclaw.dev"
    git -C "$AGENTS_CONFIG_DIR" config user.name "OpenClaw Agents"
  fi

  # ── Create symlinks: /data/workspace-* → /data/agents-config/workspace-* ──
  # Agents read/write their workspace directly in the git working tree.
  # Remove any gateway-seeded template dirs first (they have blank files).
  for ws in $AGENT_WORKSPACES; do
    TARGET="$AGENTS_CONFIG_DIR/$ws"
    LINK="$DATA_DIR/$ws"
    if [ -d "$TARGET" ]; then
      # Remove existing dir (gateway-seeded templates) or stale symlink
      if [ ! -L "$LINK" ]; then
        rm -rf "$LINK"
      fi
      ln -sfn "$TARGET" "$LINK"
    fi
  done

  # ── Commit any changes that accumulated since the last hourly push ───────
  if [ -d "$AGENTS_CONFIG_DIR/.git" ]; then
    cd "$AGENTS_CONFIG_DIR"
    git add -A 2>/dev/null || true
    if ! git diff --cached --quiet 2>/dev/null; then
      git commit -m "auto: boot snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null \
        && log "agents-config: committed boot snapshot"
    fi
    git push -u origin main 2>/dev/null \
      && log "agents-config: pushed to remote" \
      || log "agents-config: push skipped (will retry on next cron)"
    cd /app
  fi

  # ── Hourly background commit loop ────────────────────────────────────────
  # Commits and pushes any agent-written changes (memory notes, MEMORY.md updates)
  # every hour. Runs as a background process — no crond needed.
  (
    while true; do
      sleep 3600
      if [ -d "$AGENTS_CONFIG_DIR/.git" ]; then
        cd "$AGENTS_CONFIG_DIR"
        git add -A 2>/dev/null || true
        if ! git diff --cached --quiet 2>/dev/null; then
          git commit -m "auto: hourly $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null
          git push origin main 2>/dev/null \
            && echo "[fly-entrypoint] agents-config: hourly push complete" \
            || echo "[fly-entrypoint] agents-config: hourly push failed"
        fi
        cd /app
      fi
    done
  ) &

else
  log "agents-config: GH_WORKSPACE_TOKEN not set — skipping workspace versioning"
fi

log "starting application..."

# Hand off to the actual command
exec "$@"
