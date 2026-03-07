#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Identity-Scoped Memory E2E Tests
#
# Runs the integration test suite for the 4-plugin identity pipeline:
#   persist-user-identity → persist-postgres → auth-memory-gate → memory-graphiti
#
# Prerequisites:
#   - PostgreSQL running locally
#   - Node 22+, pnpm installed
#
# Usage:
#   ./scripts/test-identity-e2e.sh            # DB tests only (skips Zep Cloud)
#   GETZEP_API_KEY=z_... ./scripts/test-identity-e2e.sh  # Full suite with Zep
#   ./scripts/test-identity-e2e.sh --setup    # Create test DB, then run
#   ./scripts/test-identity-e2e.sh --teardown # Run, then drop test DB
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_HOST="${PGHOST:-localhost}"
DB_PORT="${PGPORT:-5432}"
DB_USER="${PGUSER:-postgres}"
DB_PASS="${PGPASSWORD:-postgres}"
DB_NAME="openclaw_test"
DB_URL="${DATABASE_URL:-postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}}"

SETUP=false
TEARDOWN=false

for arg in "$@"; do
  case "$arg" in
    --setup) SETUP=true ;;
    --teardown) TEARDOWN=true ;;
    --help|-h)
      echo "Usage: $0 [--setup] [--teardown]"
      echo ""
      echo "  --setup     Create the openclaw_test database before running tests"
      echo "  --teardown  Drop the openclaw_test database after running tests"
      echo ""
      echo "Environment variables:"
      echo "  DATABASE_URL     PostgreSQL connection (default: postgresql://postgres:postgres@localhost:5432/openclaw_test)"
      echo "  GETZEP_API_KEY   Zep Cloud API key (optional — enables memory isolation tests)"
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

if [ "$SETUP" = true ]; then
  echo "==> Creating test database: $DB_NAME"
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 \
    || PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c \
    "CREATE DATABASE $DB_NAME"
  echo "    Database ready."
fi

# ---------------------------------------------------------------------------
# Run tests
# ---------------------------------------------------------------------------

echo "==> Running identity-scoped memory E2E tests"
echo "    DATABASE_URL: ${DB_URL//:${DB_PASS}@//:***@}"
if [ -n "${GETZEP_API_KEY:-}" ]; then
  echo "    GETZEP_API_KEY: set (Zep Cloud tests enabled)"
else
  echo "    GETZEP_API_KEY: not set (Zep Cloud tests will be skipped)"
fi
echo ""

DATABASE_URL="$DB_URL" \
  pnpm vitest run \
  test/e2e/identity-memory-e2e.test.ts

EXIT_CODE=$?

# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------

if [ "$TEARDOWN" = true ]; then
  echo ""
  echo "==> Dropping test database: $DB_NAME"
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid()" > /dev/null 2>&1 || true
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c \
    "DROP DATABASE IF EXISTS $DB_NAME"
  echo "    Database dropped."
fi

exit "$EXIT_CODE"
