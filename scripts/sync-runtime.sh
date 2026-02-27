#!/usr/bin/env bash
# Sync local OpenClaw source checkout into the active runtime install.
#
# What it does (default, one-shot):
#   1) pnpm install
#   2) pnpm ui:build
#   3) pnpm build
#   4) pnpm link --global
#   5) openclaw doctor
#   6) openclaw gateway restart
#
# Why:
#   Source code lives in /Users/camdouglas/openclaw
#   Runtime state/workspace lives in /Users/camdouglas/.openclaw
#   This script wires code changes from source into the runtime safely.
#
# Usage:
#   scripts/sync-runtime.sh
#   scripts/sync-runtime.sh --watch
#   scripts/sync-runtime.sh --watch --interval 5 --skip-install
#   scripts/sync-runtime.sh --no-restart

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

WATCH_MODE=0
INTERVAL=3
SKIP_INSTALL=0
SKIP_UI_BUILD=0
SKIP_DOCTOR=0
RESTART_GATEWAY=1

usage() {
  cat <<'USAGE'
sync-runtime.sh — apply source changes to active OpenClaw runtime

Options:
  --watch             Keep running and auto-sync when repo state changes.
  --interval <sec>    Poll interval for --watch mode (default: 3).
  --skip-install      Skip "pnpm install".
  --skip-ui-build     Skip "pnpm ui:build".
  --skip-doctor       Skip "openclaw doctor".
  --no-restart        Do not restart gateway after sync.
  -h, --help          Show this help.
USAGE
}

log() {
  printf '[sync-runtime] %s\n' "$*"
}

fail() {
  printf '[sync-runtime] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "Missing required command: $cmd"
}

repo_fingerprint() {
  (
    cd "$REPO_ROOT"
    {
      git rev-parse HEAD 2>/dev/null || echo "no-head"
      git status --porcelain=v1 --untracked-files=normal -- . \
        ':(exclude)dist' \
        ':(exclude)node_modules' \
        ':(exclude).turbo' || true
    } | shasum -a 256 | awk '{print $1}'
  )
}

resolve_realpath() {
  local target="$1"
  node -e 'const fs=require("fs"); try { console.log(fs.realpathSync(process.argv[1])); } catch { process.exit(1); }' "$target"
}

print_runtime_summary() {
  local openclaw_bin global_root global_pkg
  openclaw_bin="$(command -v openclaw || true)"
  global_root="$(npm root -g 2>/dev/null || true)"
  global_pkg="${global_root}/openclaw"

  local repo_version="unknown"
  if [ -f "${REPO_ROOT}/package.json" ]; then
    repo_version="$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo 'unknown')"
  fi

  local global_version="unknown"
  if [ -f "${global_pkg}/package.json" ]; then
    global_version="$(node -p "require('${global_pkg}/package.json').version" 2>/dev/null || echo 'unknown')"
  fi

  log "Source root: ${REPO_ROOT}"
  log "State dir:    ${STATE_DIR}"
  log "openclaw bin: ${openclaw_bin:-not found}"
  log "Repo version: ${repo_version}"
  log "Global ver:   ${global_version}"

  if [ -n "$openclaw_bin" ] && [ -e "$openclaw_bin" ]; then
    local bin_real
    if bin_real="$(resolve_realpath "$openclaw_bin" 2>/dev/null)"; then
      log "Bin realpath: ${bin_real}"
    fi
  fi

  if [ -d "$global_pkg" ]; then
    local global_real
    if global_real="$(resolve_realpath "$global_pkg" 2>/dev/null)"; then
      log "Global pkg -> ${global_real}"
      if [ "$global_real" = "$REPO_ROOT" ]; then
        log "Link check:  OK (global install points to source root)"
      else
        log "Link check:  NOT LINKED to source root"
      fi
    fi
  fi
}

sync_once() {
  log "Starting sync"
  cd "$REPO_ROOT"

  if [ ! -f "package.json" ]; then
    fail "No package.json found at ${REPO_ROOT}; not an OpenClaw repo root."
  fi

  if [ "$SKIP_INSTALL" -eq 0 ]; then
    log "pnpm install"
    pnpm install
  else
    log "Skipping pnpm install"
  fi

  if [ "$SKIP_UI_BUILD" -eq 0 ]; then
    log "pnpm ui:build"
    pnpm ui:build
  else
    log "Skipping pnpm ui:build"
  fi

  log "pnpm build"
  pnpm build

  log "pnpm link --global"
  pnpm link --global

  if [ "$SKIP_DOCTOR" -eq 0 ]; then
    log "openclaw doctor"
    openclaw doctor
  else
    log "Skipping openclaw doctor"
  fi

  if [ "$RESTART_GATEWAY" -eq 1 ]; then
    log "openclaw gateway restart"
    openclaw gateway restart
  else
    log "Skipping gateway restart"
  fi

  print_runtime_summary
  log "Sync complete"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --watch)
      WATCH_MODE=1
      ;;
    --interval)
      shift
      [ $# -gt 0 ] || fail "--interval requires a value"
      INTERVAL="$1"
      ;;
    --skip-install)
      SKIP_INSTALL=1
      ;;
    --skip-ui-build)
      SKIP_UI_BUILD=1
      ;;
    --skip-doctor)
      SKIP_DOCTOR=1
      ;;
    --no-restart)
      RESTART_GATEWAY=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

require_cmd git
require_cmd node
require_cmd pnpm
require_cmd npm
require_cmd openclaw
require_cmd shasum

# Initial sync first.
sync_once

if [ "$WATCH_MODE" -eq 1 ]; then
  log "Watch mode enabled (interval: ${INTERVAL}s)"
  log "Watching source repo for changes and re-syncing automatically"

  last_fp="$(repo_fingerprint)"

  while true; do
    sleep "$INTERVAL"
    current_fp="$(repo_fingerprint)"
    if [ "$current_fp" != "$last_fp" ]; then
      log "Change detected; re-syncing"
      if sync_once; then
        last_fp="$(repo_fingerprint)"
      else
        log "Sync failed; will retry on next change"
      fi
    fi
  done
fi
