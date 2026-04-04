#!/bin/bash

# Curator Tool: 定價分析
#
# 用法:
#   ./analyze-pricing.sh <course_id>
#
# 輸出: 純 JSON (stdout)
# 日誌: stderr

set -e

COURSE_ID=${1}

if [ -z "$COURSE_ID" ]; then
  echo "❌ 請提供課程 ID" >&2
  echo "" >&2
  echo "用法: $0 <course_id>" >&2
  echo "範例: $0 5" >&2
  exit 1
fi

# 重定向所有訊息到 stderr
exec 3>&1  # 保存 stdout
exec 1>&2  # 重定向 stdout 到 stderr

echo "🛠️  Curator Tool: 定價分析"
echo "課程 ID: $COURSE_ID"
echo ""

# 讀取課程資料
echo "📚 讀取課程資料..."
COURSE_DATA=$(pnpm tsx .kiro/api/curator.ts get-memory | jq ".courses[] | select(.course_id == $COURSE_ID)")

if [ -z "$COURSE_DATA" ]; then
  echo "❌ 找不到課程 $COURSE_ID"
  exit 1
fi

COURSE_TITLE=$(echo "$COURSE_DATA" | jq -r '.zh_name')
echo "課程: $COURSE_TITLE"
echo ""

# 讀取完整記憶
echo "🧠 讀取 Curator 記憶..."
MEMORY_JSON=$(cat .kiro/personas/curator/memory.json | jq ".courses[] | select(.course_id == $COURSE_ID)")

# 讀取提示詞模板
echo "📝 準備提示詞..."
PROMPT_TEMPLATE=$(cat .kiro/tools/curator/prompts/analyze-pricing.md)

# 替換變數
PROMPT=$(echo "$PROMPT_TEMPLATE" | sed "s/{COURSE_ID}/$COURSE_ID/g" | sed "s|{MEMORY_JSON}|$MEMORY_JSON|g")

# 執行分析
echo "🤖 執行 Curator 分析..."
echo ""

TEMP_OUTPUT=$(mktemp)

claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  -p \
  > "$TEMP_OUTPUT" 2>&1

# 驗證並輸出 JSON
if [ -s "$TEMP_OUTPUT" ]; then
  if cat "$TEMP_OUTPUT" | jq empty 2>/dev/null; then
    echo "✅ 分析完成！"
    echo ""

    # 輸出到原始 stdout (fd 3)
    cat "$TEMP_OUTPUT" >&3
  else
    echo "⚠️  輸出不是有效的 JSON"
    echo ""
    echo "原始輸出:"
    cat "$TEMP_OUTPUT"

    # 嘗試提取 JSON
    if grep -q '{' "$TEMP_OUTPUT"; then
      echo ""
      echo "嘗試提取 JSON..."
      sed -n '/{/,/}/p' "$TEMP_OUTPUT" | jq '.' >&3 2>/dev/null || {
        echo "無法提取有效 JSON"
        exit 1
      }
    else
      exit 1
    fi
  fi
else
  echo "❌ 無輸出"
  exit 1
fi

# 清理
rm -f "$TEMP_OUTPUT"
