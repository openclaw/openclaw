# OpenClaw macOS 安装器 - 完整指南

## 概述

已创建完整的 macOS 安装器系统，包括：

- Rust 启动器（跨平台兼容）
- .app 应用包构建脚本
- DMG 安装包打包脚本
- 详细使用文档

## 文件清单

| 文件                   | 用途                          |
| ---------------------- | ----------------------------- |
| `launcher/src/main.rs` | Rust 启动器源码（macOS 版本） |
| `build-macos-app.sh`   | 构建 .app 应用包              |
| `create-dmg.sh`        | 创建 DMG 安装镜像             |
| `MACOS_INSTALLER.md`   | 详细使用文档                  |

## 在 macOS 上使用

### 步骤 1：传输文件到 Mac

使用以下任一方法：

- AirDrop
- U 盘
- 网盘
- `scp` 命令

### 步骤 2：在 Mac 上构建

```bash
# 1. 进入项目目录
cd openclaw

# 2. 添加执行权限
chmod +x build-macos-app.sh create-dmg.sh

# 3. 构建 .app
./build-macos-app.sh

# 4. （可选）创建 DMG
./create-dmg.sh
```

### 步骤 3：运行

双击 `OpenClaw.app` 或拖到 Applications 文件夹。

## 功能特性

### 1. 自动环境检测

- 检测 Node.js、pnpm、Git
- 缺失时自动使用 Homebrew 安装
- 支持中国大陆镜像加速

### 2. 交互式菜单

```
[1] 启动 TUI 终端界面
[2] 启动 WebUI 网页界面
[3] 检查并更新代码
[4] 重新检测并安装环境
[0] 退出
```

### 3. 自动获取 Gateway 令牌

- 运行 `openclaw dashboard --no-open`
- 从剪贴板读取完整 URL（包含 token）
- 保存到配置文件
- 自动打开浏览器访问

### 4. 配置持久化

配置文件：`OpenClaw.app/Contents/MacOS/openclaw-launcher.conf`

```
token=your_token_here
ws_url=http://127.0.0.1:18789
```

## 系统要求

- macOS 10.15 (Catalina) 或更高版本
- 支持 Intel 和 Apple Silicon (M1/M2/M3)
- 建议安装 Homebrew（用于自动安装依赖）

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

## 分发方法

### 方法一：直接分发 .app

1. 构建 .app
2. 压缩为 zip：`zip -r OpenClaw.zip OpenClaw.app`
3. 分享 zip 文件

### 方法二：创建 DMG（推荐）

1. 运行 `./create-dmg.sh`
2. 生成 `OpenClaw-Installer.dmg`
3. 用户可以：
   - 双击 DMG
   - 拖拽 OpenClaw.app 到 Applications
   - 完成安装

### 方法三：U 盘分发

1. 将 DMG 复制到 U 盘
2. 用户从 U 盘复制 DMG 到 Mac
3. 安装

## 故障排除

### 问题：无法打开 .app

**解决**：

1. 右键点击 OpenClaw.app
2. 选择"打开"
3. 在弹出的对话框中点击"打开"

### 问题：Node.js 未找到

**解决**：

```bash
# 安装 Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 安装 Node.js
brew install node@22
```

### 问题：Homebrew 未找到

**解决**：先安装 Homebrew（见上）

### 问题：Gateway 启动失败

**解决**：

```bash
# 检查端口占用
lsof -i :18789

# 手动启动 gateway
node openclaw.mjs gateway
```

### 问题：编译失败

**解决**：

```bash
# 确保安装了 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 重新编译
cd launcher
cargo build --release
```

## 开发说明

### 项目结构

```
OpenClaw.app/
└── Contents/
    ├── Info.plist              # 应用元数据
    ├── MacOS/
    │   ├── openclaw-launcher   # Rust 编译产物
    │   └── openclaw            # 启动脚本
    └── Resources/
        ├── openclaw.mjs        # 主程序
        ├── package.json
        ├── dist/               # 编译产物
        ├── src/                # 源码
        ├── extensions/         # 插件
        └── ...
```

### 修改后重新构建

```bash
# 1. 修改源码
nano launcher/src/main.rs

# 2. 重新编译
cd launcher
cargo build --release

# 3. 重新构建 .app
cd ..
./build-macos-app.sh
```

### 跨平台编译（通用二进制）

```bash
# 编译 Intel 版本
cargo build --release --target x86_64-apple-darwin

# 编译 Apple Silicon 版本
cargo build --release --target aarch64-apple-darwin

# 合并为通用二进制
lipo -create \
    target/x86_64-apple-darwin/release/openclaw-launcher \
    target/aarch64-apple-darwin/release/openclaw-launcher \
    -output target/release/openclaw-launcher-universal
```

## 与 Windows 版本对比

| 特性       | Windows       | macOS        |
| ---------- | ------------- | ------------ |
| 启动器     | openclaw.exe  | OpenClaw.app |
| 包管理器   | scoop/winget  | Homebrew     |
| 浏览器打开 | rundll32      | open         |
| 剪贴板读取 | PowerShell    | osascript    |
| 地区检测   | PowerShell    | defaults     |
| 后台进程   | Start-Process | nohup        |

## 下一步

1. 在 Mac 上测试构建脚本
2. 验证所有功能正常工作
3. 创建 DMG 安装包
4. 分发给用户

## 支持

如有问题，请查看：

- `MACOS_INSTALLER.md` - 详细文档
- GitHub Issues - 报告问题
- Discord - 社区支持
