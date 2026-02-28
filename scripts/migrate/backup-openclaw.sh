#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/migrate/backup-openclaw.sh [options]

Options:
  --repo-root <path>       OpenClaw repo root (default: current repo)
  --env-file <path>        Env file to include (default: <repo-root>/.env)
  --config-dir <path>      OpenClaw config dir (default: env or ~/.openclaw)
  --workspace-dir <path>   OpenClaw workspace dir (default: env or ~/.openclaw/workspace)
  --output-dir <path>      Output directory for backup archive (default: <repo-root>/backups)
  --name <name>            Backup name prefix (default: openclaw-backup-<timestamp>)
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
CONFIG_DIR=""
WORKSPACE_DIR=""
OUTPUT_DIR="$ROOT_DIR/backups"
BACKUP_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --name)
      BACKUP_NAME="$2"
      shift 2
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

require_cmd tar
require_cmd rsync
require_cmd shasum
require_cmd python3
require_cmd date
require_cmd uname

REPO_ROOT="$(resolve_abs_path "$REPO_ROOT")"
ENV_FILE="$(resolve_abs_path "$ENV_FILE")"
OUTPUT_DIR="$(resolve_abs_path "$OUTPUT_DIR")"

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

[[ -d "$CONFIG_DIR" ]] || fail "Config directory does not exist: $CONFIG_DIR"
[[ -d "$WORKSPACE_DIR" ]] || fail "Workspace directory does not exist: $WORKSPACE_DIR"
[[ -d "$REPO_ROOT" ]] || fail "Repo root does not exist: $REPO_ROOT"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="${BACKUP_NAME:-openclaw-backup-${timestamp}}"
mkdir -p "$OUTPUT_DIR"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

stage="$tmpdir/stage"
mkdir -p "$stage/payload/config" "$stage/payload/workspace" "$stage/payload/repo" "$stage/meta"

echo "==> Copying config directory"
rsync -a "$CONFIG_DIR/" "$stage/payload/config/"

echo "==> Copying workspace directory"
rsync -a "$WORKSPACE_DIR/" "$stage/payload/workspace/"

if [[ -f "$ENV_FILE" ]]; then
  echo "==> Including env file: $ENV_FILE"
  cp "$ENV_FILE" "$stage/payload/repo/.env"
fi

for file in docker-compose.yml docker-compose.extra.yml Dockerfile docker-setup.sh; do
  if [[ -f "$REPO_ROOT/$file" ]]; then
    cp "$REPO_ROOT/$file" "$stage/payload/repo/$file"
  fi
done

{
  echo "timestamp_utc=$timestamp"
  echo "source_host=$(hostname -s || hostname)"
  echo "source_arch=$(uname -m)"
  echo "source_os=$(uname -s)"
  echo "repo_root=$REPO_ROOT"
  echo "config_dir=$CONFIG_DIR"
  echo "workspace_dir=$WORKSPACE_DIR"
} >"$stage/meta/backup.env"

if command -v docker >/dev/null 2>&1; then
  {
    echo "# docker version"
    docker version --format '{{.Server.Version}}' 2>/dev/null || true
    echo
    echo "# docker compose ps"
    docker compose -f "$REPO_ROOT/docker-compose.yml" ps 2>/dev/null || true
  } >"$stage/meta/docker.txt"
fi

if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  {
    echo "branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
    echo "commit=$(git -C "$REPO_ROOT" rev-parse HEAD)"
    echo
    echo "# status"
    git -C "$REPO_ROOT" status --short
  } >"$stage/meta/git.txt"
fi

(
  cd "$stage"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS
)

archive_path="$OUTPUT_DIR/${BACKUP_NAME}.tar.gz"
(
  cd "$stage"
  tar -czf "$archive_path" .
)
shasum -a 256 "$archive_path" > "${archive_path}.sha256"

echo
echo "Backup created:"
echo "  $archive_path"
echo "  ${archive_path}.sha256"
echo
echo "Next step on target host:"
echo "  scripts/migrate/restore-openclaw.sh --archive \"$archive_path\""
