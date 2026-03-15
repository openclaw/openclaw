#!/bin/bash
# OpenClaw 重启服务脚本
# 仅当已通过 setup_autostart.sh 配置为系统级后台服务时生效

PLIST_PATH="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"

echo "=================================================="
echo "      重启 OpenClaw 基础后台服务"
echo "=================================================="

if [ -f "$PLIST_PATH" ]; then
    echo "正在卸载现有服务进程..."
    launchctl unload "$PLIST_PATH" 2>/dev/null
    sleep 2

    echo "正在检查并清理占用 18789 端口的僵尸进程 (Zombie Processes)..."
    STRAY_PID=$(lsof -ti:18789)
    if [ ! -z "$STRAY_PID" ]; then
        echo "发现僵尸进程 PID: $STRAY_PID 占用端口 18789，执行强制清理..."
        kill -9 $STRAY_PID 2>/dev/null
        sleep 1
        echo "✅ 僵尸进程已清除。"
    else
        echo "端口 18789 清爽，无需额外清理。"
    fi

    echo "正在重新加载服务进程..."
    launchctl load "$PLIST_PATH"
    echo "✅ 重启命令已下达，系统服务已重新拉起。"
    echo "日志可在 ~/.openclaw/logs/gateway-stdout.log 查看。"
else
    echo "错误：未检测到开机自启配置文件，无法进行常驻服务级别重启。"
    echo "请先运行 setup_autostart.sh 建立后台驻留保护。"
fi
