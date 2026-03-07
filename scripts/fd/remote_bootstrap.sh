#!/usr/bin/env bash
set -euo pipefail

# Remote bootstrap script for OpenClaw cluster nodes.
# Creates venv, installs deps, runs migrations, seeds DB.
# Idempotent — safe to run repeatedly.
#
# Usage (called by `make cluster-bootstrap`):
#   APP_DIR=~/openclaw DB_PATH=~/openclaw/data/openclaw.db bash scripts/remote_bootstrap.sh

APP_DIR="${APP_DIR:-$HOME/openclaw}"
DB_PATH="${DB_PATH:-$APP_DIR/data/openclaw.db}"
PYTHON="${PYTHON:-python3}"

echo "[remote_bootstrap] node: $(hostname)"
echo "[remote_bootstrap] app dir: $APP_DIR"
mkdir -p "$APP_DIR/data"

cd "$APP_DIR"

# Ensure venv
if [ ! -d ".venv" ]; then
  echo "[remote_bootstrap] creating venv..."
  $PYTHON -m venv .venv
fi

# Activate venv
# shellcheck disable=SC1091
source .venv/bin/activate

# Install deps (idempotent)
if [ -f "pyproject.toml" ]; then
  echo "[remote_bootstrap] installing from pyproject.toml..."
  pip install -U pip -q
  pip install -e "." -q
elif [ -f "requirements.txt" ]; then
  echo "[remote_bootstrap] installing from requirements.txt..."
  pip install -U pip -q
  pip install -r requirements.txt -q
else
  echo "[remote_bootstrap] no pyproject.toml or requirements.txt found (skipping pip install)"
fi

# Run migrations
echo "[remote_bootstrap] migrating DB..."
python -m packages.db.migrate --db "$DB_PATH" --migrations "$APP_DIR/db/migrations"

# Seed
echo "[remote_bootstrap] seeding DB..."
python -m packages.db.seed --db "$DB_PATH"

echo "[remote_bootstrap] done"
