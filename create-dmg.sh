#!/bin/bash
# macOS DMG 打包脚本
# 用法：./create-dmg.sh

set -e

echo "════════════════════════════════════════════════════════════"
echo "  OpenClaw Launcher - DMG 打包脚本"
echo "════════════════════════════════════════════════════════════"
echo ""

# 检查 .app 是否存在
APP_NAME="OpenClaw.app"
if [ ! -d "$APP_NAME" ]; then
    echo "错误：未找到 $APP_NAME"
    echo "请先运行 ./build-macos-app.sh"
    exit 1
fi

DMG_NAME="OpenClaw-Installer.dmg"
TEMP_DIR="dmg-temp"

echo "[1/3] 创建临时目录..."
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

echo "[2/3] 复制应用到临时目录..."
cp -R "$APP_NAME" "$TEMP_DIR/"

# 创建 Applications 文件夹快捷方式
ln -s /Applications "$TEMP_DIR/Applications"

echo "[3/3] 创建 DMG..."
# 使用 hdiutil 创建 DMG
hdiutil create -volname "OpenClaw Installer" \
    -srcfolder "$TEMP_DIR" \
    -ov \
    -format UDZO \
    "$DMG_NAME"

# 清理临时目录
rm -rf "$TEMP_DIR"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  DMG 创建完成！"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  DMG 位置：$(pwd)/$DMG_NAME"
echo ""
echo "  分发方法："
echo "  1. 将 $DMG_NAME 复制到 U 盘"
echo "  2. 用户双击 DMG 文件"
echo "  3. 拖拽 OpenClaw.app 到 Applications"
echo ""
