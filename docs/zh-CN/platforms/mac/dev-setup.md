---
read_when:
  - 设置 macOS 开发环境
summary: 面向 OpenClaw macOS 应用开发者的设置指南
title: macOS 开发环境设置
x-i18n:
  generated_at: "2026-02-01T21:32:41Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 4ea67701bd58b7512f945fce58d79e1b3d990fbf45183323a1e3ab9688827623
  source_path: platforms/mac/dev-setup.md
  workflow: 15
---

# macOS 开发者设置

本指南介绍从源代码构建和运行 OpenClaw macOS 应用的必要步骤。

## 前提条件

在构建应用之前，请确保已安装以下内容：

1.  **Xcode 26.2+**：Swift 开发所需。
2.  **Node.js 22+ & pnpm**：Gateway网关、CLI 和打包脚本所需。

## 1. 安装依赖

安装项目的全部依赖：

```bash
pnpm install
```

## 2. 构建和打包应用

要构建 macOS 应用并将其打包为 `dist/OpenClaw.app`，请运行：

```bash
./scripts/package-mac-app.sh
```

如果你没有 Apple Developer ID 证书，脚本将自动使用**临时签名**（`-`）。

有关开发运行模式、签名选项和 Team ID 故障排除，请参阅 macOS 应用 README：
https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md

> **注意**：临时签名的应用可能会触发安全提示。如果应用立即崩溃并显示 "Abort trap 6"，请参阅[故障排除](#troubleshooting)部分。

## 3. 安装 CLI

macOS 应用需要全局安装 `openclaw` CLI 来管理后台任务。

**安装方式（推荐）：**

1.  打开 OpenClaw 应用。
2.  进入 **General** 设置选项卡。
3.  点击 **"Install CLI"**。

或者手动安装：

```bash
npm install -g openclaw@<version>
```

## 故障排除

### 构建失败：工具链或 SDK 不匹配

macOS 应用构建需要最新的 macOS SDK 和 Swift 6.2 工具链。

**系统依赖（必需）：**

- **软件更新中可用的最新 macOS 版本**（Xcode 26.2 SDK 要求）
- **Xcode 26.2**（Swift 6.2 工具链）

**检查：**

```bash
xcodebuild -version
xcrun swift --version
```

如果版本不匹配，请更新 macOS/Xcode 并重新运行构建。

### 授权时应用崩溃

如果在尝试允许**语音识别**或**麦克风**访问时应用崩溃，可能是由于 TCC 缓存损坏或签名不匹配。

**修复方法：**

1. 重置 TCC 权限：
   ```bash
   tccutil reset All bot.molt.mac.debug
   ```
2. 如果仍然无效，在 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 中临时更改 `BUNDLE_ID`，以强制 macOS 使用"全新状态"。

### Gateway网关持续显示"Starting..."

如果 Gateway网关状态一直停留在"Starting..."，请检查是否有僵尸进程占用了端口：

```bash
openclaw gateway status
openclaw gateway stop

# 如果你没有使用 LaunchAgent（开发模式/手动运行），查找监听进程：
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

如果是手动运行的进程占用了端口，请停止该进程（Ctrl+C）。作为最后手段，终止上面找到的 PID。
