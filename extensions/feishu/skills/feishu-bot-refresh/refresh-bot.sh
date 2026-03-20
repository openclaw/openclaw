#!/bin/bash
# Feishu Bot Identity Refresh Script
# Usage: ./refresh-bot.sh [account_id] [--json]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
IDENTITY_FILE="$OPENCLAW_DIR/agents/main/sessions/bot-identity.json"

# Get account ID from parameter or use default
ACCOUNT_ID="${1:-dev-1}"

echo "🔄 正在刷新飞书机器人信息..."
echo "📋 账号：$ACCOUNT_ID"

# Read app credentials from openclaw.json
APP_ID=$(jq -r ".channels.feishu.accounts[\"$ACCOUNT_ID\"].appId" "$OPENCLAW_DIR/openclaw.json")
APP_SECRET=$(jq -r ".channels.feishu.accounts[\"$ACCOUNT_ID\"].appSecret" "$OPENCLAW_DIR/openclaw.json")

if [ "$APP_ID" = "null" ] || [ "$APP_SECRET" = "null" ]; then
    echo "❌ 错误：找不到账号 $ACCOUNT_ID 的配置"
    exit 1
fi

echo "🔑 AppID: $APP_ID"

# Step 1: Get tenant access token
echo "📝 获取访问令牌..."
TOKEN_RESPONSE=$(curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{
    \"app_id\": \"$APP_ID\",
    \"app_secret\": \"$APP_SECRET\"
  }")

TENANT_ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.tenant_access_token')
CODE=$(echo "$TOKEN_RESPONSE" | jq -r '.code')

if [ "$CODE" != "0" ]; then
    echo "❌ 获取令牌失败：$TOKEN_RESPONSE"
    exit 1
fi

echo "✅ 令牌获取成功"

# Step 2: Query bot info
echo "🤖 查询机器人信息..."
BOT_RESPONSE=$(curl -s -X GET "https://open.feishu.cn/open-apis/bot/v3/info" \
  -H "Authorization: Bearer $TENANT_ACCESS_TOKEN")

CODE=$(echo "$BOT_RESPONSE" | jq -r '.code')

if [ "$CODE" != "0" ]; then
    echo "❌ 查询机器人信息失败：$BOT_RESPONSE"
    exit 1
fi

# Extract bot info
APP_NAME=$(echo "$BOT_RESPONSE" | jq -r '.bot.app_name')
OPEN_ID=$(echo "$BOT_RESPONSE" | jq -r '.bot.open_id')
ACTIVATE_STATUS=$(echo "$BOT_RESPONSE" | jq -r '.bot.activate_status')
AVATAR_URL=$(echo "$BOT_RESPONSE" | jq -r '.bot.avatar_url')
QUERIED_AT=$(date -Iseconds)

echo "✅ 查询成功"

# Step 3: Save to identity file
echo "💾 保存配置..."
mkdir -p "$(dirname "$IDENTITY_FILE")"

# Use jq to safely construct JSON (handles special characters in values)
jq -n \
  --arg appId "$APP_ID" \
  --arg appName "$APP_NAME" \
  --arg openId "$OPEN_ID" \
  --argjson activateStatus "$ACTIVATE_STATUS" \
  --arg avatarUrl "$AVATAR_URL" \
  --arg queriedAt "$QUERIED_AT" \
  '{"feishu": {"appId": $appId, "appName": $appName, "openId": $openId, "activateStatus": $activateStatus, "avatarUrl": $avatarUrl, "queriedAt": $queriedAt}}' \
  > "$IDENTITY_FILE"

echo "✅ 配置已保存至：$IDENTITY_FILE"

# Step 4: Output result
echo ""
echo "✅ 机器人信息已刷新："
echo ""
echo "  - **名称：** $APP_NAME"
echo "  - **OpenID：** $OPEN_ID"
echo "  - **激活状态：** $([ "$ACTIVATE_STATUS" = "2" ] && echo "已激活" || echo "未激活")"
echo "  - **查询时间：** $QUERIED_AT"
echo ""

# Return JSON for programmatic use
if [ "$2" = "--json" ]; then
    echo "$BOT_RESPONSE" | jq '.bot'
fi
