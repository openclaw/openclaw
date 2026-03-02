#!/bin/bash
# NAS 图纸智能查询 - 快速脚本失败时自动回退到手动查询
# Usage: ./find-drawing-smart.sh <图纸编号> <企业微信用户 ID>

QUERY="$1"
USER="$2"

if [ -z "$QUERY" ] || [ -z "$USER" ]; then
    echo "用法：$0 <图纸编号> <用户 ID>"
    echo "示例：$0 B0111 WangChong"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔍 正在查找 $QUERY..."

# 方案 1: 尝试快速脚本（5-8 秒）
echo "⚡ 尝试快速查询..."
if "$SCRIPT_DIR/find-drawing-fast.sh" "$QUERY" "$USER" 2>/dev/null; then
    echo "✅ 快速查询成功！"
    exit 0
fi

# 方案 2: 快速脚本失败，回退到手动查询（15-20 秒）
echo "⚠️ 快速查询失败，切换到完整查询模式..."
if "$SCRIPT_DIR/find-drawing-manual.sh" "$QUERY" "$USER"; then
    echo "✅ 完整查询成功！"
    exit 0
fi

# 两种方案都失败
echo "❌ 未找到图纸：$QUERY"
exit 1
