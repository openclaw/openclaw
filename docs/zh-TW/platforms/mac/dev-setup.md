---
summary: Setup guide for developers working on the OpenClaw macOS app
read_when:
  - Setting up the macOS development environment
title: macOS Dev Setup
---

# macOS 開發者環境設定

本指南涵蓋從原始碼建置並執行 OpenClaw macOS 應用程式所需的步驟。

## 前置需求

在建置應用程式之前，請確保已安裝以下專案：

1. **Xcode 26.2+**：Swift 開發所需。
2. **Node.js 24 與 pnpm**：建議用於 gateway、CLI 及打包腳本。Node 22 LTS，目前為 `22.16+`，仍維持相容性支援。

## 1. 安裝相依套件

安裝整個專案所需的相依套件：

```bash
pnpm install
```

## 2. 建置並打包應用程式

要建置 macOS 應用程式並打包成 `dist/OpenClaw.app`，請執行：

```bash
./scripts/package-mac-app.sh
```

如果您沒有 Apple Developer ID 證書，腳本會自動使用 **ad-hoc 簽署** (`-`)。

關於開發執行模式、簽署旗標及 Team ID 疑難排解，請參考 macOS 應用程式 README：
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **注意**：ad-hoc 簽署的應用程式可能會觸發安全提示。如果應用程式啟動後立即崩潰並顯示「Abort trap 6」，請參考 [疑難排解](#troubleshooting) 區段。

## 3. 安裝 CLI

macOS 應用程式需要全域 `openclaw` CLI 安裝來管理背景任務。

**安裝方式（建議）：**

1. 開啟 OpenClaw 應用程式。
2. 前往 **一般** 設定分頁。
3. 點擊 **「安裝 CLI」**。

或者，您也可以手動安裝：

```bash
npm install -g openclaw@<version>
```

## 疑難排解

### 建置失敗：工具鏈或 SDK 不匹配

macOS 應用程式建置需要最新的 macOS SDK 以及 Swift 6.2 工具鏈。

**系統相依性（必須）：**

- **軟體更新中可用的最新 macOS 版本**（Xcode 26.2 SDK 所需）
- **Xcode 26.2**（Swift 6.2 工具鏈）

**檢查專案：**

```bash
xcodebuild -version
xcrun swift --version
```

如果版本不符，請更新 macOS/Xcode 並重新執行建置。

### 應用程式在授權時崩潰

如果在嘗試允許 **語音辨識** 或 **麥克風** 權限時應用程式崩潰，可能是因為 TCC 快取損壞或簽章不匹配所致。

**修正：**

1. 重置 TCC 權限：

```bash
   tccutil reset All ai.openclaw.mac.debug
```

2. 如果失敗，暫時修改 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 中的 `BUNDLE_ID`，以強制 macOS 進行「全新開始」。

### Gateway 無限顯示「Starting...」

如果 gateway 狀態持續顯示「Starting...」，請檢查是否有殭屍程序佔用該埠口：

bash
openclaw gateway status
openclaw gateway stop

# 如果你沒有使用 LaunchAgent（開發模式 / 手動執行），請找出監聽程序：

lsof -nP -iTCP:18789 -sTCP:LISTEN

如果是手動執行佔用了埠口，請停止該程序（Ctrl+C）。最後手段是殺掉你剛剛找到的 PID。
