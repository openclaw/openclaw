#!/usr/bin/env bash
# install.sh - Install Claude Code + Codex delegation bundle for OpenClaw.
#
# Copies the entire skill directory (SKILL.md, scripts, references) into
# OpenClaw's shared skill location so the agent can discover and use it.
# Optionally installs the Claude Code and Codex CLIs via npm.
#
# Usage:
#   install.sh [options]
#
# Options:
#   --skip-npm          Skip npm package installation (if already installed)
#   --skill-dir DIR     Override skill install location
#                       (default: ~/.openclaw/skills/claude-codex-delegation)
#   --force             Reinstall npm packages even if already present
#   --dry-run           Show what would be done without doing it
#   -h, --help          Show this help message
#
# Requirements:
#   - Node.js 22+ with npm
#   - Existing OpenClaw installation
#   - GNU coreutils (timeout, script) on Linux; macOS needs coreutils via brew
#   - Claude Max or OpenAI subscription (for subscription-based auth)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${HOME}/.openclaw/skills/claude-codex-delegation"
SKIP_NPM=false
FORCE=false
DRY_RUN=false

# --- Pinned versions ---
CLAUDE_CODE_PKG="@anthropic-ai/claude-code@latest"
CODEX_PKG="@openai/codex@latest"

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
        --skill-dir)
            if [[ $# -lt 2 ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            SKILL_DIR="$2"; shift 2 ;;
        --skip-npm)     SKIP_NPM=true; shift ;;
        --force)        FORCE=true; shift ;;
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
echo "Claude Code + Codex Delegation - Installer"
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
    error "Node.js $(node -v) detected. Version 22+ is required."
    echo "  Install Node.js 22+: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    exit 1
fi
info "Node.js $(node -v)"

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

# --- Check required system utilities ---
echo ""
echo "Checking system dependencies..."
MISSING=0

if ! command -v timeout &> /dev/null; then
    error "'timeout' is required but not found."
    if [[ "$(uname)" == "Darwin" ]]; then
        echo "  Install with: brew install coreutils"
    fi
    ((MISSING++))
else
    info "timeout: available"
fi

if command -v tmux &> /dev/null; then
    info "tmux: available"
else
    warn "tmux: not installed (optional, needed for tmux-session.sh)"
fi

if [[ $MISSING -gt 0 ]]; then
    error "Missing $MISSING required system dependency. Install it and rerun."
    exit 1
fi

# --- Install Claude Code and Codex ---
if ! $SKIP_NPM; then
    echo ""
    echo "Installing Claude Code..."
    if command -v claude &> /dev/null && ! $FORCE; then
        info "Claude Code already installed ($(claude --version 2>/dev/null || echo 'unknown version')). Use --force to reinstall."
    else
        run npm install -g "$CLAUDE_CODE_PKG"
        if ! $DRY_RUN; then
            info "Claude Code installed"
        fi
    fi

    echo ""
    echo "Installing OpenAI Codex CLI..."
    if command -v codex &> /dev/null && ! $FORCE; then
        info "Codex CLI already installed ($(codex --version 2>/dev/null || echo 'unknown version')). Use --force to reinstall."
    else
        run npm install -g "$CODEX_PKG"
        if ! $DRY_RUN; then
            info "Codex CLI installed"
        fi
    fi
fi

# --- Install skill bundle ---
# Copies the entire skill directory (SKILL.md, scripts/, references/) into
# OpenClaw's shared skill location (~/.openclaw/skills/) so the agent
# discovers it automatically. All resources stay inside the skill folder.
echo ""
echo "Installing skill bundle to $SKILL_DIR..."
run mkdir -p "$SKILL_DIR/scripts"
run mkdir -p "$SKILL_DIR/references"

# SKILL.md
if [[ -f "$SCRIPT_DIR/SKILL.md" ]]; then
    run cp "$SCRIPT_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
    info "Installed SKILL.md"
fi

# Scripts (inside the skill directory, not a global scripts dir)
for script in delegate.sh tmux-session.sh; do
    SRC="$SCRIPT_DIR/scripts/$script"
    DST="$SKILL_DIR/scripts/$script"
    if [[ -f "$SRC" ]]; then
        run cp "$SRC" "$DST"
        run chmod +x "$DST"
        info "Installed scripts/$script"
    else
        error "Script not found: $SRC"
    fi
done

# References
if [[ -f "$SCRIPT_DIR/references/delegation-policy.md" ]]; then
    run cp "$SCRIPT_DIR/references/delegation-policy.md" "$SKILL_DIR/references/delegation-policy.md"
    info "Installed references/delegation-policy.md"
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

if [[ -f "$SKILL_DIR/SKILL.md" ]] || $DRY_RUN; then
    info "SKILL.md: OK"
else
    error "SKILL.md: not found at $SKILL_DIR"
    ((ERRORS++))
fi

if [[ -x "$SKILL_DIR/scripts/delegate.sh" ]] || $DRY_RUN; then
    info "scripts/delegate.sh: OK"
else
    error "scripts/delegate.sh: not found or not executable"
    ((ERRORS++))
fi

if [[ -x "$SKILL_DIR/scripts/tmux-session.sh" ]] || $DRY_RUN; then
    info "scripts/tmux-session.sh: OK"
else
    error "scripts/tmux-session.sh: not found or not executable"
    ((ERRORS++))
fi

# --- Auth check ---
echo ""
echo "Checking auth..."
echo "  Claude Code: run 'claude auth' to verify subscription/OAuth is configured"
echo "  Codex: run 'codex auth' to verify OpenAI subscription is configured"
echo ""
echo "  NOTE: The delegation scripts strip API keys from the sub-process"
echo "  environment. Both CLIs must be configured with subscription/OAuth"
echo "  auth. API key auth will NOT work."

# --- Summary ---
echo ""
if [[ $ERRORS -eq 0 ]]; then
    echo "============================================"
    info "Installation complete."
    echo ""
    echo "  Skill installed to: $SKILL_DIR"
    echo ""
    echo "  Delegate a task:"
    echo "    $SKILL_DIR/scripts/delegate.sh --prompt 'Your task' --workdir ~/project"
    echo ""
    echo "  Long-running task in tmux:"
    echo "    $SKILL_DIR/scripts/tmux-session.sh --name my-task --prompt 'Your task' --workdir ~/project"
    echo ""
    echo "  OpenClaw will discover the skill automatically on next session."
    echo "============================================"
else
    error "$ERRORS verification error(s). Check the output above."
    exit 1
fi
