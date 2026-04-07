#!/bin/bash
# Daily news pipeline runner
# Usage: ./scripts/run-news.sh
# Add to cron: 0 8 * * * /path/to/extensions/content-pipeline/scripts/run-news.sh

set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
PIPELINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$PIPELINE_DIR"

# Load env
set -a
source .env 2>/dev/null || true
set +a

echo "$(date) — Starting news pipeline..."
npx tsx src/cli.ts run news --skip-upload 2>&1

echo "$(date) — Pipeline complete!"
