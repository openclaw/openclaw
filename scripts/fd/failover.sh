#!/usr/bin/env bash
# Failover script — promotes M4 to handle M1's workload
# Run when M1 Mac Studio is unreachable
set -euo pipefail

M1_HOST="${OLLAMA_PRIMARY_HOST:-http://10.0.0.145:11434}"
M4_HOST="claw-m4"
M4_OLLAMA="${OLLAMA_FALLBACK_HOST:-http://10.0.0.10:11434}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "═══════════════════════════════════════════════════"
echo " OpenClaw Failover Check"
echo " $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "═══════════════════════════════════════════════════"

# Check M1 status
echo ""
echo -n "Checking M1 Mac Studio... "
if curl -sf "$M1_HOST/api/tags" >/dev/null 2>&1; then
    echo -e "${GREEN}ONLINE${NC}"
    echo "M1 is healthy. No failover needed."
    exit 0
fi

echo -e "${RED}OFFLINE${NC}"
echo ""
echo -e "${YELLOW}M1 is unreachable. Initiating failover to M4.${NC}"
echo ""

# Step 1: Verify M4 is healthy
echo -n "Step 1: Verifying M4 is healthy... "
if ! ssh -o ConnectTimeout=3 "$M4_HOST" 'echo ok' &>/dev/null; then
    echo -e "${RED}M4 ALSO UNREACHABLE. Manual intervention required.${NC}"
    exit 1
fi
echo -e "${GREEN}OK${NC}"

# Step 2: Start Ollama on M4 if not running
echo -n "Step 2: Checking Ollama on M4... "
if curl -sf "$M4_OLLAMA/api/tags" >/dev/null 2>&1; then
    echo -e "${GREEN}already running${NC}"
else
    echo "starting..."
    ssh "$M4_HOST" 'nohup ollama serve &>/dev/null &' 2>/dev/null
    sleep 3
    if curl -sf "$M4_OLLAMA/api/tags" >/dev/null 2>&1; then
        echo -e "  ${GREEN}Ollama started on M4${NC}"
    else
        echo -e "  ${RED}Failed to start Ollama on M4${NC}"
        exit 1
    fi
fi

# Step 3: Pull/warm primary model on M4
echo "Step 3: Warming models on M4..."
for model in "qwen3.5:4b" "qwen3.5:2b"; do
    echo -n "  $model... "
    curl -sf "$M4_OLLAMA/api/generate" \
        -d "{\"model\": \"$model\", \"prompt\": \"hi\", \"stream\": false}" >/dev/null 2>&1 \
        && echo -e "${GREEN}OK${NC}" \
        || echo -e "${YELLOW}WARN (may need pull)${NC}"
done

# Step 4: Update routing
echo ""
echo "Step 4: Failover routing active."
echo "  M4 is now handling inference with qwen3.5:4b (lighter model)."
echo "  Gateway will auto-detect M1 unavailability and route to M4 fallback."
echo ""
echo -e "${YELLOW}NOTE: Running on M4 with smaller models.${NC}"
echo "  Some complex tasks may need cloud escalation (Claude API)."
echo "  Monitor M1 and run this script again when it's back online."

echo ""
echo "═══════════════════════════════════════════════════"
echo " Failover complete. M4 is now primary inference."
echo "═══════════════════════════════════════════════════"
