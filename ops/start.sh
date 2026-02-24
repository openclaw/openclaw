#!/usr/bin/env bash
# OpenClaw Gateway 启动脚本
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="/tmp/openclaw-gateway.log"
PORT="${OPENCLAW_PORT:-18789}"
BIND="${OPENCLAW_BIND:-loopback}"

cd "$PROJECT_DIR"

# 检查端口是否被占用
check_port() {
    ss -ltnp 2>/dev/null | grep -E ":${PORT}\s" >/dev/null 2>&1
}

# 检查是否已经在运行
if check_port; then
    PID=$(ss -ltnp 2>/dev/null | grep -E ":${PORT}\s" | grep -oP 'pid=\K\d+' | head -1)
    echo "[INFO] Gateway 已在端口 $PORT 运行 (PID: $PID)"
    echo "[INFO] Web UI: http://$BIND:$PORT/"
    exit 0
fi

echo "[INFO] 启动 OpenClaw Gateway..."
echo "[INFO] 端口: $PORT"
echo "[INFO] 绑定: $BIND"
echo "[INFO] 日志: $LOG_FILE"

nohup node openclaw.mjs gateway run --bind "$BIND" --port "$PORT" --force > "$LOG_FILE" 2>&1 &

# 等待启动，最多 30 秒（plugins 加载需要时间）
for i in {1..30}; do
    sleep 1
    if check_port; then
        PID=$(ss -ltnp 2>/dev/null | grep -E ":${PORT}\s" | grep -oP 'pid=\K\d+' | head -1)
        echo ""
        echo "[OK] Gateway 启动成功 (PID: $PID)"
        echo "[INFO] Web UI: http://127.0.0.1:$PORT/"
        exit 0
    fi
    echo -n "."
done

echo ""
echo "[ERROR] Gateway 启动失败，请检查日志: $LOG_FILE"
tail -20 "$LOG_FILE"
exit 1
