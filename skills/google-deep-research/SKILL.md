---
name: google-deep-research
description: "Run Google Deep Research via the Interactions API. Use when the user asks for deep research, comprehensive web research, or multi-source information gathering that benefits from Google's research agent. Returns a full research report."
metadata: { "openclaw": { "emoji": "🔬" } }
---

# Google Deep Research

使用 Google Interactions API 调用 `deep-research-pro-preview-12-2025` 模型执行深度研究。适合需要多源信息整合、长文分析、或撰写 newsletter/报告的任务。

## API Key

从 openclaw 配置中读取：

```bash
GEMINI_API_KEY=$(sudo jq -r '.tools.web.search.gemini.apiKey' /home/wellingwong/.openclaw/openclaw.json)
```

## 执行流程

### 第一步：发起研究任务

```bash
RESPONSE=$(curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -d "{
    \"input\": \"<研究问题>\",
    \"agent\": \"deep-research-pro-preview-12-2025\",
    \"background\": true
  }")

INTERACTION_ID=$(echo "$RESPONSE" | jq -r '.name' | sed 's|interactions/||')
echo "Research started: $INTERACTION_ID"
```

### 第二步：轮询结果

Deep Research 通常需要 3–10 分钟。每 30 秒轮询一次：

```bash
while true; do
  RESULT=$(curl -s \
    "https://generativelanguage.googleapis.com/v1beta/interactions/$INTERACTION_ID" \
    -H "x-goog-api-key: $GEMINI_API_KEY")

  STATUS=$(echo "$RESULT" | jq -r '.state')
  echo "Status: $STATUS"

  if [ "$STATUS" = "COMPLETED" ]; then
    echo "$RESULT" | jq -r '.outputs[0].text'
    break
  elif [ "$STATUS" = "FAILED" ]; then
    echo "Research failed:"
    echo "$RESULT" | jq '.error'
    break
  fi

  sleep 30
done
```

## 完整一键脚本

```bash
GEMINI_API_KEY=$(sudo jq -r '.tools.web.search.gemini.apiKey' /home/wellingwong/.openclaw/openclaw.json)

QUERY="<研究问题>"

echo "🔬 Starting Deep Research..."
RESPONSE=$(curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -d "{\"input\": \"$QUERY\", \"agent\": \"deep-research-pro-preview-12-2025\", \"background\": true}")

INTERACTION_ID=$(echo "$RESPONSE" | jq -r '.name' | sed 's|interactions/||')

if [ -z "$INTERACTION_ID" ] || [ "$INTERACTION_ID" = "null" ]; then
  echo "❌ Failed to start research:"
  echo "$RESPONSE" | jq .
  exit 1
fi

echo "✅ Interaction ID: $INTERACTION_ID"
echo "⏳ Polling for results (this takes 3–10 minutes)..."

while true; do
  RESULT=$(curl -s \
    "https://generativelanguage.googleapis.com/v1beta/interactions/$INTERACTION_ID" \
    -H "x-goog-api-key: $GEMINI_API_KEY")

  STATUS=$(echo "$RESULT" | jq -r '.state')
  echo "$(date '+%H:%M:%S') Status: $STATUS"

  if [ "$STATUS" = "COMPLETED" ]; then
    echo ""
    echo "✅ Research complete:"
    echo "$RESULT" | jq -r '.outputs[0].text'
    break
  elif [ "$STATUS" = "FAILED" ]; then
    echo "❌ Research failed:"
    echo "$RESULT" | jq '.error'
    break
  fi

  sleep 30
done
```

## 使用示例

用户说：

> 帮我 deep research 近 1 周关于 AI 新应用场景的资讯，写成 newsletter

执行步骤：

1. 从 openclaw 配置读取 `GEMINI_API_KEY`
2. 将用户的研究问题作为 `QUERY`，用中文或英文均可
3. 用 bash 执行上面的完整脚本（建议 `background: true` 后台运行）
4. 轮询完成后将结果返回给用户

## 注意事项

- 研究任务在 Google 服务器端异步执行，通常需要 **3–10 分钟**
- 结果会在 Google 端保存 **55 天**（付费）/ **1 天**（免费）
- 如任务超过 15 分钟仍未完成，可能是网络问题，重新发起即可
- `deep-research-pro-preview-12-2025` 只能通过 Interactions API 调用，不能通过 openclaw 的模型选择器使用
