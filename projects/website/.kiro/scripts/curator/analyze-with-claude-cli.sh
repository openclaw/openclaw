#!/bin/bash

# Curator 視覺分析 - 使用 Claude CLI
#
# 用途：
# 1. 下載圖片（透過 curator.ts）
# 2. 調用 claude CLI 分析
# 3. 顯示完整執行過程（--verbose 或 --debug）

set -e

# 顏色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 參數
VERBOSE_MODE=${VERBOSE_MODE:-"--verbose"}  # 可改為 --debug
INPUT_TYPE=""
INPUT_VALUE=""

# 解析參數
if [[ $1 =~ ^https?:// ]]; then
  # URL 模式
  INPUT_TYPE="url"
  INPUT_VALUE="$1"
else
  # Course ID 模式
  INPUT_TYPE="course_id"
  INPUT_VALUE="$1"
  IMAGE_TYPE="${2:-main_image}"
fi

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}📸 Curator 視覺分析 (Claude CLI)${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Step 1: 下載圖片
echo -e "${BLUE}[1/2] 📥 下載圖片${NC}"
echo ""

if [ "$INPUT_TYPE" = "url" ]; then
  echo -e "${YELLOW}模式: URL${NC}"
  echo -e "URL: $INPUT_VALUE"
  echo ""

  DOWNLOAD_RESULT=$(pnpm tsx .kiro/api/curator.ts analyze-image "$INPUT_VALUE")
else
  echo -e "${YELLOW}模式: Course ID${NC}"
  echo -e "課程 ID: $INPUT_VALUE"
  echo -e "圖片類型: $IMAGE_TYPE"
  echo ""

  DOWNLOAD_RESULT=$(pnpm tsx .kiro/api/curator.ts analyze-image "$INPUT_VALUE" "$IMAGE_TYPE")
fi

# 提取圖片路徑
IMAGE_PATH=$(echo "$DOWNLOAD_RESULT" | jq -r '._downloaded_path')

if [ -z "$IMAGE_PATH" ] || [ "$IMAGE_PATH" = "null" ]; then
  echo -e "${RED}✗ 圖片下載失敗${NC}"
  echo "$DOWNLOAD_RESULT"
  exit 1
fi

echo -e "${GREEN}✓ 圖片已下載: $IMAGE_PATH${NC}"
echo ""

# Step 2: 調用 Claude CLI 分析
echo -e "${BLUE}[2/2] 🤖 調用 Claude CLI 分析${NC}"
echo ""
echo -e "${YELLOW}執行命令:${NC}"
echo -e "claude -p \"<prompt>\" $VERBOSE_MODE"
echo ""
echo -e "${CYAN}==================== Claude CLI 開始執行 ====================${NC}"
echo ""

# 準備提示詞
PROMPT="請分析這張圖片 (路徑: $IMAGE_PATH)

請從以下角度進行專業的視覺分析：

1. 主色調 (dominant_colors) - 提取 3-5 個主要顏色（Hex 格式）
2. 設計風格/主題 (theme) - 描述整體設計風格
3. 情緒/氛圍 (mood) - 分析圖片傳達的情緒
4. 關鍵視覺元素 (key_elements) - 列出 3-5 個最重要的視覺元素
5. 內容類型 (content_type) - product/highlight/banner/video/icon
6. 分析信心度 (analysis_confidence) - 0-1 之間

請直接用 JSON 格式輸出，不要其他文字：
{
  \"analyzed_at\": \"時間戳\",
  \"dominant_colors\": [\"#RRGGBB\", ...],
  \"theme\": \"設計風格\",
  \"mood\": \"情緒描述\",
  \"key_elements\": [\"元素1\", ...],
  \"content_type\": \"類型\",
  \"analysis_confidence\": 0.95
}"

# 執行 Claude CLI
claude -p "$PROMPT" $VERBOSE_MODE

echo ""
echo -e "${CYAN}==================== Claude CLI 執行完成 ====================${NC}"
echo ""
echo -e "${GREEN}✓ 分析完成！${NC}"
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}💡 提示：${NC}"
echo "  • 使用 VERBOSE_MODE=\"--debug\" 可看到更詳細的 debug 訊息"
echo "  • 圖片位置: $IMAGE_PATH"
echo -e "${CYAN}========================================${NC}"
