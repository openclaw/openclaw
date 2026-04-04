#!/bin/bash

# Curator 自主分析系統
#
# 用法:
#   ./curator-analyze.sh <course_id>
#   ./curator-analyze.sh 5
#
# 特色:
#   - 使用 --dangerously-skip-permissions 讓 Curator 自主執行
#   - 在提示詞中明確定義權限邊界
#   - --verbose 顯示完整思考過程

set -e

COURSE_ID=${1:-5}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE=".kiro/personas/curator/analysis_${COURSE_ID}_${TIMESTAMP}.json"
LOG_FILE=".kiro/personas/curator/analysis_${COURSE_ID}_${TIMESTAMP}.log"

echo "🤖 Curator 自主分析系統"
echo "================================"
echo "課程 ID: $COURSE_ID"
echo "時間戳: $TIMESTAMP"
echo ""

# 讀取課程資料
COURSE_DATA=$(pnpm tsx .kiro/api/curator.ts get-memory | jq ".courses[] | select(.course_id == $COURSE_ID)")

if [ -z "$COURSE_DATA" ]; then
  echo "❌ 找不到課程 ${COURSE_ID}"
  exit 1
fi

COURSE_TITLE=$(echo "$COURSE_DATA" | jq -r '.zh_name')
echo "📚 課程: $COURSE_TITLE"
echo ""

# 準備提示詞
read -r -d '' PROMPT << EOM || true
Hi 我是 Cruz

# 你是誰
你是 Curator（商品策展人），負責分析網站課程的視覺內容。

# 你的記憶
$(cat .kiro/personas/curator/memory.json | jq ".courses[] | select(.course_id == $COURSE_ID)")

# 你的任務
請分析課程 ${COURSE_ID}「${COURSE_TITLE}」的**所有圖片**。

## 執行步驟
1. 從記憶中列出所有圖片類型（main_image, content_video, highlight1-6）
2. 對每張圖片：
   a. 使用 Bash: \`pnpm tsx .kiro/api/curator.ts analyze-image ${COURSE_ID} <type>\`
   b. 從 JSON 輸出取得 \`_downloaded_path\`
   c. 使用 Read tool 讀取該路徑的圖片
   d. 分析視覺內容

## 分析要點
- **dominant_colors**: 3-5 個主色調（Hex）
- **theme**: 設計風格（例如：現代、科技、溫暖）
- **mood**: 情緒氛圍（例如：專業、活力、沉穩）
- **key_elements**: 3-5 個關鍵元素（例如：文字、圖標、人物）
- **content_type**: product/highlight/banner/video/icon
- **confidence**: 0-1 之間的信心度

## 輸出格式
請用 JSON 格式輸出，用 \`\`\`json 包裹：

\`\`\`json
{
  "course_id": ${COURSE_ID},
  "course_title": "${COURSE_TITLE}",
  "analyzed_at": "ISO時間",
  "total_images": 8,
  "images": [
    {
      "type": "main_image",
      "title": "課程主圖",
      "downloaded_path": "/tmp/...",
      "analysis": {
        "dominant_colors": ["#RRGGBB", ...],
        "theme": "...",
        "mood": "...",
        "key_elements": [...],
        "content_type": "product",
        "confidence": 0.95
      }
    }
  ]
}
\`\`\`

# 權限設定（重要！）

## ✅ 你可以做的事
- 讀取任何檔案（Read tool）
- 執行 pnpm tsx .kiro/api/curator.ts 相關指令（Bash tool）
- 讀取圖片並分析
- 輸出分析結果

## ❌ 你絕對不能做的事
- 修改任何網站原始碼（src/, app/, components/, lib/, public/）
- 修改 package.json, tsconfig.json, next.config.js
- 執行 git 操作（git add, git commit, git push）
- 修改 .env 或其他設定檔
- 刪除任何檔案
- 執行 npm install 或 pnpm install

## 執行指示
- 請直接開始執行，不需要詢問授權
- 遇到錯誤請記錄並繼續下一張圖片
- 完成所有圖片分析後輸出完整 JSON
EOM

echo "🚀 開始執行..." >&2
echo "📝 日誌: $LOG_FILE" >&2
echo "" >&2
echo "================================" >&2
echo "" >&2

# 執行 Curator
claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  -p \
  --output-format json \
  2>"$LOG_FILE"

echo "" >&2
echo "================================" >&2
echo "" >&2
