#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_ROOT="${OPENCLAW_HOST_ROOT:-$HOME/Documents/OpenClaw}"
CONFIG_DIR="$HOST_ROOT/.openclaw"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_ROOT:-$HOST_ROOT/workspace}"
HOME_BIND_DIR="$CONFIG_DIR/home"

sudo -v

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing dependency: $1"
  fi
}

append_compose_file_if_present() {
  local file="$1"
  if [[ -f "$file" ]]; then
    COMPOSE_ARGS+=("-f" "$file")
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose v2 is required."
fi

export OPENCLAW_CONFIG_DIR="$CONFIG_DIR"
export OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR"
export OPENCLAW_HOME_VOLUME="$HOME_BIND_DIR"

declare -a COMPOSE_ARGS=("-f" "$ROOT_DIR/docker-compose.yml")
append_compose_file_if_present "$ROOT_DIR/docker-compose.extra.yml"
append_compose_file_if_present "$ROOT_DIR/docker-compose.sandbox.yml"

echo "Stopping OpenClaw Docker services for $HOST_ROOT"
RUNNING=$(docker container ls --filter name=openclaw --quiet)
if [[ -n "$RUNNING" ]]; then
  docker container stop $RUNNING
fi
docker compose "${COMPOSE_ARGS[@]}" down -v

if [[ "${OPENCLAW_REMOVE_HOME_BIND_DIR:-0}" == "1" ]]; then
  echo "Removing persisted container home bind: $HOME_BIND_DIR"
  rm -rf "$HOME_BIND_DIR"
fi

if [ -d "${HOST_ROOT}" ]; then
  echo "Removing persisted data at:"
  echo "  $HOST_ROOT"
  sudo rm -rf $HOST_ROOT
fi

echo "Teardown complete."
