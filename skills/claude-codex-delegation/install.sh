#!/usr/bin/env bash
# install.sh — Install Claude Code + Codex delegation bundle for OpenClaw.
#
# Installs the Claude Code and Codex CLIs, copies delegation scripts
# into your OpenClaw workspace, and verifies the setup.
#
# Usage:
#   install.sh [options]
#
# Options:
#   --skip-npm          Skip npm package installation (if already installed)
#   --scripts-dir DIR   Where to install scripts (default: ~/.openclaw/scripts)
#   --dry-run           Show what would be done without doing it
#   -h, --help          Show this help message
#
# Requirements:
#   - Node.js 22+ with npm
#   - Existing OpenClaw installation
#   - Claude Max or OpenAI subscription (for subscription-based auth)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="${HOME}/.openclaw/scripts"
SKIP_NPM=false
DRY_RUN=false

# --- Versions (pin to known-good releases) ---
CLAUDE_CODE_PKG="@anthropic-ai/claude-code"
CODEX_PKG="@openai/codex"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-npm|--scripts-dir|--dry-run)
            if [[ "$1" == "--scripts-dir" ]]; then
                if [[ $# -lt 2 ]]; then
                    echo "Error: $1 requires a value" >&2
                    exit 1
                fi
            fi
            ;;&
        --skip-npm)     SKIP_NPM=true; shift ;;
        --scripts-dir)  SCRIPTS_DIR="$2"; shift 2 ;;
        --dry-run)      DRY_RUN=true; shift ;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Error: Unknown option: $1" >&2; exit 1 ;;
    esac
done

run() {
    if $DRY_RUN; then
        echo "  [dry-run] $*"
    else
        "$@"
    fi
}

echo ""
echo "Claude Code + Codex Delegation — Installer"
echo "============================================"
echo ""

# --- Check Node.js ---
if ! command -v node &> /dev/null; then
    error "Node.js is not installed. Install Node.js 22+ first."
    echo "  https://nodejs.org/ or: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
    warn "Node.js $(node -v) detected. Version 22+ is recommended."
fi

if ! command -v npm &> /dev/null; then
    error "npm is not installed."
    exit 1
fi

# --- Check OpenClaw ---
if ! command -v openclaw &> /dev/null; then
    error "OpenClaw is not installed. Install with: npm install -g openclaw"
    exit 1
fi
info "OpenClaw detected ($(openclaw --version 2>/dev/null || echo 'unknown version'))"

# --- Install Claude Code ---
if ! $SKIP_NPM; then
    echo ""
    echo "Installing Claude Code..."
    if command -v claude &> /dev/null; then
        info "Claude Code already installed ($(claude --version 2>/dev/null || echo 'unknown version'))"
    else
        run npm install -g "$CLAUDE_CODE_PKG"
        if ! $DRY_RUN; then
            info "Claude Code installed"
        fi
    fi

    echo ""
    echo "Installing OpenAI Codex CLI..."
    if command -v codex &> /dev/null; then
        info "Codex CLI already installed ($(codex --version 2>/dev/null || echo 'unknown version'))"
    else
        run npm install -g "$CODEX_PKG"
        if ! $DRY_RUN; then
            info "Codex CLI installed"
        fi
    fi
fi

# --- Install delegation scripts ---
echo ""
echo "Installing delegation scripts to $SCRIPTS_DIR..."
run mkdir -p "$SCRIPTS_DIR"

for script in delegate.sh tmux-session.sh; do
    SRC="$SCRIPT_DIR/scripts/$script"
    DST="$SCRIPTS_DIR/$script"
    if [[ -f "$SRC" ]]; then
        run cp "$SRC" "$DST"
        run chmod +x "$DST"
        info "Installed $script"
    else
        warn "Script not found: $SRC"
    fi
done

# --- Install skill file ---
echo ""
echo "Installing skill definition..."
SKILL_DIR="${HOME}/.openclaw/workspace/skills/claude-codex-delegation"
run mkdir -p "$SKILL_DIR/references"
if [[ -f "$SCRIPT_DIR/SKILL.md" ]]; then
    run cp "$SCRIPT_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
    info "Installed SKILL.md"
fi
if [[ -f "$SCRIPT_DIR/references/delegation-policy.md" ]]; then
    run cp "$SCRIPT_DIR/references/delegation-policy.md" "$SKILL_DIR/references/delegation-policy.md"
    info "Installed delegation-policy.md"
fi

# --- Verify ---
echo ""
echo "Verifying installation..."
ERRORS=0

if command -v claude &> /dev/null || $DRY_RUN; then
    info "claude CLI: OK"
else
    error "claude CLI: not found"
    ((ERRORS++))
fi

if command -v codex &> /dev/null || $DRY_RUN; then
    info "codex CLI: OK"
else
    error "codex CLI: not found"
    ((ERRORS++))
fi

if [[ -x "$SCRIPTS_DIR/delegate.sh" ]] || $DRY_RUN; then
    info "delegate.sh: OK"
else
    error "delegate.sh: not found or not executable"
    ((ERRORS++))
fi

if [[ -x "$SCRIPTS_DIR/tmux-session.sh" ]] || $DRY_RUN; then
    info "tmux-session.sh: OK"
else
    error "tmux-session.sh: not found or not executable"
    ((ERRORS++))
fi

# --- Optional dependencies ---
echo ""
if command -v tmux &> /dev/null; then
    info "tmux: available (for long-running sessions)"
else
    warn "tmux: not installed (optional — needed for tmux-session.sh)"
fi

if command -v timeout &> /dev/null; then
    info "timeout: available"
else
    warn "timeout: not found (needed for delegate.sh)"
fi

# --- Auth check ---
echo ""
echo "Checking auth..."
echo "  Claude Code auth: run 'claude auth' to verify subscription/OAuth is configured"
echo "  Codex auth: run 'codex auth' to verify OpenAI subscription is configured"
echo ""
echo "  NOTE: The delegation scripts strip API keys from the sub-process"
echo "  environment. Both Claude Code and Codex must be configured with"
echo "  subscription/OAuth auth — API key auth will NOT work."

# --- Summary ---
echo ""
if [[ $ERRORS -eq 0 ]]; then
    echo "============================================"
    info "Installation complete."
    echo ""
    echo "  Delegate a task:"
    echo "    $SCRIPTS_DIR/delegate.sh --prompt 'Your task' --workdir ~/project"
    echo ""
    echo "  Long-running task in tmux:"
    echo "    $SCRIPTS_DIR/tmux-session.sh --name my-task --prompt 'Your task' --workdir ~/project"
    echo ""
    echo "  See SKILL.md for full usage and security documentation."
    echo "============================================"
else
    error "$ERRORS verification error(s). Check the output above."
    exit 1
fi
