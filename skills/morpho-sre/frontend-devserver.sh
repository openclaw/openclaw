#!/usr/bin/env bash
set -euo pipefail

# Manage local dev servers for Morpho frontend apps.
# Clones repos via repo-clone.sh, installs deps, starts/stops dev servers.

# Resolve symlinks so SCRIPT_DIR is the real skill root, not the scripts/ symlink dir.
_source="${BASH_SOURCE[0]}"
while [[ -L "$_source" ]]; do
  _dir="$(cd "$(dirname "$_source")" && pwd)"
  _source="$(readlink "$_source")"
  [[ "$_source" != /* ]] && _source="$_dir/$_source"
done
SCRIPT_DIR="$(cd "$(dirname "$_source")" && pwd)"
REPO_CLONE="${SCRIPT_DIR}/scripts/repo-clone.sh"
STATE_DIR="${STATE_DIR:-/tmp/openclaw-devserver}"
DEST_ROOT="${DEST_ROOT:-/home/node/.openclaw/repos}"

# Redirect pnpm/corepack/npm caches to writable paths.
# The gateway container runs with readOnlyRootFilesystem; only
# /home/node/.openclaw (PVC) and /tmp (emptyDir) are writable.
export PNPM_HOME="${PNPM_HOME:-/home/node/.openclaw/pnpm-store}"
export PNPM_STORE_DIR="${PNPM_STORE_DIR:-/home/node/.openclaw/pnpm-store/store}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/pnpm-cache}"
export COREPACK_HOME="${COREPACK_HOME:-/tmp/corepack}"
export npm_config_cache="${npm_config_cache:-/tmp/npm-cache}"

die() {
  printf 'frontend-devserver: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

# App key -> "repo|workspace_path|default_port"
# Uses a case statement instead of associative arrays for bash 3 compat.
ALL_APP_KEYS="consumer-app curator-app curator-v2-app delegate-app liquidation-app markets-v2-app ui-app"

# Ports match the hardcoded values in prime-monorepo workspace scripts.
# Only consumer-app (Next.js) honors the PORT env var for overrides.
lookup_app() {
  case "$1" in
    curator-app)       echo "morpho-org/prime-monorepo|apps/curator-app|4040" ;;
    curator-v2-app)    echo "morpho-org/prime-monorepo|apps/curator-v2-app|3060" ;;
    delegate-app)      echo "morpho-org/prime-monorepo|apps/delegate-app|3030" ;;
    liquidation-app)   echo "morpho-org/prime-monorepo|apps/liquidation-app|3050" ;;
    markets-v2-app)    echo "morpho-org/prime-monorepo|apps/markets-v2-app|3080" ;;
    ui-app)            echo "morpho-org/prime-monorepo|apps/ui-app|3090" ;;
    consumer-app)      echo "morpho-org/consumer-monorepo|.|3000" ;;
    *) return 1 ;;
  esac
}

get_repo()      { lookup_app "$1" | cut -d'|' -f1; }
get_workspace() { lookup_app "$1" | cut -d'|' -f2; }
get_port()      { lookup_app "$1" | cut -d'|' -f3; }

usage() {
  cat <<'EOF'
Usage:
  frontend-devserver.sh start <app-key> [--port <port>] [--env-file <path>]
  frontend-devserver.sh stop <app-key>
  frontend-devserver.sh status [<app-key>]
  frontend-devserver.sh list

App keys:
  consumer-app, curator-app, curator-v2-app, delegate-app,
  liquidation-app, markets-v2-app, ui-app

Options:
  --port       Override the default dev server port (consumer-app only;
               prime-monorepo apps hardcode their ports).
  --env-file   Path to .env file to source before starting the dev server.
EOF
}

validate_app_key() {
  lookup_app "$1" >/dev/null 2>&1 || die "unknown app key: $1 (valid: ${ALL_APP_KEYS})"
}

cmd_list() {
  printf '%-20s %-35s %s\n' "APP KEY" "REPO" "PORT"
  for key in $ALL_APP_KEYS; do
    printf '%-20s %-35s %s\n' "$key" "$(get_repo "$key")" "$(get_port "$key")"
  done
}

cmd_start() {
  local app_key=""
  local port=""
  local env_file=""
  local port_from_flag=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)    [[ -n "${2:-}" ]] || die "--port requires a value"; port="$2"; port_from_flag=1; shift 2 ;;
      --env-file) [[ -n "${2:-}" ]] || die "--env-file requires a value"; env_file="$2"; shift 2 ;;
      -*)        die "unknown option: $1" ;;
      *)
        if [[ -z "$app_key" ]]; then
          app_key="$1"; shift
        else
          die "unexpected argument: $1"
        fi
        ;;
    esac
  done

  [[ -n "$app_key" ]] || die "app key required"
  validate_app_key "$app_key"

  local repo workspace
  repo="$(get_repo "$app_key")"
  workspace="$(get_workspace "$app_key")"
  port="${port:-$(get_port "$app_key")}"
  [[ "$port" =~ ^[0-9]+$ ]] || die "port must be numeric: $port"
  (( port >= 1 && port <= 65535 )) || die "port out of range (1-65535): $port"

  # prime-monorepo apps hardcode their port; reject --port override to avoid
  # a readiness-check mismatch that silently times out after 120s.
  if [[ -n "${port_from_flag:-}" && "$workspace" != "." ]]; then
    die "--port is only supported for consumer-app (prime-monorepo apps hardcode their ports)"
  fi

  # Check if already running.
  local state_file="${STATE_DIR}/${app_key}.json"
  if [[ -f "$state_file" ]]; then
    local existing_pid
    existing_pid="$(jq -r '.pid' "$state_file" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      local existing_url
      existing_url="$(jq -r '.url' "$state_file" 2>/dev/null || true)"
      printf 'url=%s\n' "$existing_url"
      exit 0
    fi
    # Stale state file, clean up.
    rm -f "$state_file"
  fi

  require_cmd pnpm
  require_cmd curl
  require_cmd jq

  # Clone/update the repo.
  printf 'frontend-devserver: cloning/updating %s\n' "$repo" >&2
  if [[ ! -f "$REPO_CLONE" ]]; then
    die "repo-clone.sh not found at $REPO_CLONE"
  fi
  local clone_output
  clone_output="$(bash "$REPO_CLONE" --repo "$repo" --dest-root "$DEST_ROOT" 2>&1)" || die "repo-clone failed: $clone_output"

  # Extract the clone path from repo-clone.sh output (path=<dest>).
  local repo_path=""
  repo_path="$(printf '%s' "$clone_output" | grep '^path=' | head -1 | cut -d= -f2-)"
  if [[ -z "$repo_path" ]]; then
    printf 'frontend-devserver: WARNING: repo-clone.sh did not emit path=, falling back to %s\n' "${DEST_ROOT}/${repo}" >&2
    repo_path="${DEST_ROOT}/${repo}"
  fi

  [[ -d "$repo_path" ]] || die "repo directory not found: $repo_path"

  # Source env file if provided.
  if [[ -n "$env_file" ]]; then
    [[ -f "$env_file" ]] || die "env file not found: $env_file"
    # shellcheck disable=SC1090
    set -a; source "$env_file"; set +a
  fi

  # Install dependencies.
  printf 'frontend-devserver: installing dependencies\n' >&2
  (
    cd "$repo_path"
    pnpm install --frozen-lockfile 2>&1 || {
      printf 'frontend-devserver: frozen-lockfile failed, retrying with mutable install\n' >&2
      pnpm install
    }
  ) >&2 || die "pnpm install failed in $repo_path"

  # Start dev server.
  mkdir -p "$STATE_DIR"
  local log_file="${STATE_DIR}/${app_key}.log"

  printf 'frontend-devserver: starting %s on port %s\n' "$app_key" "$port" >&2
  (
    cd "$repo_path"
    if [[ "$workspace" == "." ]]; then
      # consumer-monorepo (Next.js) honors PORT env var.
      PORT="$port" pnpm dev
    else
      # prime-monorepo apps hardcode ports in workspace scripts;
      # PORT env var is ignored. The default port in lookup_app
      # matches the hardcoded value so the readiness check works.
      pnpm --filter "$app_key" dev
    fi
  ) > "$log_file" 2>&1 &
  local pid=$!

  # Write state.
  local url="http://127.0.0.1:${port}"
  jq -n \
    --arg pid "$pid" \
    --arg port "$port" \
    --arg url "$url" \
    --arg app_key "$app_key" \
    --arg repo "$repo" \
    '{pid: ($pid | tonumber), port: ($port | tonumber), url: $url, app_key: $app_key, repo: $repo}' \
    > "$state_file"

  # Wait for dev server to become ready.
  printf 'frontend-devserver: waiting for %s to be ready\n' "$url" >&2
  local attempts=0
  local max_attempts=60
  while [[ $attempts -lt $max_attempts ]]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$state_file"
      die "dev server process exited unexpectedly (check $log_file)"
    fi
    # Accept any HTTP response (even 4xx/5xx) as "ready" — dev servers
    # may return non-200 during startup (e.g., Next.js 500 while compiling).
    if curl -sS --max-time 2 -o /dev/null "$url" 2>/dev/null; then
      printf 'url=%s\n' "$url"
      exit 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done

  # Log last curl error for diagnostics before cleanup.
  printf 'frontend-devserver: last curl attempt:\n' >&2
  curl -sS --max-time 2 "$url" >&2 2>&1 || true

  # Clean up on timeout: kill the process and remove stale state so the next
  # start call doesn't take the fast path with a poisoned URL.
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  sleep 1
  rm -f "$state_file"
  die "dev server did not become ready within 120s (check $log_file)"
}

cmd_stop() {
  local app_key="${1:-}"
  [[ -n "$app_key" ]] || die "app key required"
  validate_app_key "$app_key"

  local state_file="${STATE_DIR}/${app_key}.json"
  if [[ ! -f "$state_file" ]]; then
    printf 'frontend-devserver: %s is not running\n' "$app_key" >&2
    exit 0
  fi

  local pid
  pid="$(jq -r '.pid' "$state_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    # Kill child processes first (node workers, dev server), then the parent.
    # Non-interactive bash doesn't create new process groups for background jobs,
    # so kill -- -$pid won't work; use pkill -P to target children by parent PID.
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    # Wait for process to exit and release the port (up to 3s).
    local w; for w in 1 2 3 4 5 6; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    printf 'frontend-devserver: stopped %s (pid %s)\n' "$app_key" "$pid" >&2
  else
    printf 'frontend-devserver: %s was not running (stale state)\n' "$app_key" >&2
  fi

  rm -f "$state_file" "${STATE_DIR}/${app_key}.log"
}

cmd_status() {
  local filter_key="${1:-}"
  mkdir -p "$STATE_DIR"

  if [[ -n "$filter_key" ]]; then
    validate_app_key "$filter_key"
  fi

  printf '%-20s %-8s %-6s %-30s %s\n' "APP KEY" "PID" "PORT" "URL" "STATUS"
  for state_file in "$STATE_DIR"/*.json; do
    [[ -f "$state_file" ]] || continue

    local app_key pid port url status
    app_key="$(jq -r '.app_key' "$state_file" 2>/dev/null || true)"
    pid="$(jq -r '.pid' "$state_file" 2>/dev/null || true)"
    port="$(jq -r '.port' "$state_file" 2>/dev/null || true)"
    url="$(jq -r '.url' "$state_file" 2>/dev/null || true)"

    if [[ -n "$filter_key" && "$app_key" != "$filter_key" ]]; then
      continue
    fi

    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      if curl -sS --max-time 1 "$url" >/dev/null 2>&1; then
        status="running"
      else
        status="starting"
      fi
    else
      status="dead"
    fi

    printf '%-20s %-8s %-6s %-30s %s\n' "$app_key" "$pid" "$port" "$url" "$status"
  done
}

# ── main ──
case "${1:-}" in
  start)  shift; cmd_start "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  list)   cmd_list ;;
  -h|--help) usage ;;
  *)
    if [[ -z "${1:-}" ]]; then
      usage
    else
      die "unknown command: $1"
    fi
    ;;
esac
