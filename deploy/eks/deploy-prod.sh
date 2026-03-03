#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

export DEPLOY_ENV="${DEPLOY_ENV:-prod}"
export GRAFANA_BASE_URL="${GRAFANA_BASE_URL:-https://monitoring.morpho.dev}"
export GRAFANA_ALLOWED_HOST="${GRAFANA_ALLOWED_HOST:-monitoring.morpho.dev}"

exec "$ROOT_DIR/deploy/eks/deploy-dev.sh" "$@"
