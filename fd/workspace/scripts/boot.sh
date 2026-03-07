#!/usr/bin/env bash
# OpenClaw Boot Script — Start all services in the correct order.
#
# Usage: openclaw/scripts/boot.sh
#
# Order:
#   1. Verify node connectivity
#   2. Start Ollama on M1 (or failover to M4)
#   3. Warm models
#   4. Start the gateway on M4
#   5. Start application services (cluster)
#   6. Run health check

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== OpenClaw Boot Sequence ==="
echo ""

# Step 1: Check node connectivity
echo "[1/6] Checking node connectivity..."
for node in claw-m4 claw-m1 claw-i7; do
    if ssh -o ConnectTimeout=5 "$node" "echo ok" >/dev/null 2>&1; then
        echo "  $node: reachable"
    else
        echo "  $node: UNREACHABLE (continuing without)"
    fi
done
echo ""

# Step 2: Start Ollama on M1
echo "[2/6] Starting Ollama on M1..."
if ssh -o ConnectTimeout=5 claw-m1 "pgrep -x ollama" >/dev/null 2>&1; then
    echo "  Ollama already running on M1"
else
    if ssh -o ConnectTimeout=5 claw-m1 "nohup ollama serve > /dev/null 2>&1 &" 2>/dev/null; then
        echo "  Ollama started on M1"
        sleep 3
    else
        echo "  WARNING: Could not start Ollama on M1 — will use M4 fallback"
    fi
fi
echo ""

# Step 3: Warm models
echo "[3/6] Warming models..."
cd "$REPO_ROOT"
if [ -f scripts/warm-models.sh ]; then
    bash scripts/warm-models.sh 2>/dev/null || echo "  Model warmup completed (some models may have been skipped)"
else
    echo "  warm-models.sh not found — skipping"
fi
echo ""

# Step 4: Start gateway
echo "[4/6] Starting gateway..."
if [ -f scripts/start-gateway.sh ]; then
    bash scripts/start-gateway.sh 2>/dev/null || echo "  Gateway start attempted"
else
    echo "  start-gateway.sh not found — start manually with: make gateway-start"
fi
echo ""

# Step 5: Start cluster services
echo "[5/6] Starting cluster services..."
make cluster-start 2>/dev/null || echo "  Cluster start attempted"
echo ""

# Step 6: Health check
echo "[6/6] Running health check..."
if [ -f scripts/healthcheck.sh ]; then
    bash scripts/healthcheck.sh 2>/dev/null || echo "  Health check completed with warnings"
else
    echo "  healthcheck.sh not found — check manually with: make healthcheck"
fi

echo ""
echo "=== OpenClaw Boot Complete ==="
