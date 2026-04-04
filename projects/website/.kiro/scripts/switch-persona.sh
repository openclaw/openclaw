#!/bin/bash
# 人格切換腳本
# 使用方式：
#   .kiro/scripts/switch-persona.sh curator    # 切換到 Curator 人格
#   .kiro/scripts/switch-persona.sh default    # 切換回預設人格

set -e

PERSONA=$1
PROJECT_ROOT=$(pwd)
CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
PERSONA_DIR="$PROJECT_ROOT/.kiro/personas"
BACKUP_DIR="$PERSONA_DIR/_backups"

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

if [ -z "$PERSONA" ]; then
  echo -e "${RED}❌ 錯誤：缺少人格參數${NC}"
  echo ""
  echo "使用方式："
  echo "  $0 curator              # 切換到 Curator 人格（課程內容管理）"
  echo "  $0 pricing-strategist   # 切換到 Pricing Strategist 人格（定價策略）"
  echo "  $0 default              # 切換回預設人格"
  echo ""
  exit 1
fi

# 建立備份目錄
mkdir -p "$BACKUP_DIR"

# 時間戳記
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo ""
echo -e "${BLUE}🔄 人格切換系統${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 當前人格檢測
if [ -f "$CLAUDE_MD" ]; then
  CURRENT_PERSONA=$(grep -m 1 "^# " "$CLAUDE_MD" | sed 's/^# //' || echo "Unknown")
  echo -e "${YELLOW}📋 當前人格：${NC}$CURRENT_PERSONA"
else
  echo -e "${YELLOW}⚠️  CLAUDE.md 不存在，將建立新檔案${NC}"
  CURRENT_PERSONA="None"
fi

echo -e "${GREEN}🎯 目標人格：${NC}$PERSONA"
echo ""

case "$PERSONA" in
  curator)
    PERSONA_FILE="$PERSONA_DIR/curator/CLAUDE_CURATOR.md"

    if [ ! -f "$PERSONA_FILE" ]; then
      echo -e "${RED}❌ 錯誤：找不到 Curator 人格檔案${NC}"
      echo "   預期位置：$PERSONA_FILE"
      exit 1
    fi

    # 備份當前 CLAUDE.md（如果存在且不是 Curator）
    if [ -f "$CLAUDE_MD" ] && ! grep -q "Curator 人格定義" "$CLAUDE_MD"; then
      BACKUP_FILE="$BACKUP_DIR/CLAUDE.md.backup_$TIMESTAMP"
      echo -e "${YELLOW}💾 備份當前 CLAUDE.md...${NC}"
      cp "$CLAUDE_MD" "$BACKUP_FILE"
      echo -e "${GREEN}✅ 備份完成：${NC}$BACKUP_FILE"
      echo ""
    fi

    # 複製 Curator 人格到 CLAUDE.md
    echo -e "${BLUE}📝 切換到 Curator 人格...${NC}"
    cp "$PERSONA_FILE" "$CLAUDE_MD"

    echo ""
    echo -e "${GREEN}✅ 人格切換完成！${NC}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}📋 Curator 人格特性：${NC}"
    echo "   • 課程內容管理"
    echo "   • 定價分析與更新"
    echo "   • SVG 定價圖快速更新"
    echo "   • 視覺內容優化"
    echo ""
    echo -e "${YELLOW}💡 建議執行健康檢查：${NC}"
    echo "   pnpm tsx .kiro/scripts/curator/diagnose-memory.ts"
    echo ""
    ;;

  default)
    # 檢查是否有備份
    LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/CLAUDE.md.backup_* 2>/dev/null | head -1)

    if [ -z "$LATEST_BACKUP" ]; then
      echo -e "${RED}❌ 錯誤：找不到預設人格的備份檔案${NC}"
      echo ""
      echo "可能的原因："
      echo "  1. 從未切換過人格（一直是預設）"
      echo "  2. 備份檔案已被刪除"
      echo ""
      echo "請確認是否需要恢復，或手動建立 CLAUDE.md"
      exit 1
    fi

    # 備份當前 Curator CLAUDE.md
    if [ -f "$CLAUDE_MD" ]; then
      CURATOR_BACKUP="$PERSONA_DIR/curator/CLAUDE_CURATOR.md.backup_$TIMESTAMP"
      echo -e "${YELLOW}💾 備份當前 Curator 設定...${NC}"
      cp "$CLAUDE_MD" "$CURATOR_BACKUP"
      echo -e "${GREEN}✅ 備份完成：${NC}$CURATOR_BACKUP"
      echo ""
    fi

    # 恢復預設人格
    echo -e "${BLUE}📝 恢復預設人格...${NC}"
    echo -e "${YELLOW}   使用備份：${NC}$(basename $LATEST_BACKUP)"
    cp "$LATEST_BACKUP" "$CLAUDE_MD"

    echo ""
    echo -e "${GREEN}✅ 人格切換完成！${NC}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}📋 已恢復預設人格${NC}"
    echo ""
    ;;

  pricing-strategist)
    PERSONA_FILE="$PERSONA_DIR/pricing-strategist/CLAUDE_PRICING_STRATEGIST.md"

    if [ ! -f "$PERSONA_FILE" ]; then
      echo -e "${RED}❌ 錯誤：找不到 Pricing Strategist 人格檔案${NC}"
      echo "   預期位置：$PERSONA_FILE"
      exit 1
    fi

    # 備份當前 CLAUDE.md（如果存在且不是 Pricing Strategist）
    if [ -f "$CLAUDE_MD" ] && ! grep -q "Pricing Strategist 人格定義" "$CLAUDE_MD"; then
      BACKUP_FILE="$BACKUP_DIR/CLAUDE.md.backup_$TIMESTAMP"
      echo -e "${YELLOW}💾 備份當前 CLAUDE.md...${NC}"
      cp "$CLAUDE_MD" "$BACKUP_FILE"
      echo -e "${GREEN}✅ 備份完成：${NC}$BACKUP_FILE"
      echo ""
    fi

    # 複製 Pricing Strategist 人格到 CLAUDE.md
    echo -e "${BLUE}📝 切換到 Pricing Strategist 人格...${NC}"
    cp "$PERSONA_FILE" "$CLAUDE_MD"

    echo ""
    echo -e "${GREEN}✅ 人格切換完成！${NC}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}📋 Pricing Strategist (Viona) 人格特性：${NC}"
    echo "   • 課程定價診斷與分析"
    echo "   • 設計定價策略方案"
    echo "   • 市場定位分析"
    echo "   • 數據驅動的商業建議"
    echo ""
    echo -e "${YELLOW}💡 啟動指令：${NC}"
    echo "   在新對話中輸入：進行完整的定價診斷與策略規劃"
    echo ""
    echo -e "${YELLOW}📚 快速參考：${NC}"
    echo "   cat .kiro/personas/pricing-strategist/QUICKSTART.md"
    echo ""
    ;;

  *)
    echo -e "${RED}❌ 錯誤：不支援的人格「$PERSONA」${NC}"
    echo ""
    echo "目前支援的人格："
    echo "  • curator              - Curator 人格（課程內容管理）"
    echo "  • pricing-strategist   - Pricing Strategist 人格（定價策略）"
    echo "  • default              - 預設人格"
    echo ""
    exit 1
    ;;
esac

echo -e "${YELLOW}📌 提醒：${NC}"
echo "   重新開啟 Claude Code 或執行新的對話以載入新人格"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
