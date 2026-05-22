#!/usr/bin/env bash
# OpenClaw fork — install / upgrade from source (lxf-lxf/openclaw)
#
#   curl -fsSL https://raw.githubusercontent.com/lxf-lxf/openclaw/main/scripts/fork-upgrade.sh | bash
#   ./scripts/fork-upgrade.sh --install-dir ~/Projects/openclaw --restart-gateway
#
set -euo pipefail

REPO_URL="${OPENCLAW_FORK_REPO:-https://github.com/lxf-lxf/openclaw.git}"
BRANCH="${OPENCLAW_FORK_BRANCH:-main}"
INSTALL_DIR="${OPENCLAW_FORK_DIR:-}"
PACKAGE_MANAGER="${OPENCLAW_FORK_PM:-auto}"
SKIP_PULL=0
NO_LINK=0
NO_UI_BUILD=0
RESTART_GATEWAY=0
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

usage() {
  cat <<'EOF'
Usage: fork-upgrade.sh [options]

  --repo URL           Git remote (default: lxf-lxf/openclaw)
  --branch NAME        Branch (default: main)
  --install-dir PATH   Checkout directory (default: ~/Projects/openclaw)
  --pm npm|pnpm|auto   Package manager (default: auto)
  --skip-pull          Do not git pull when directory exists
  --no-link            Skip npm link
  --no-ui-build        Skip ui:build
  --restart-gateway    Stop/start gateway on GATEWAY_PORT
  -h, --help

Env: OPENCLAW_FORK_REPO, OPENCLAW_FORK_DIR, OPENCLAW_FORK_PM, OPENCLAW_GATEWAY_PORT
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --pm) PACKAGE_MANAGER="$2"; shift 2 ;;
    --skip-pull) SKIP_PULL=1; shift ;;
    --no-link) NO_LINK=1; shift ;;
    --no-ui-build) NO_UI_BUILD=1; shift ;;
    --restart-gateway) RESTART_GATEWAY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

step() { printf '\n\033[36m>> %s\033[0m\n' "$*"; }
ok() { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$*"; }

assert_node() {
  command -v node >/dev/null 2>&1 || { echo "Node.js required (22.19+)" >&2; exit 1; }
  local major minor
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1] || "0"')"
  if [[ "$major" -lt 22 ]] || { [[ "$major" -eq 22 ]] && [[ "$minor" -lt 19 ]]; }; then
    echo "Node $(node -v) is too old; need 22.19+" >&2
    exit 1
  fi
  ok "Node $(node -v)"
}

resolve_install_dir() {
  if [[ -n "$INSTALL_DIR" ]]; then
    printf '%s' "$INSTALL_DIR"
    return
  fi
  if [[ -d "$HOME/Projects" ]]; then
    printf '%s' "$HOME/Projects/openclaw"
    return
  fi
  if [[ -d "$HOME/Developer" ]]; then
    printf '%s' "$HOME/Developer/openclaw"
    return
  fi
  printf '%s' "$HOME/openclaw"
}

resolve_pm() {
  local root="$1"
  case "$PACKAGE_MANAGER" in
    npm|pnpm) printf '%s' "$PACKAGE_MANAGER"; return ;;
    auto)
      if command -v pnpm >/dev/null 2>&1 && [[ -f "$root/pnpm-lock.yaml" ]]; then
        printf 'pnpm'
      else
        printf 'npm'
      fi
      ;;
    *) echo "Invalid --pm: $PACKAGE_MANAGER" >&2; exit 1 ;;
  esac
}

run_pm() {
  local pm="$1" root="$2"
  shift 2
  (cd "$root" && if [[ "$pm" == pnpm ]]; then pnpm "$@"; else npm "$@"; fi)
}

stop_gateway() {
  local port="$1"
  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    if ps -p "$pid" -o args= 2>/dev/null | grep -q "openclaw.mjs gateway.*--port ${port}"; then
      warn "Stopping gateway PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done < <(pgrep -f "openclaw.mjs gateway" 2>/dev/null || true)
}

start_gateway() {
  local root="$1" port="$2"
  (cd "$root" && nohup node openclaw.mjs gateway --port "$port" >/dev/null 2>&1 &)
  sleep 5
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS -o /dev/null "http://127.0.0.1:${port}/" 2>/dev/null; then
      ok "Gateway http://127.0.0.1:${port}/"
    else
      warn "Gateway process started; HTTP check failed"
    fi
  fi
}

printf '\n\033[36m  OpenClaw fork install / upgrade\033[0m\n'
printf '  Repo: %s (%s)\n\n' "$REPO_URL" "$BRANCH"

assert_node
DIR="$(resolve_install_dir)"
step "Target directory: $DIR"

if [[ -d "$DIR/.git" ]]; then
  if [[ "$SKIP_PULL" -eq 0 ]]; then
    step "git pull"
    (cd "$DIR" && git fetch origin "$BRANCH" && git checkout "$BRANCH" && git pull --ff-only origin "$BRANCH")
  fi
elif [[ -e "$DIR" ]]; then
  echo "Directory exists but is not a git repo: $DIR" >&2
  exit 1
else
  step "git clone"
  mkdir -p "$(dirname "$DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$DIR"
fi

PM="$(resolve_pm "$DIR")"
step "$PM install"
run_pm "$PM" "$DIR" install

step "$PM run build"
run_pm "$PM" "$DIR" run build

if [[ "$NO_UI_BUILD" -eq 0 ]]; then
  step "$PM run ui:build"
  run_pm "$PM" "$DIR" run ui:build
fi

if [[ "$NO_LINK" -eq 0 ]]; then
  step "npm link"
  (cd "$DIR" && npm link)
fi

VER="$(cd "$DIR" && node openclaw.mjs --version 2>/dev/null | tr -d '\r')"
ok "Installed: $VER"
printf '     Path: %s\n' "$DIR"

if [[ "$RESTART_GATEWAY" -eq 1 ]]; then
  step "Restart gateway on port $GATEWAY_PORT"
  stop_gateway "$GATEWAY_PORT"
  sleep 2
  start_gateway "$DIR" "$GATEWAY_PORT"
fi

printf '\nNext:\n'
printf '  openclaw config validate\n'
printf '  openclaw gateway --port %s\n' "$GATEWAY_PORT"
printf '  docs/automation/cron-acp-quickstart.md\n\n'
