#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${OPENCLAW_REPO_DIR:-/opt/openclaw-itplug}"
ENV_FILE="${OPENCLAW_ENV_FILE:-.env}"
BRANCH="${OPENCLAW_GIT_BRANCH:-main}"

cd "$REPO_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not installed"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not installed"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing env file: $REPO_DIR/$ENV_FILE"
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git repo: $REPO_DIR"
  exit 1
fi

local_head="$(git rev-parse HEAD)"
git fetch --quiet origin "$BRANCH"
remote_head="$(git rev-parse "origin/$BRANCH")"

if [[ "$local_head" == "$remote_head" ]]; then
  logger -t openclaw-itplug-update "no update (head=$local_head)"
  exit 0
fi

logger -t openclaw-itplug-update "updating $local_head -> $remote_head"

git reset --hard "origin/$BRANCH"

docker compose --env-file "$ENV_FILE" pull openclaw-gateway cloudflared
docker compose --env-file "$ENV_FILE" up -d openclaw-gateway cloudflared

logger -t openclaw-itplug-update "update complete (head=$remote_head)"
