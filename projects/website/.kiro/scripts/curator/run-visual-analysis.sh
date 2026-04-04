#!/bin/bash
# Visual Analysis Session Runner
# 這個腳本會：
# 1. 執行 analyze-images.ts 生成任務 prompt
# 2. 使用 claude CLI 執行視覺分析
# 3. 從 log 中提取分析結果
# 4. 儲存到 memory.json

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURATOR_DIR="$SCRIPT_DIR/../../personas/curator"
SESSION_DIR="$CURATOR_DIR/sessions"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SESSION_FILE="$SESSION_DIR/visual_analysis_$TIMESTAMP.md"

# 確保目錄存在
mkdir -p "$SESSION_DIR"

echo "🎨 Curator 視覺分析 Session Runner"
echo "=================================="
echo ""

# 1. 生成任務檔案（包含圖片清單和 prompt）
echo "📋 步驟 1: 生成分析任務..."
pnpm tsx "$SCRIPT_DIR/analyze-images.ts" > /dev/null 2>&1

# 2. 讀取圖片清單
IMAGES_FILE="$CURATOR_DIR/images-to-analyze.json"
TOTAL_IMAGES=$(cat "$IMAGES_FILE" | grep -o '"total":' | wc -l)

echo "   找到 $TOTAL_IMAGES 張圖片需要分析"
echo ""

# 3. 生成 session.md
echo "📝 步驟 2: 生成 Session 檔案..."
cat > "$SESSION_FILE" << 'EOFTEMPLATE'
# Curator 視覺記憶分析 Session

## 🎯 人格設定

你現在是 **Curator（商品策展人）**。

你的任務是用你的多模態能力，實際查看每一張課程圖片，並以專業策展人的眼光進行視覺分析。

## 📋 任務說明

請執行以下步驟：

### 1. 讀取圖片清單

```bash
cat .kiro/personas/curator/images-to-analyze.json
```

### 2. 分析圖片（樣本）

從清單中選擇前 **10 張**圖片進行分析（作為測試樣本）。

對每張圖片：

1. **使用 Read tool 實際查看圖片**
2. **以策展人角度分析**：
   - `dominant_colors`: 主色調 2-4 個（hex 色碼）
   - `theme`: 主題（如「現代科技」「溫暖人文」）
   - `mood`: 情緒氛圍（如「專業」「親切」「神秘」）
   - `key_elements`: 關鍵視覺元素（陣列）
   - `content_type`: 內容類型（product/highlight/banner/video/icon）
   - `analysis_confidence`: 分析信心度 0-100

3. **整理成 JSON 格式**

### 3. 輸出格式

請將分析結果整理成以下 JSON 格式，並使用 Write tool 儲存到：

`.kiro/personas/curator/visual-analysis-results.json`

```json
{
  "analyzed_at": "2025-11-02T...",
  "total_analyzed": 10,
  "results": [
    {
      "course_id": 0,
      "image_type": "main_image",
      "highlight_number": null,
      "analysis": {
        "analyzed_at": "2025-11-02T...",
        "dominant_colors": ["#FF6B35", "#F7931E", "#1A1A1A"],
        "theme": "現代科技、駭客風格",
        "mood": "專業、神秘、創新",
        "key_elements": ["電腦螢幕", "程式碼", "深色背景"],
        "content_type": "product",
        "analysis_confidence": 95
      }
    }
  ]
}
```

## ⚠️ 重要提醒

1. **必須使用 Read tool 實際查看圖片**，不要猜測
2. 如果圖片無法讀取，設定 `content_type: "unreadable"`
3. 分析完成後，調用 `save-visual-analysis.ts` 儲存結果
4. 這是**實際驗證**任務，完成後能力將升級為 `verified`

## 🎬 開始執行

請開始分析前 10 張圖片！
EOFTEMPLATE

echo "   Session 檔案: $SESSION_FILE"
echo ""

# 4. 執行 claude CLI
echo "🚀 步驟 3: 執行視覺分析 Session..."
echo "   使用 claude CLI..."
echo ""

# 使用 claude CLI 執行（不跳過權限，讓它正常詢問）
cd "$SCRIPT_DIR/../../.."
claude --prompt-file "$SESSION_FILE" 2>&1 | tee "$SESSION_DIR/visual_analysis_$TIMESTAMP.log"

CLAUDE_EXIT_CODE=${PIPESTATUS[0]}

# 5. 檢查結果
echo ""
echo "📊 步驟 4: 檢查執行結果..."

if [ $CLAUDE_EXIT_CODE -eq 0 ]; then
    echo "   ✅ Claude 執行成功"

    # 檢查是否生成了結果檔案
    RESULTS_FILE="$CURATOR_DIR/visual-analysis-results.json"
    if [ -f "$RESULTS_FILE" ]; then
        echo "   ✅ 找到分析結果檔案"

        # 顯示摘要
        ANALYZED_COUNT=$(cat "$RESULTS_FILE" | grep -o '"course_id":' | wc -l | tr -d ' ')
        echo "   📸 已分析: $ANALYZED_COUNT 張圖片"

        # 6. 儲存到 memory.json
        echo ""
        echo "💾 步驟 5: 整合到記憶系統..."
        pnpm tsx "$SCRIPT_DIR/save-visual-analysis.ts" "$RESULTS_FILE"

        echo ""
        echo "🎉 視覺分析完成！"
        echo ""
        echo "📁 相關檔案:"
        echo "   - Session: $SESSION_FILE"
        echo "   - Log: $SESSION_DIR/visual_analysis_$TIMESTAMP.log"
        echo "   - Results: $RESULTS_FILE"
        echo "   - Memory: $CURATOR_DIR/memory.json"

    else
        echo "   ⚠️  未找到分析結果檔案"
        echo "   請檢查 log: $SESSION_DIR/visual_analysis_$TIMESTAMP.log"
        exit 1
    fi
else
    echo "   ❌ Claude 執行失敗 (exit code: $CLAUDE_EXIT_CODE)"
    echo "   請檢查 log: $SESSION_DIR/visual_analysis_$TIMESTAMP.log"
    exit 1
fi

echo ""
echo "=================================="
