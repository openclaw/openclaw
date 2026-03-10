#!/bin/bash
# 微信公众号文章发布全流程脚本
# 用法: ./publish-workflow.sh <HTML文件> <标题> [摘要]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML_FILE="$1"
TITLE="$2"
DIGEST="${3:-}"

if [ -z "$HTML_FILE" ] || [ -z "$TITLE" ]; then
    echo "用法: $0 <HTML文件> <标题> [摘要]"
    echo ""
    echo "示例:"
    echo "  $0 article.html \"文章标题\""
    echo "  $0 article.html \"文章标题\" \"这是文章摘要\""
    echo ""
    echo "默认设置:"
    echo "  - 作者: YanG"
    echo "  - 封面: cover.png"
    exit 1
fi

echo "=========================================="
echo "  微信公众号文章发布全流程"
echo "=========================================="
echo ""

# 检查文件是否存在
if [ ! -f "$HTML_FILE" ]; then
    echo "❌ 错误: 文件不存在: $HTML_FILE"
    exit 1
fi

# 步骤1: 优化HTML格式
echo "📝 步骤1: 优化HTML格式..."
OPTIMIZED_FILE="${HTML_FILE%.html}_optimized.html"
python3 "$SCRIPT_DIR/fix-wechat-style.py" "$HTML_FILE" "$OPTIMIZED_FILE"
echo ""

# 步骤2: 推送到微信草稿箱
echo "🚀 步骤2: 推送到微信公众号草稿箱..."
if [ -n "$DIGEST" ]; then
    python3 "$SCRIPT_DIR/publisher.py" \
        --title "$TITLE" \
        --content "$OPTIMIZED_FILE" \
        --digest "$DIGEST"
else
    python3 "$SCRIPT_DIR/publisher.py" \
        --title "$TITLE" \
        --content "$OPTIMIZED_FILE"
fi

echo ""
echo "=========================================="
echo "✅ 全流程完成！"
echo "=========================================="
echo ""
echo "优化后的文件: $OPTIMIZED_FILE"
echo "请前往微信公众号后台查看草稿"
echo ""
