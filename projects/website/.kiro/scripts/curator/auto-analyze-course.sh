#!/bin/bash

# Curator 自主分析課程圖片
# 用法: ./auto-analyze-course.sh <course_id>

set -e

COURSE_ID=${1:-5}
OUTPUT_FILE="curator-analysis-${COURSE_ID}.json"
LOG_FILE="curator-analysis-${COURSE_ID}.log"

echo "🤖 Curator 自主分析 - 課程 ${COURSE_ID}"
echo ""

# 讀取課程資料
COURSE_DATA=$(pnpm tsx .kiro/api/curator.ts get-memory | jq ".courses[] | select(.course_id == $COURSE_ID)")

if [ -z "$COURSE_DATA" ]; then
  echo "❌ 找不到課程 ${COURSE_ID}"
  exit 1
fi

COURSE_TITLE=$(echo "$COURSE_DATA" | jq -r '.zh_name')
echo "📚 課程名稱: $COURSE_TITLE"
echo ""

# 建立提示詞
PROMPT="Hi 我是 Cruz

# Curator 人格
你是 Curator（商品策展人），負責管理網站課程資料。

## 你的記憶
$(cat .kiro/personas/curator/memory.json | jq ".courses[] | select(.course_id == $COURSE_ID)")

## 你的能力
- ✅ 可以使用 Bash tool 執行 pnpm tsx .kiro/api/curator.ts
- ✅ 可以使用 Read tool 讀取圖片
- ✅ 可以進行視覺分析

## 任務
請分析課程 ${COURSE_ID}「${COURSE_TITLE}」的所有圖片。

### 執行步驟
1. 從記憶中找出所有圖片（main_image, content_video, highlights）
2. 對每張圖片：
   a. 使用 Bash tool 執行：pnpm tsx .kiro/api/curator.ts analyze-image ${COURSE_ID} <image_type>
   b. 從輸出中取得 _downloaded_path
   c. 使用 Read tool 讀取圖片
   d. 進行視覺分析

3. 分析內容包括：
   - dominant_colors: 3-5 個主要顏色（Hex 格式）
   - theme: 設計風格描述
   - mood: 情緒/氛圍
   - key_elements: 3-5 個關鍵視覺元素
   - content_type: product/highlight/banner/video/icon
   - analysis_confidence: 0-1 信心度

### 輸出格式
請用 JSON 格式輸出，並用 \`\`\`json 包裹：

\`\`\`json
{
  \"course_id\": ${COURSE_ID},
  \"course_title\": \"${COURSE_TITLE}\",
  \"analyzed_at\": \"ISO時間戳\",
  \"images\": [
    {
      \"type\": \"main_image\",
      \"downloaded_path\": \"/tmp/...\",
      \"analysis\": {
        \"dominant_colors\": [\"#RRGGBB\", ...],
        \"theme\": \"...\",
        \"mood\": \"...\",
        \"key_elements\": [...],
        \"content_type\": \"...\",
        \"analysis_confidence\": 0.95
      }
    }
  ]
}
\`\`\`

### 重要
- 請直接執行，無需等待授權
- 使用 --dangerously-skip-permissions 模式
- 完成後直接輸出 JSON 結果"

# 執行分析
echo "🔍 開始分析..."
echo ""

claude -p "$PROMPT" --dangerously-skip-permissions --verbose 2>&1 | tee "$LOG_FILE"

echo ""
echo "✅ 分析完成！"
echo "📄 日誌檔案: $LOG_FILE"
echo ""

# 嘗試提取 JSON
if grep -q '```json' "$LOG_FILE"; then
  sed -n '/```json/,/```/p' "$LOG_FILE" | sed '1d;$d' > "$OUTPUT_FILE"
  echo "💾 結果已儲存: $OUTPUT_FILE"
  echo ""
  cat "$OUTPUT_FILE" | jq '.'
else
  echo "⚠️  未找到 JSON 輸出，請檢查日誌: $LOG_FILE"
fi
