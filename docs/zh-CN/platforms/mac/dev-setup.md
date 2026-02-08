---
read_when:
  - 设置 macOS 开发环境
summary: 为在 OpenClaw macOS 应用上工作的开发者提供的设置指南
title: macOS 开发设置
x-i18n:
  generated_at: "2026-02-03T07:52:36Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 4ea67701bd58b7512f945fce58d79e1b3d990fbf45183323a1e3ab9688827623
  source_path: platforms/mac/dev-setup.md
  workflow: 15
---

# macOS 开发者设置

本指南涵盖从源代码构建和运行 OpenClaw macOS 应用程序的必要步骤。

## 前置条件

在构建应用之前，确保你已安装以下内容：

1.  **Xcode 26.2+**：Swift 开发所需。
2.  **Node.js 22+ & pnpm**：Gateway 网关、CLI 和打包脚本所需。

## 1. 安装依赖

安装项目范围的依赖：

```bash
pnpm install
```

## 2. 构建和打包应用

要构建 macOS 应用并将其打包到 `dist/OpenClaw.app`，运行：

```bash
./scripts/package-mac-app.sh
```

如果你没有 Apple Developer ID 证书，脚本将自动使用 **ad-hoc 签名**（`-`）。

有关开发运行模式、签名标志和 Team ID 故障排除，请参阅 macOS 应用 README：
https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md

> **注意**：Ad-hoc 签名的应用可能会触发安全提示。如果应用立即崩溃并显示"Abort trap 6"，请参阅[故障排除](#troubleshooting)部分。

## 3. 安装 CLI

macOS 应用期望全局安装 `openclaw` CLI 来管理后台任务。

**安装方法（推荐）：**

1.  打开 OpenClaw 应用。
2.  转到 **General** 设置标签页。
3.  点击 **"Install CLI"**。

或者，手动安装：

```bash
npm install -g openclaw@<version>
```

## 故障排除

### 构建失败：工具链或 SDK 不匹配

macOS 应用构建期望最新的 macOS SDK 和 Swift 6.2 工具链。

**系统依赖（必需）：**

- **软件更新中可用的最新 macOS 版本**（Xcode 26.2 SDK 所需）
- **Xcode 26.2**（Swift 6.2 工具链）

**检查：**

```bash
xcodebuild -version
xcrun swift --version
```

如果版本不匹配，更新 macOS/Xcode 并重新运行构建。

### 授予权限时应用崩溃

如果在尝试允许**语音识别**或**麦克风**访问时应用崩溃，可能是由于 TCC 缓存损坏或签名不匹配。

**修复：**

1. 重置 TCC 权限：
   ```bash
   tccutil reset All bot.molt.mac.debug
   ```
2. 如果这不起作用，在 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 中临时更改 `BUNDLE_ID` 以强制 macOS 从"全新状态"开始。

### Gateway 网关无限期"Starting..."

如果 Gateway 网关状态一直停留在"Starting..."，检查是否有僵尸进程占用端口：

```bash
openclaw gateway status
openclaw gateway stop

# 如果你没有使用 LaunchAgent（开发模式/手动运行），找到监听器：
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

如果手动运行占用了端口，停止该进程（Ctrl+C）。作为最后手段，杀死你找到的 PID。
