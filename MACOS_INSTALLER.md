# OpenClaw macOS 安装器使用指南

## 快速开始

### 方法一：使用构建脚本（推荐）

1. **克隆项目**

   ```bash
   git clone https://github.com/openclaw/openclaw.git
   cd openclaw
   ```

2. **安装依赖**

   ```bash
   pnpm install
   ```

3. **构建 .app**

   ```bash
   chmod +x build-macos-app.sh
   ./build-macos-app.sh
   ```

4. **运行**
   - 双击 `OpenClaw.app`
   - 或拖到 Applications 文件夹

### 方法二：创建 DMG 安装包

```bash
chmod +x create-dmg.sh
./create-dmg.sh
```

生成的 `OpenClaw-Installer.dmg` 可以：

- 复制到 U 盘分发
- 上传到网盘分享
- 通过 AirDrop 发送

## 功能特性

### 自动环境检测

- 检测 Node.js、pnpm、Git
- 缺失时自动使用 Homebrew 安装

### 交互式菜单

```
╔════════════════════════════════════════════════════════════╗
║                    OpenClaw Launcher                       ║
╠════════════════════════════════════════════════════════════╣
║  [1] 启动 TUI 终端界面                                     ║
║  [2] 启动 WebUI 网页界面                                   ║
║  [3] 检查并更新代码                                        ║
║  [4] 重新检测并安装环境                                    ║
║  [0] 退出                                                  ║
╚════════════════════════════════════════════════════════════╝
```

### 自动获取 Gateway 令牌

- 运行 `openclaw dashboard --no-open`
- 从剪贴板读取完整 URL
- 保存到配置文件
- 自动打开浏览器

## 命令行使用

```bash
# 启动 TUI
./OpenClaw.app/Contents/MacOS/openclaw tui

# 启动 WebUI
./OpenClaw.app/Contents/MacOS/openclaw webui

# 更新代码
./OpenClaw.app/Contents/MacOS/openclaw --update

# 显示帮助
./OpenClaw.app/Contents/MacOS/openclaw --help
```

## 配置文件

配置文件位置：`OpenClaw.app/Contents/MacOS/openclaw-launcher.conf`

格式：

```
token=your_token_here
ws_url=http://127.0.0.1:18789
```

## 系统要求

- macOS 10.15 (Catalina) 或更高版本
- 支持 Intel 和 Apple Silicon (M1/M2/M3)

## 故障排除

### 问题：无法打开 .app

**解决**：右键点击 → 打开 → 确认

### 问题：Node.js 未找到

**解决**：安装 Homebrew 后重新运行

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@22
```

### 问题：Gateway 启动失败

**解决**：检查端口 18789 是否被占用

```bash
lsof -i :18789
```

## 开发说明

### 项目结构

```
OpenClaw.app/
└── Contents/
    ├── Info.plist
    ├── MacOS/
    │   ├── openclaw-launcher  (Rust 编译产物)
    │   └── openclaw           (启动脚本)
    ── Resources/
        ├── openclaw.mjs
        ├── package.json
        ├── dist/
        ├── src/
        └── ...
```

### 重新编译

```bash
cd launcher
cargo build --release
```

### 跨平台编译

```bash
# Intel Mac
cargo build --release --target x86_64-apple-darwin

# Apple Silicon
cargo build --release --target aarch64-apple-darwin

# 通用二进制
lipo -create target/x86_64-apple-darwin/release/openclaw-launcher \
     target/aarch64-apple-darwin/release/openclaw-launcher \
     -output target/release/openclaw-launcher-universal
```

## 许可证

MIT License
