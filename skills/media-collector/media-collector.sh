#!/bin/bash
# Media Collector - 自动化高质量媒体收集工具
# 用法：./media-collector.sh [command] [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/config"
OUTPUT_DIR="$SCRIPT_DIR/output"
LOG_FILE="$SCRIPT_DIR/media-collector.log"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${GREEN}✓${NC} $1" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}✗${NC} $1" | tee -a "$LOG_FILE"
    exit 1
}

# 创建输出目录
mkdir -p "$OUTPUT_DIR/$(date '+%Y-%m-%d')"
mkdir -p "$OUTPUT_DIR/archive"

# 主命令处理
case "$1" in
    hn|hackernews)
        log "收集 Hacker News 热门..."
        shift
        python3 "$SCRIPT_DIR/src/hn_collector.py" "$@"
        success "Hacker News 收集完成"
        ;;
    
    twitter|x)
        log "收集 Twitter 内容..."
        shift
        python3 "$SCRIPT_DIR/src/twitter_collector.py" "$@"
        success "Twitter 收集完成"
        ;;
    
    rss)
        log "收集 RSS 订阅源..."
        shift
        python3 "$SCRIPT_DIR/src/rss_collector.py" "$@"
        success "RSS 收集完成"
        ;;
    
    reddit)
        log "收集 Reddit 热门..."
        shift
        python3 "$SCRIPT_DIR/src/reddit_collector.py" "$@"
        success "Reddit 收集完成"
        ;;
    
    youtube)
        log "收集 YouTube 视频..."
        shift
        python3 "$SCRIPT_DIR/src/youtube_collector.py" "$@"
        success "YouTube 收集完成"
        ;;
    
    digest|summary)
        log "生成每日摘要..."
        shift
        python3 "$SCRIPT_DIR/src/digest_generator.py" "$@"
        success "每日摘要生成完成"
        ;;
    
    search)
        log "搜索已收集内容..."
        shift
        python3 "$SCRIPT_DIR/src/search.py" "$@"
        ;;
    
    quality)
        log "评估内容质量..."
        shift
        python3 "$SCRIPT_DIR/src/quality_scorer.py" "$@"
        ;;
    
    config)
        log "编辑配置文件..."
        open "$CONFIG_DIR/sources.json" 2>/dev/null || nano "$CONFIG_DIR/sources.json"
        ;;
    
    clean)
        log "清理旧数据..."
        find "$OUTPUT_DIR" -name "*.md" -mtime +30 -delete
        success "清理完成"
        ;;
    
    status)
        log "媒体收集器状态"
        echo ""
        echo "📁 输出目录：$OUTPUT_DIR"
        echo "📄 今日文件：$(ls -1 "$OUTPUT_DIR/$(date '+%Y-%m-%d')" 2>/dev/null | wc -l | tr -d ' ')"
        echo "📊 总文件数：$(find "$OUTPUT_DIR" -name "*.md" | wc -l | tr -d ' ')"
        echo ""
        echo "最近收集:"
        ls -lt "$OUTPUT_DIR"/*/ 2>/dev/null | head -10
        ;;
    
    help|--help|-h|"")
        echo "Media Collector - 自动化高质量媒体收集工具"
        echo ""
        echo "用法：$0 [command] [options]"
        echo ""
        echo "可用命令:"
        echo "  hn, hackernews    收集 Hacker News 热门"
        echo "  twitter, x        收集 Twitter 内容"
        echo "  rss               收集 RSS 订阅源"
        echo "  reddit            收集 Reddit 热门"
        echo "  youtube           收集 YouTube 视频"
        echo "  digest, summary   生成每日摘要"
        echo "  search            搜索已收集内容"
        echo "  quality           评估内容质量"
        echo "  config            编辑配置文件"
        echo "  clean             清理 30 天前的数据"
        echo "  status            显示收集器状态"
        echo "  help              显示此帮助信息"
        echo ""
        echo "示例:"
        echo "  $0 hn --limit 20 --min-score 100"
        echo "  $0 twitter --query \"AI\" --limit 50"
        echo "  $0 digest --date today"
        echo "  $0 search \"machine learning\""
        echo ""
        echo "配置文件：$CONFIG_DIR/sources.json"
        echo "输出目录：$OUTPUT_DIR"
        ;;
    
    *)
        error "未知命令：$1"
        echo "使用 '$0 help' 查看可用命令"
        exit 1
        ;;
esac

log "任务完成"
