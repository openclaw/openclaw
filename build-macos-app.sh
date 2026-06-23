#!/bin/bash
# macOS .app 构建脚本
# 用法：./build-macos-app.sh

set -e

echo "════════════════════════════════════════════════════════════"
echo "  OpenClaw Launcher - macOS .app 构建脚本"
echo "════════════════════════════════════════════════════════════"
echo ""

# 检查是否在 macOS 上运行
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "错误：此脚本只能在 macOS 上运行"
    exit 1
fi

# 检查 Rust 是否安装
if ! command -v cargo &> /dev/null; then
    echo "错误：未找到 Rust/Cargo"
    echo "请安装 Rust: https://rustup.rs/"
    exit 1
fi

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "错误：未找到 Node.js"
    echo "请安装 Node.js >= 22.19"
    exit 1
fi

echo "[1/5] 编译 Rust 启动器..."
cd "$(dirname "$0")/launcher"
cargo build --release --target aarch64-apple-darwin 2>/dev/null || cargo build --release --target x86_64-apple-darwin 2>/dev/null || cargo build --release

echo "[2/5] 创建 .app 目录结构..."
APP_NAME="OpenClaw.app"
APP_DIR="../$APP_NAME"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

# 清理旧版本
rm -rf "$APP_DIR"

# 创建目录结构
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

echo "[3/5] 复制文件..."
# 复制启动器
LAUNCHER_BIN=$(find target/release -name "openclaw-launcher" -type f | head -1)
if [ -z "$LAUNCHER_BIN" ]; then
    echo "错误：未找到编译产物"
    exit 1
fi
cp "$LAUNCHER_BIN" "$MACOS_DIR/openclaw-launcher"
chmod +x "$MACOS_DIR/openclaw-launcher"

# 复制项目文件到 Resources
cd ..
cp openclaw.mjs "$RESOURCES_DIR/"
cp package.json "$RESOURCES_DIR/"
cp pnpm-workspace.yaml "$RESOURCES_DIR/" 2>/dev/null || true

# 复制必要目录
for dir in dist src extensions scripts docs; do
    if [ -d "$dir" ]; then
        cp -R "$dir" "$RESOURCES_DIR/" 2>/dev/null || true
    fi
done

echo "[4/5] 创建 Info.plist..."
cat > "$CONTENTS_DIR/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>openclaw-launcher</string>
    <key>CFBundleIdentifier</key>
    <string>ai.openclaw.launcher</string>
    <key>CFBundleName</key>
    <string>OpenClaw</string>
    <key>CFBundleDisplayName</key>
    <string>OpenClaw</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
    <key>NSAppleEventsUsageDescription</key>
    <string>OpenClaw needs to access the clipboard to retrieve the gateway token.</string>
</dict>
</plist>
EOF

echo "[5/5] 创建启动脚本..."
cat > "$MACOS_DIR/openclaw" << 'EOF'
#!/bin/bash
# OpenClaw 启动脚本
cd "$(dirname "$0")/../Resources"
exec "$(dirname "$0")/openclaw-launcher" "$@"
EOF
chmod +x "$MACOS_DIR/openclaw"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  构建完成！"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  应用位置：$(pwd)/$APP_NAME"
echo ""
echo "  使用方法："
echo "  1. 双击 $APP_NAME 启动"
echo "  2. 或拖到 Applications 文件夹"
echo ""
echo "  命令行使用："
echo "  $APP_NAME/Contents/MacOS/openclaw tui"
echo "  $APP_NAME/Contents/MacOS/openclaw webui"
echo ""
