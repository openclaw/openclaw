#!/bin/bash
# Issue #100944 真机复现脚本
# 需要配置好的 Signal 网关容器环境

set -e

echo "=== Issue #100944 真机复现步骤 ==="
echo ""
echo "前置条件："
echo "1. Signal 网关容器运行中 (bbernhard/signal-cli-rest-api)"
echo "2. OpenClaw gateway 运行中"
echo "3. 已配对的 Signal 账号"
echo ""

# 检查环境变量
if [ -z "$SIGNAL_GATEWAY_URL" ]; then
    echo "⚠️  未设置 SIGNAL_GATEWAY_URL，使用默认值 http://localhost:8080"
    SIGNAL_GATEWAY_URL="http://localhost:8080"
fi

echo "步骤 1: 发送第一条 Signal DM 消息"
echo "  POST $SIGNAL_GATEWAY_URL/v2/send -d '{\"number\": \"<bot-number>\", \"message\": \"test1\"}'"
# curl -X POST "$SIGNAL_GATEWAY_URL/v2/send" \
#   -H "Content-Type: application/json" \
#   -d "{\"number\": \"<bot-number>\", \"message\": \"test1\"}"
echo "  ✓ 预期：收到 bot 回复"
echo ""

echo "步骤 2: 等待回复完成（约 5-10 秒）"
sleep 5
echo ""

echo "步骤 3: 快速发送第二条 Signal DM 消息（10-30秒内）"
echo "  POST $SIGNAL_GATEWAY_URL/v2/send -d '{\"number\": \"<bot-number>\", \"message\": \"test2\"}'"
# curl -X POST "$SIGNAL_GATEWAY_URL/v2/send" \
#   -H "Content-Type: application/json" \
#   -d "{\"number\": \"<bot-number>\", \"message\": \"test2\"}"
echo "  ✗ 预期：**无回复**（消息被静默丢弃）"
echo ""

echo "步骤 4: 检查网关日志"
echo "  查找以下错误模式："
echo "  '[signal] debounce flush failed: Error: reply session initialization conflicted for agent:main:signal:direct:<number>'"
echo ""

echo "=== 对比：Slack/Telegram 会有重试行为 ==="
echo "Slack: 检测到 'reply session initialization conflicted' 后会重试最多 3 次"
echo "Telegram: spooled update 失败时会重新排队并退避"
echo ""

echo "结论：Issue #100944 可在当前 main 分支复现"
