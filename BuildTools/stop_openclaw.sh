#!/bin/bash
# OpenClaw 停止服务运行脚本
# 仅当已通过 setup_autostart.sh 配置为系统级后台服务时生效

PLIST_PATH="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"

echo "=================================================="
echo "      停止 OpenClaw 基础后台服务"
echo "=================================================="

if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH"
    echo "✅ 服务已停止并在系统开机自启任务中注销。"
    echo "如需再次启动并开机自启，请运行 setup_autostart.sh"
else
    echo "未检测到开机自启配置文件，可能服务未通过 launchd 运行。"
    echo "如果是通过其他方式（例如终端直接运行 start_openclaw.sh），请在原终端按 Ctrl+C 结束或者直接结束进程。"
fi
