#!/bin/bash
# WeChat Draft Publisher 安装脚本

set -e

echo "==================================================="
echo "  微信公众号草稿发布工具 - 安装向导"
echo "==================================================="
echo ""

# 检查Python
if ! command -v python3 &> /dev/null; then
    echo "❌ 错误: 未找到python3，请先安装Python 3.6+"
    exit 1
fi

echo "✓ Python版本: $(python3 --version)"

# 检查requests库
echo "→ 检查依赖..."
if ! python3 -c "import requests" 2>/dev/null; then
    echo "→ 正在安装requests库..."
    pip3 install requests
fi

echo "✓ 依赖检查完成"
echo ""

# 创建配置目录
CONFIG_DIR="$HOME/.wechat-publisher"
echo "→ 创建配置目录: $CONFIG_DIR"
mkdir -p "$CONFIG_DIR"

# 配置AppID和AppSecret
if [ -f "$CONFIG_DIR/config.json" ]; then
    echo "⚠ 配置文件已存在: $CONFIG_DIR/config.json"
    read -p "是否覆盖? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "跳过配置文件创建"
        CONFIG_EXISTS=true
    fi
fi

if [ -z "$CONFIG_EXISTS" ]; then
    echo ""
    echo "请输入微信公众号凭证信息："
    echo "（在公众平台 → 设置与开发 → 基本配置 中获取）"
    echo ""

    read -p "AppID: " APPID
    read -p "AppSecret: " APPSECRET

    # 创建配置文件
    cat > "$CONFIG_DIR/config.json" << EOF
{
  "appid": "$APPID",
  "appsecret": "$APPSECRET"
}
EOF

    chmod 600 "$CONFIG_DIR/config.json"
    echo "✓ 配置文件已创建并设置权限为600"
fi

echo ""
echo "==================================================="
echo "  安装完成！"
echo "==================================================="
echo ""
echo "使用方法："
echo ""
echo "1. 命令行模式："
echo "   python3 publisher.py --title \"标题\" --content article.html"
echo ""
echo "2. 交互式模式："
echo "   python3 publisher.py --interactive"
echo ""
echo "3. 查看帮助："
echo "   python3 publisher.py --help"
echo ""
echo "配置文件位置: $CONFIG_DIR/config.json"
echo "Token缓存位置: $CONFIG_DIR/token_cache.json"
echo ""
