#!/usr/bin/env bash
# Sync local OpenClaw source checkout into the active runtime install.
#
# What it does (default, one-shot):
#   1) pnpm install
#   2) pnpm ui:build
#   3) pnpm build
#   4) Link this repo into the active global CLI install (auto-detected: npm or pnpm)
#   5) Verify active `openclaw` now points to this repo
#   6) openclaw doctor
#   7) openclaw gateway restart
#
# Why:
#   Source code lives in your local repo checkout
#   Runtime state/workspace lives in ~/.openclaw
#   This script wires code changes from source into the runtime safely.
#
# Usage:
#   scripts/sync-runtime.sh
#   scripts/sync-runtime.sh --watch
#   scripts/sync-runtime.sh --watch --interval 5 --skip-install
#   scripts/sync-runtime.sh --link-mode npm
#   scripts/sync-runtime.sh --no-restart   # explicit opt-out only

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

WATCH_MODE=0
INTERVAL=3
SKIP_INSTALL=0
SKIP_UI_BUILD=0
SKIP_BUILD=0
SKIP_DOCTOR=0
RESTART_GATEWAY=1
SKIP_LINK=0
VERIFY_LINK=1
LINK_MODE="auto" # auto|npm|pnpm|both
ENFORCE_SHAREABLE_POLICY=1
ALLOW_PERSONAL_DETAILS=0

# Shareable-repo policy:
# - Root repo (potential GitHub source) must stay free of personal/operator details.
# - Runtime state/worktree (~/.openclaw) may contain personal details.
# - Deny by default for non-allowlisted changed paths.
# - Fail-safe on uncertain matches (block and report).

usage() {
  cat <<'USAGE'
sync-runtime.sh — apply source changes to active OpenClaw runtime

Options:
  --watch                 Keep running and auto-sync when repo state changes.
  --interval <sec>        Poll interval for --watch mode (default: 3).
  --skip-install          Skip "pnpm install".
  --skip-ui-build         Skip "pnpm ui:build".
  --skip-build            Skip "pnpm build".
  --skip-link             Skip global link step.
  --link-mode <mode>      Link mode: auto|npm|pnpm|both (default: auto).
  --no-verify-link        Skip active-link verification.
  --no-shareable-policy   Disable root-repo personal-details policy gate.
  --allow-personal-details
                          Override policy gate (not recommended; use only intentionally).
  --skip-doctor           Skip "openclaw doctor".
  --no-restart            Do not restart gateway after sync (explicit opt-out).
  -h, --help              Show this help.
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

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

escape_regex() {
  local value="$1"
  printf '%s' "$value" | sed -E 's/[][(){}.^$*+?|\\/-]/\\&/g'
}

resolve_operator_identifiers() {
  local identifiers=()
  local seen=()
  local raw_csv="${OPENCLAW_OPERATOR_IDENTIFIERS:-}"
  if [ -n "$raw_csv" ]; then
    IFS=',' read -r -a custom_parts <<<"$raw_csv"
    for part in "${custom_parts[@]}"; do
      local trimmed
      trimmed="$(trim_whitespace "$part")"
      if [ -n "$trimmed" ]; then
        identifiers+=("$trimmed")
      fi
    done
  fi

  local user_guess
  user_guess="${USER:-}"
  [ -n "$user_guess" ] || user_guess="${LOGNAME:-}"
  [ -n "$user_guess" ] || user_guess="$(id -un 2>/dev/null || true)"
  if [ -n "$user_guess" ]; then
    identifiers+=("$user_guess")
  fi

  local full_name
  full_name="$(id -F 2>/dev/null || true)"
  full_name="$(trim_whitespace "$full_name")"
  if [ -n "$full_name" ] && [ "$full_name" != "$user_guess" ]; then
    identifiers+=("$full_name")
  fi

  for ident in "${identifiers[@]}"; do
    local normalized
    normalized="$(printf '%s' "$ident" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$normalized" ]; then
      continue
    fi
    local duplicate=0
    for existing in "${seen[@]}"; do
      if [ "$existing" = "$normalized" ]; then
        duplicate=1
        break
      fi
    done
    if [ "$duplicate" -eq 0 ]; then
      seen+=("$normalized")
    fi
  done

  printf '%s\n' "${seen[@]}"
}

is_shareable_repo_path() {
  local path="$1"
  case "$path" in
    src/*|docs/*|scripts/*|test/*|ui/*|apps/*|extensions/*|packages/*|assets/*|changelog/*|.github/*)
      return 0
      ;;
    AGENTS.md|CLAUDE.md|CHANGELOG.md|CONTRIBUTING.md|README.md|SECURITY.md|LICENSE|VISION.md|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig.json|tsconfig.*.json|tsdown.config.ts|vitest*.ts|Dockerfile|Dockerfile.*|docker-compose.yml|render.yaml|fly.toml|fly.private.toml|openclaw.mjs|zizmor.yml)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

collect_changed_repo_paths() {
  (
    cd "$REPO_ROOT"
    {
      git diff --name-only --relative HEAD -- . \
        ':(exclude)dist' \
        ':(exclude)node_modules' \
        ':(exclude).turbo' || true
      git ls-files --others --exclude-standard -- . \
        ':(exclude)dist' \
        ':(exclude)node_modules' \
        ':(exclude).turbo' || true
    } | awk 'NF' | sort -u
  )
}

append_report_line() {
  local report_file="$1"
  local severity="$2"
  local path="$3"
  local reason="$4"
  printf '  - [%s] %s: %s\n' "$severity" "$path" "$reason" >>"$report_file"
}

scan_file_for_pattern() {
  local pattern="$1"
  local path="$2"
  grep -n -i -E -m 1 -- "$pattern" "$path" 2>/dev/null || true
}

enforce_shareable_repo_policy() {
  if [ "$ENFORCE_SHAREABLE_POLICY" -eq 0 ]; then
    log "Shareable-repo policy: disabled"
    return 0
  fi
  if [ "$ALLOW_PERSONAL_DETAILS" -eq 1 ]; then
    log "Shareable-repo policy: overridden via --allow-personal-details"
    return 0
  fi

  local changed
  changed="$(collect_changed_repo_paths)"
  if [ -z "$changed" ]; then
    log "Shareable-repo policy: no changed paths to scan"
    return 0
  fi

  local report_file
  report_file="$(mktemp)"
  local violations=0

  local primary_user
  primary_user="${USER:-${LOGNAME:-}}"
  primary_user="$(trim_whitespace "$primary_user")"
  local user_escaped=""
  if [ -n "$primary_user" ]; then
    user_escaped="$(escape_regex "$primary_user")"
  fi

  local home_escaped
  home_escaped="$(escape_regex "$HOME")"
  local identifiers
  identifiers="$(resolve_operator_identifiers)"

  while IFS= read -r path; do
    [ -n "$path" ] || continue

    if ! is_shareable_repo_path "$path"; then
      append_report_line "$report_file" "block" "$path" "path not in shareable allowlist (fail-safe)"
      violations=$((violations + 1))
      continue
    fi

    local abs_path="${REPO_ROOT}/${path}"
    if [ ! -e "$abs_path" ] || [ ! -f "$abs_path" ]; then
      continue
    fi
    if ! grep -Iq . "$abs_path" 2>/dev/null; then
      continue
    fi

    # Hard-sensitive patterns.
    local hit
    hit="$(scan_file_for_pattern '(BEGIN[[:space:]]+(RSA|OPENSSH|EC)[[:space:]]+PRIVATE[[:space:]]+KEY|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})' "$abs_path")"
    if [ -n "$hit" ]; then
      append_report_line "$report_file" "block" "$path" "possible secret/token/private-key pattern"
      violations=$((violations + 1))
    fi

    hit="$(scan_file_for_pattern '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})' "$abs_path")"
    if [ -n "$hit" ] && ! printf '%s\n' "$hit" | grep -Eiq '@(example\.com|example\.org|example\.net)\b'; then
      append_report_line "$report_file" "block" "$path" "possible email/contact detail"
      violations=$((violations + 1))
    fi

    local user_path_pat=""
    if [ -n "$user_escaped" ]; then
      user_path_pat="|/Users/${user_escaped}(/|$)|/home/${user_escaped}(/|$)"
    fi
    hit="$(scan_file_for_pattern "(${home_escaped}${user_path_pat})" "$abs_path")"
    if [ -n "$hit" ]; then
      append_report_line "$report_file" "block" "$path" "possible private local path/hostname context"
      violations=$((violations + 1))
    fi

    # Preference/persona patterns (fail-safe review block).
    # Skip this script itself to avoid matching policy regex literals.
    if [ "$path" != "scripts/sync-runtime.sh" ]; then
      hit="$(scan_file_for_pattern '(my name is|call me[[:space:]]+[A-Za-z]|i prefer[[:space:]]+[A-Za-z]|operator name is|personal(ized)? persona|my preferred tone|my writing style)' "$abs_path")"
      if [ -n "$hit" ]; then
        append_report_line "$report_file" "block" "$path" "possible personal preference/persona customization"
        violations=$((violations + 1))
      fi
    fi

    if [ -n "$identifiers" ]; then
      while IFS= read -r ident; do
        [ -n "$ident" ] || continue
        if [ "${#ident}" -lt 3 ]; then
          continue
        fi
        local ident_pat
        ident_pat="$(escape_regex "$ident")"
        hit="$(scan_file_for_pattern "\\b${ident_pat}\\b" "$abs_path")"
        if [ -n "$hit" ]; then
          append_report_line "$report_file" "block" "$path" "possible operator identity marker (${ident})"
          violations=$((violations + 1))
          break
        fi
      done <<<"$identifiers"
    fi
  done <<<"$changed"

  if [ "$violations" -gt 0 ]; then
    log "Shareable-repo policy violations found:"
    cat "$report_file"
    rm -f "$report_file"
    fail "Policy gate blocked sync to protect shareable repo. Remove/personalize into ~/.openclaw only, or rerun with --allow-personal-details if intentional."
  fi
  rm -f "$report_file"
  log "Shareable-repo policy: OK"
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

active_openclaw_package_dir() {
  local openclaw_bin bin_real
  openclaw_bin="$(command -v openclaw || true)"
  [ -n "$openclaw_bin" ] || return 1
  [ -e "$openclaw_bin" ] || return 1
  bin_real="$(resolve_realpath "$openclaw_bin")"
  case "$bin_real" in
    */openclaw.mjs)
      dirname "$bin_real"
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_link_mode_auto() {
  local npm_root pnpm_root npm_pkg pnpm_pkg
  local npm_real="" pnpm_real="" active_pkg=""

  npm_root="$(npm root -g 2>/dev/null || true)"
  pnpm_root="$(pnpm root -g 2>/dev/null || true)"
  npm_pkg="${npm_root}/openclaw"
  pnpm_pkg="${pnpm_root}/openclaw"

  if [ -d "$npm_pkg" ]; then
    npm_real="$(resolve_realpath "$npm_pkg" 2>/dev/null || true)"
  fi
  if [ -d "$pnpm_pkg" ]; then
    pnpm_real="$(resolve_realpath "$pnpm_pkg" 2>/dev/null || true)"
  fi
  active_pkg="$(active_openclaw_package_dir 2>/dev/null || true)"

  if [ -n "$active_pkg" ] && [ -n "$npm_real" ] && [ "$active_pkg" = "$npm_real" ]; then
    echo "npm"
    return 0
  fi
  if [ -n "$active_pkg" ] && [ -n "$pnpm_real" ] && [ "$active_pkg" = "$pnpm_real" ]; then
    echo "pnpm"
    return 0
  fi

  # Fallback heuristic if active package dir isn't directly resolvable against known globals.
  if [ -n "$active_pkg" ]; then
    case "$active_pkg" in
      *"/Library/pnpm/"*)
        echo "pnpm"
        return 0
        ;;
      *"/node_modules/openclaw")
        echo "npm"
        return 0
        ;;
    esac
  fi

  echo "both"
}

link_runtime() {
  local mode="$LINK_MODE"
  if [ "$mode" = "auto" ]; then
    mode="$(resolve_link_mode_auto)"
  fi

  log "Link mode: ${mode}"

  case "$mode" in
    npm)
      log "npm link"
      npm link
      ;;
    pnpm)
      log "pnpm link --global"
      pnpm link --global
      ;;
    both)
      # Do npm first to prioritize Homebrew/npm installs commonly used on macOS.
      log "npm link"
      npm link
      log "pnpm link --global"
      pnpm link --global
      ;;
    *)
      fail "Invalid link mode: ${mode} (expected auto|npm|pnpm|both)"
      ;;
  esac
}

verify_active_link() {
  local active_pkg=""
  active_pkg="$(active_openclaw_package_dir 2>/dev/null || true)"
  [ -n "$active_pkg" ] || fail "Unable to resolve active openclaw package directory"

  if [ "$active_pkg" != "$REPO_ROOT" ]; then
    fail "Active openclaw package is '${active_pkg}', not '${REPO_ROOT}'. Re-run with --link-mode npm or --link-mode pnpm."
  fi

  log "Link verification: OK (active openclaw points to source root)"
}

print_runtime_summary() {
  local openclaw_bin npm_root pnpm_root npm_pkg pnpm_pkg
  openclaw_bin="$(command -v openclaw || true)"
  npm_root="$(npm root -g 2>/dev/null || true)"
  pnpm_root="$(pnpm root -g 2>/dev/null || true)"
  npm_pkg="${npm_root}/openclaw"
  pnpm_pkg="${pnpm_root}/openclaw"

  local repo_version="unknown"
  if [ -f "${REPO_ROOT}/package.json" ]; then
    repo_version="$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo 'unknown')"
  fi

  local npm_version="n/a"
  if [ -f "${npm_pkg}/package.json" ]; then
    npm_version="$(node -p "require('${npm_pkg}/package.json').version" 2>/dev/null || echo 'unknown')"
  fi

  local pnpm_version="n/a"
  if [ -f "${pnpm_pkg}/package.json" ]; then
    pnpm_version="$(node -p "require('${pnpm_pkg}/package.json').version" 2>/dev/null || echo 'unknown')"
  fi

  log "Source root:     ${REPO_ROOT}"
  log "State dir:       ${STATE_DIR}"
  log "openclaw bin:    ${openclaw_bin:-not found}"
  log "Repo version:    ${repo_version}"
  log "npm global ver:  ${npm_version}"
  log "pnpm global ver: ${pnpm_version}"

  if [ -n "$openclaw_bin" ] && [ -e "$openclaw_bin" ]; then
    local bin_real
    if bin_real="$(resolve_realpath "$openclaw_bin" 2>/dev/null)"; then
      log "Bin realpath:    ${bin_real}"
    fi
  fi

  if [ -d "$npm_pkg" ]; then
    local npm_real
    if npm_real="$(resolve_realpath "$npm_pkg" 2>/dev/null)"; then
      log "npm pkg ->       ${npm_real}"
    fi
  fi

  if [ -d "$pnpm_pkg" ]; then
    local pnpm_real
    if pnpm_real="$(resolve_realpath "$pnpm_pkg" 2>/dev/null)"; then
      log "pnpm pkg ->      ${pnpm_real}"
    fi
  fi
}

sync_once() {
  log "Starting sync"
  cd "$REPO_ROOT"

  if [ ! -f "package.json" ]; then
    fail "No package.json found at ${REPO_ROOT}; not an OpenClaw repo root."
  fi

  enforce_shareable_repo_policy

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

  if [ "$SKIP_BUILD" -eq 0 ]; then
    log "pnpm build"
    pnpm build
  else
    log "Skipping pnpm build"
  fi

  if [ "$SKIP_LINK" -eq 0 ]; then
    link_runtime
  else
    log "Skipping link step"
  fi

  if [ "$VERIFY_LINK" -eq 1 ] && [ "$SKIP_LINK" -eq 0 ]; then
    verify_active_link
  fi

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
    --skip-build)
      SKIP_BUILD=1
      ;;
    --skip-link)
      SKIP_LINK=1
      ;;
    --link-mode)
      shift
      [ $# -gt 0 ] || fail "--link-mode requires a value"
      LINK_MODE="$1"
      ;;
    --no-verify-link)
      VERIFY_LINK=0
      ;;
    --no-shareable-policy)
      ENFORCE_SHAREABLE_POLICY=0
      ;;
    --allow-personal-details)
      ALLOW_PERSONAL_DETAILS=1
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
