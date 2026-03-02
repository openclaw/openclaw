#!/bin/bash
#
# Gateway Auto-Restart Monitor
# 检测网关故障并自动重启
#
# Usage:
#   ./gateway-watchdog.sh              # 前台运行
#   ./gateway-watchdog.sh --daemon     # 后台运行
#   ./gateway-watchdog.sh --stop       # 停止监控
#

set -e

# 配置
GATEWAY_PORT=${GATEWAY_PORT:-18789}
CHECK_INTERVAL=${CHECK_INTERVAL:-30}  # 检查间隔（秒）
MAX_RESTARTS=${MAX_RESTARTS:-5}       # 最大重启次数
RESTART_DELAY=${RESTART_DELAY:-5}     # 重启前等待（秒）
LOG_FILE="${LOG_FILE:-/tmp/openclaw/gateway-watchdog.log}"
PID_FILE="${PID_FILE:-/tmp/openclaw/gateway-watchdog.pid}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 日志函数
log() {
    local level=$1
    shift
    local msg="$@"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${timestamp} [${level}] ${msg}" | tee -a "$LOG_FILE"
}

log_info() {
    log "${GREEN}INFO${NC}" "$@"
}

log_warn() {
    log "${YELLOW}WARN${NC}" "$@"
}

log_error() {
    log "${RED}ERROR${NC}" "$@"
}

# 确保日志目录存在
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$PID_FILE")"

# 检查网关是否运行
check_gateway() {
    # 方法 1: 检查端口
    if lsof -i :$GATEWAY_PORT >/dev/null 2>&1; then
        return 0
    fi
    
    # 方法 2: 检查进程
    if pgrep -f "openclaw.*gateway" >/dev/null 2>&1; then
        return 0
    fi
    
    # 方法 3: HTTP 探测
    if curl -s --max-time 2 "http://127.0.0.1:$GATEWAY_PORT/status" >/dev/null 2>&1; then
        return 0
    fi
    
    return 1
}

# 重启网关
restart_gateway() {
    log_warn "尝试重启网关..."
    
    # 停止旧进程
    log_info "停止旧网关进程..."
    pkill -f "openclaw.*gateway" 2>/dev/null || true
    sleep 2
    
    # 等待端口释放
    local wait_count=0
    while lsof -i :$GATEWAY_PORT >/dev/null 2>&1 && [ $wait_count -lt 10 ]; do
        log_info "等待端口 $GATEWAY_PORT 释放... ($wait_count/10)"
        sleep 1
        wait_count=$((wait_count + 1))
    done
    
    # 启动新网关
    log_info "启动新网关..."
    cd ~/openclaw && openclaw gateway >/dev/null 2>&1 &
    
    # 等待网关启动
    sleep $RESTART_DELAY
    
    # 验证启动成功
    if check_gateway; then
        log_info "✅ 网关重启成功"
        return 0
    else
        log_error "❌ 网关重启失败"
        return 1
    fi
}

# 主监控循环
monitor() {
    local restart_count=0
    local last_restart=0
    
    log_info "========================================="
    log_info "网关监控启动"
    log_info "端口：$GATEWAY_PORT"
    log_info "检查间隔：${CHECK_INTERVAL}秒"
    log_info "日志：$LOG_FILE"
    log_info "========================================="
    
    while true; do
        if check_gateway; then
            log_info "网关运行正常 (端口 $GATEWAY_PORT)"
            restart_count=0  # 重置重启计数
        else
            log_error "❌ 网关故障！"
            
            # 检查重启频率
            local now=$(date +%s)
            if [ $((now - last_restart)) -lt 300 ]; then
                restart_count=$((restart_count + 1))
                if [ $restart_count -ge $MAX_RESTARTS ]; then
                    log_error "🚨 5 分钟内重启 $MAX_RESTARTS 次，停止自动重启"
                    log_error "请手动检查网关配置和日志"
                    exit 1
                fi
            else
                restart_count=1
            fi
            
            last_restart=$now
            
            # 重启网关
            if restart_gateway; then
                log_info "✅ 网关已恢复"
            else
                log_error "❌ 重启失败，等待下次检查"
            fi
        fi
        
        sleep $CHECK_INTERVAL
    done
}

# 停止监控
stop() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            log_info "停止监控进程 (PID: $pid)"
            kill "$pid"
            rm -f "$PID_FILE"
            log_info "✅ 监控已停止"
        else
            log_warn "监控进程已不存在"
            rm -f "$PID_FILE"
        fi
    else
        log_warn "未找到监控进程"
    fi
}

# 启动为守护进程
start_daemon() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            log_error "监控已在运行 (PID: $pid)"
            exit 1
        fi
    fi
    
    log_info "启动守护进程..."
    nohup "$0" > /dev/null 2>&1 &
    echo $! > "$PID_FILE"
    log_info "✅ 守护进程已启动 (PID: $!)"
    log_info "日志：$LOG_FILE"
}

# 显示状态
status() {
    echo "=== 网关监控状态 ==="
    
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "监控进程：✅ 运行中 (PID: $pid)"
        else
            echo "监控进程：❌ 已停止 (PID 文件残留)"
        fi
    else
        echo "监控进程：❌ 未运行"
    fi
    
    if check_gateway; then
        echo "网关状态：✅ 运行中 (端口 $GATEWAY_PORT)"
    else
        echo "网关状态：❌ 已停止"
    fi
    
    echo ""
    echo "最近日志:"
    tail -5 "$LOG_FILE" 2>/dev/null || echo "无日志文件"
}

# 主程序
case "${1:-}" in
    --daemon|-d)
        start_daemon
        ;;
    --stop|-s)
        stop
        ;;
    --status|status)
        status
        ;;
    --help|-h)
        echo "用法：$0 [选项]"
        echo ""
        echo "选项:"
        echo "  --daemon, -d     后台运行（守护进程）"
        echo "  --stop, -s       停止监控"
        echo "  --status         显示状态"
        echo "  --help, -h       显示帮助"
        echo ""
        echo "无参数时前台运行"
        echo ""
        echo "环境变量:"
        echo "  GATEWAY_PORT     网关端口 (默认：18789)"
        echo "  CHECK_INTERVAL   检查间隔秒数 (默认：30)"
        echo "  MAX_RESTARTS     最大重启次数 (默认：5)"
        echo "  LOG_FILE         日志文件路径"
        ;;
    *)
        monitor
        ;;
esac
