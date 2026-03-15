#!/bin/bash
# OpenClaw 自动启动配置脚本

PLIST_PATH="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
PROJECT_ROOT="/Users/ppg/PPClaw/openclaw"
PNPM_PATH="/opt/homebrew/bin/pnpm"

echo "=================================================="
echo "      设置 OpenClaw 开机自动启动"
echo "=================================================="

# 创建 LaunchAgents 目录如果不存在
mkdir -p "$HOME/Library/LaunchAgents"

# 生成 plist 文件
cat << PLIST_EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PNPM_PATH</string>
        <string>start</string>
        <string>gateway</string>
        <string>--allow-unconfigured</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_ROOT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>$HOME/.openclaw/logs/gateway-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.openclaw/logs/gateway-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLIST_EOF

# 创建日志目录
mkdir -p "$HOME/.openclaw/logs"

# 加载服务
launchctl load "$PLIST_PATH" 2>/dev/null || launchctl unload "$PLIST_PATH" && launchctl load "$PLIST_PATH"

echo "✅ 成功: OpenClaw 已配置为开机自启并在后台运行。"
