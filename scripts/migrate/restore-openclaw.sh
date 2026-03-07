#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/migrate/restore-openclaw.sh --archive <path> [options]

Options:
  --archive <path>         Backup archive created by backup-openclaw.sh (required)
  --repo-root <path>       OpenClaw repo root (default: current repo)
  --env-file <path>        Env file path (default: <repo-root>/.env)
  --config-dir <path>      OpenClaw config dir (default: env or ~/.openclaw)
  --workspace-dir <path>   OpenClaw workspace dir (default: env or ~/.openclaw/workspace)
  --apply-env              Overwrite --env-file with backup .env (default: false)
  --no-stop                Do not stop gateway container before restore
  -h, --help               Show this help
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

strip_quotes() {
  local value="$1"
  if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

env_value_from_file() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  local line
  line="$(grep -E "^(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  line="${line#export }"
  local value="${line#*=}"
  strip_quotes "$value"
}

resolve_abs_path() {
  local p="$1"
  python3 - "$p" <<'PY'
import os
import sys

path = sys.argv[1]
print(os.path.abspath(os.path.expanduser(path)))
PY
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$ROOT_DIR"
ENV_FILE="$ROOT_DIR/.env"
ARCHIVE_PATH=""
CONFIG_DIR=""
WORKSPACE_DIR=""
APPLY_ENV=0
STOP_FIRST=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE_PATH="$2"
      shift 2
      ;;
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --config-dir)
      CONFIG_DIR="$2"
      shift 2
      ;;
    --workspace-dir)
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --apply-env)
      APPLY_ENV=1
      shift
      ;;
    --no-stop)
      STOP_FIRST=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$ARCHIVE_PATH" ]] || fail "--archive is required"

require_cmd tar
require_cmd rsync
require_cmd shasum
require_cmd python3
require_cmd date

ARCHIVE_PATH="$(resolve_abs_path "$ARCHIVE_PATH")"
REPO_ROOT="$(resolve_abs_path "$REPO_ROOT")"
ENV_FILE="$(resolve_abs_path "$ENV_FILE")"

[[ -f "$ARCHIVE_PATH" ]] || fail "Archive not found: $ARCHIVE_PATH"
[[ -d "$REPO_ROOT" ]] || fail "Repo root does not exist: $REPO_ROOT"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "==> Extracting archive"
tar -xzf "$ARCHIVE_PATH" -C "$tmpdir"

[[ -f "$tmpdir/SHA256SUMS" ]] || fail "Archive missing SHA256SUMS"
(
  cd "$tmpdir"
  shasum -a 256 -c SHA256SUMS
)

if [[ -z "$CONFIG_DIR" ]]; then
  CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$(env_value_from_file "$ENV_FILE" OPENCLAW_CONFIG_DIR)}"
fi
if [[ -z "$WORKSPACE_DIR" ]]; then
  WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$(env_value_from_file "$ENV_FILE" OPENCLAW_WORKSPACE_DIR)}"
fi

CONFIG_DIR="${CONFIG_DIR:-$HOME/.openclaw}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
CONFIG_DIR="$(resolve_abs_path "$CONFIG_DIR")"
WORKSPACE_DIR="$(resolve_abs_path "$WORKSPACE_DIR")"

if [[ $STOP_FIRST -eq 1 ]] && command -v docker >/dev/null 2>&1; then
  echo "==> Stopping gateway container"
  docker compose -f "$REPO_ROOT/docker-compose.yml" stop openclaw-gateway >/dev/null 2>&1 || true
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$(dirname "$CONFIG_DIR")" "$(dirname "$WORKSPACE_DIR")"

if [[ -d "$CONFIG_DIR" ]]; then
  mv "$CONFIG_DIR" "${CONFIG_DIR}.pre-restore-${timestamp}"
fi
if [[ -d "$WORKSPACE_DIR" ]]; then
  mv "$WORKSPACE_DIR" "${WORKSPACE_DIR}.pre-restore-${timestamp}"
fi

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR"

echo "==> Restoring config"
rsync -a "$tmpdir/payload/config/" "$CONFIG_DIR/"

echo "==> Restoring workspace"
rsync -a "$tmpdir/payload/workspace/" "$WORKSPACE_DIR/"

if [[ -f "$tmpdir/payload/repo/.env" ]]; then
  if [[ $APPLY_ENV -eq 1 ]]; then
    mkdir -p "$(dirname "$ENV_FILE")"
    if [[ -f "$ENV_FILE" ]]; then
      cp "$ENV_FILE" "${ENV_FILE}.pre-restore-${timestamp}"
    fi
    cp "$tmpdir/payload/repo/.env" "$ENV_FILE"
    echo "==> Applied backed up env file to $ENV_FILE"
  else
    cp "$tmpdir/payload/repo/.env" "${ENV_FILE}.from-backup"
    echo "==> Wrote env candidate to ${ENV_FILE}.from-backup"
  fi
fi

source_arch="$(grep -E '^source_arch=' "$tmpdir/meta/backup.env" | cut -d= -f2- || true)"
target_arch="$(uname -m)"
if [[ -n "$source_arch" && "$source_arch" != "$target_arch" ]]; then
  echo
  echo "NOTE: source arch (${source_arch}) differs from target arch (${target_arch})."
  echo "Rebuild the Docker image on this host; do not reuse old binary caches or volumes."
fi

echo
echo "Restore completed."
echo "Next steps:"
echo "  1) docker compose -f \"$REPO_ROOT/docker-compose.yml\" up -d --build --force-recreate openclaw-gateway"
echo "  2) docker compose -f \"$REPO_ROOT/docker-compose.yml\" run --rm openclaw-cli health"
echo "  3) docker compose -f \"$REPO_ROOT/docker-compose.yml\" run --rm openclaw-cli channels status --probe"
