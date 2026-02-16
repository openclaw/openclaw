#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Node: $(node -v)"
echo "pnpm: $(pnpm -v)"
./scripts/no-pr-language.sh
pnpm dispatch:test:ci
