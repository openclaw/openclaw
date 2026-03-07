#!/usr/bin/env bash
# Cluster health check — run from M1 controller
# Checks: SSH, services, Ollama, disk, Gateway
set -euo pipefail

CLUSTER_HOSTS="${CLUSTER_HOSTS:-claw-m4 claw-i7}"
OLLAMA_M1_HOST="${OLLAMA_PRIMARY_HOST:-http://127.0.0.1:11434}"
OLLAMA_M4_HOST="${OLLAMA_FALLBACK_HOST:-http://10.0.0.10:11434}"
GATEWAY_HOST="${GATEWAY_HOST:-http://10.0.0.10:18789}"
APP_PORT="${APP_PORT:-8080}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

echo "═══════════════════════════════════════════════════"
echo " OpenClaw Cluster Health Check"
echo " $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "═══════════════════════════════════════════════════"

# ── SSH Connectivity ──
echo ""
echo "SSH Connectivity:"
for h in $CLUSTER_HOSTS; do
    if ssh -o ConnectTimeout=3 "$h" 'echo ok' &>/dev/null; then
        pass "$h — reachable"
    else
        fail "$h — unreachable"
    fi
done

# ── Service Status ──
echo ""
echo "Service Status:"
for h in $CLUSTER_HOSTS; do
    # tmux session
    if ssh -o ConnectTimeout=3 "$h" 'tmux has-session -t openclaw 2>/dev/null || tmux has-session -t openclaw-workers 2>/dev/null' &>/dev/null; then
        pass "$h — tmux session running"
    else
        fail "$h — no tmux session"
    fi

    # App server
    if ssh -o ConnectTimeout=3 "$h" "curl -sf http://localhost:$APP_PORT/health >/dev/null 2>&1" &>/dev/null; then
        pass "$h — app server responding on :$APP_PORT"
    else
        warn "$h — app server not responding on :$APP_PORT"
    fi
done

# ── Ollama Status ──
echo ""
echo "Ollama (Local Inference):"

# M1
if curl -sf "$OLLAMA_M1_HOST/api/tags" >/dev/null 2>&1; then
    model_count=$(curl -sf "$OLLAMA_M1_HOST/api/tags" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('models',[])))" 2>/dev/null || echo "?")
    pass "M1 ($OLLAMA_M1_HOST) — online, $model_count models available"
else
    fail "M1 ($OLLAMA_M1_HOST) — offline"
fi

# M4 fallback
if curl -sf "$OLLAMA_M4_HOST/api/tags" >/dev/null 2>&1; then
    pass "M4 ($OLLAMA_M4_HOST) — fallback online"
else
    warn "M4 ($OLLAMA_M4_HOST) — fallback offline (non-critical)"
fi

# ── OpenClaw Gateway ──
echo ""
echo "OpenClaw Gateway:"
if curl -sf "$GATEWAY_HOST/health" >/dev/null 2>&1; then
    pass "Gateway ($GATEWAY_HOST) — responding"
else
    warn "Gateway ($GATEWAY_HOST) — not responding (may not be deployed yet)"
fi

# ── Shared Storage ──
echo ""
echo "Shared Storage (~/cluster):"
for h in $CLUSTER_HOSTS; do
    if ssh -o ConnectTimeout=3 "$h" 'test -d ~/cluster/jobs/pending' &>/dev/null; then
        job_count=$(ssh -o ConnectTimeout=3 "$h" 'ls ~/cluster/jobs/pending/ 2>/dev/null | wc -l' 2>/dev/null || echo "?")
        pass "$h — ~/cluster mounted ($job_count pending jobs)"
    else
        fail "$h — ~/cluster not mounted or missing job dirs"
    fi
done

# ── Disk Space ──
echo ""
echo "Disk Space:"
for h in $CLUSTER_HOSTS; do
    usage=$(ssh -o ConnectTimeout=3 "$h" 'df -h ~ 2>/dev/null | tail -1 | awk "{print \$5}"' 2>/dev/null || echo "?")
    if [[ "$usage" != "?" ]]; then
        pct="${usage%%%}"
        if (( pct > 90 )); then
            fail "$h — $usage used (CRITICAL)"
        elif (( pct > 75 )); then
            warn "$h — $usage used"
        else
            pass "$h — $usage used"
        fi
    else
        warn "$h — could not check disk"
    fi
done

echo ""
echo "═══════════════════════════════════════════════════"
echo " Health check complete."
echo "═══════════════════════════════════════════════════"
