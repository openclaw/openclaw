#!/bin/bash
# 快速测试脚本

echo "=== 微信公众号草稿发布工具 - 测试 ==="
echo ""

# 检查配置
CONFIG_FILE="$HOME/.wechat-publisher/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ 配置文件不存在，请先运行安装脚本: ./install.sh"
    exit 1
fi

echo "✓ 配置文件存在"
echo ""

# 测试发布示例文章
echo "→ 正在测试发布示例文章..."
echo ""

python3 publisher.py \
    --title "测试文章 - $(date '+%Y-%m-%d %H:%M:%S')" \
    --content example.html \
    --author "测试作者" \
    --digest "这是一篇测试文章"

echo ""
echo "测试完成！请前往公众号后台查看草稿"
