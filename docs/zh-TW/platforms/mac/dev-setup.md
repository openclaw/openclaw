---
summary: "OpenClaw macOS 應用程式開發者設定指南"
read_when:
  - 設定 macOS 開發環境時
title: "macOS 開發設定"
---

<!-- markdownlint-disable MD051 -->

# macOS 開發者設定

本指南說明了從原始碼建置與執行 OpenClaw macOS 應用程式的必要步驟。

## 準備工作

在建置應用程式之前，請確保您已安裝以下內容：

1. **Xcode 26.2+**：Swift 開發所需。
2. **Node.js 22+ & pnpm**：Gateway、CLI 及封裝腳本所需。

## 1. 安裝相依項目

安裝專案範圍的相依項目：

```bash
pnpm install
```

## 2. 建置與封裝應用程式

若要建置 macOS 應用程式並將其封裝到 `dist/OpenClaw.app`，請執行：

```bash
./scripts/package-mac-app.sh
```

如果您沒有 Apple 開發者 ID 憑證，腳本將自動使用 **臨時簽署 (ad-hoc signing)** (`-`)。

有關開發執行模式、簽署旗標和 Team ID 疑難排解，請參閱 macOS 應用程式的 README：
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **注意**：臨時簽署的應用程式可能會觸發安全性提示。如果應用程式立即以 "Abort trap 6" 錯誤崩潰，請參閱 [疑難排解](#troubleshooting) 章節。

## 3. 安裝 CLI

macOS 應用程式需要全域安裝 `openclaw` CLI 來管理背景工作。

**安裝方式（建議）：**

1. 開啟 OpenClaw 應用程式。
2. 前往 **General** 設定分頁。
3. 點擊 **"Install CLI"**。

或者，手動安裝：

```bash
npm install -g openclaw @<version>
```

## 疑難排解

### 建置失敗：工具鏈或 SDK 不符

macOS 應用程式建置需要最新的 macOS SDK 和 Swift 6.2 工具鏈。

**系統相依項目（必要）：**

- **軟體更新中可用的最新 macOS 版本**（Xcode 26.2 SDK 所需）
- **Xcode 26.2** (Swift 6.2 工具鏈)

**檢查：**

```bash
xcodebuild -version
xcrun swift --version
```

如果版本不符，請更新 macOS/Xcode Bing 重新執行建置。

### 授權權限時應用程式崩潰

如果您在嘗試允許 **語音辨識 (Speech Recognition)** 或 **麥克風 (Microphone)** 存取權時應用程式崩潰，這可能是由於 TCC 快取損壞或簽署不符所致。

**解決方案：**

1. 重設 TCC 權限：

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. 如果失敗，請暫時更改 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 中的 `BUNDLE_ID`，以強制 macOS 以「全新的狀態」處理。

### Gateway 一直顯示 "Starting..."

如果 Gateway 狀態一直停留在 "Starting..."，請檢查是否有僵屍程序佔用了通訊埠：

```bash
openclaw gateway status
openclaw gateway stop

# 如果您沒有使用 LaunchAgent（開發模式 / 手動執行），請尋找監聽程式：
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

如果是手動執行佔用了通訊埠，請停止該程序 (Ctrl+C)。作為最後手段，請刪除 (kill) 上方找到的 PID。
