---
summary: "OpenClaw macOS 應用程式開發者設定指南"
read_when:
  - 設定 macOS 開發環境時
title: "macOS 開發者設定"
---

# macOS 開發者設定

本指南涵蓋了從原始碼建置和執行 OpenClaw macOS 應用程式所需的步驟。

## 先決條件

在建置應用程式之前，請確保已安裝以下項目：

1. **Xcode 26.2+**：Swift 開發所需。
2. **Node.js 22+ & pnpm**：Gateway、CLI 和打包指令碼所需。

## 1. 安裝依賴項目

安裝專案範圍內的依賴項目：

```bash
pnpm install
```

## 2. 建置與打包應用程式

若要建置 macOS 應用程式並將其打包成 `dist/OpenClaw.app`，請執行：

```bash
./scripts/package-mac-app.sh
```

如果您沒有 Apple Developer ID 憑證，指令碼將自動使用 **臨時簽署** (`-`)。

有關開發執行模式、簽署旗標和 Team ID 疑難排解，請參閱 macOS 應用程式的 README：
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **注意**：臨時簽署的應用程式可能會觸發安全性提示。如果應用程式立即崩潰並顯示「Abort trap 6」，請參閱[疑難排解](#troubleshooting)部分。

## 3. 安裝 CLI

macOS 應用程式需要全域安裝 `openclaw` CLI 以管理背景任務。

**安裝方法（建議）：**

1. 開啟 OpenClaw 應用程式。
2. 前往**一般**設定分頁。
3. 點擊**「安裝 CLI」**。

或者，手動安裝：

```bash
npm install -g openclaw @<version>
```

## 疑難排解

### 建置失敗：工具鏈或 SDK 不匹配

macOS 應用程式建置需要最新的 macOS SDK 和 Swift 6.2 工具鏈。

**系統依賴項目（必備）：**

- **軟體更新中可用的最新 macOS 版本**（Xcode 26.2 SDKs 所需）
- **Xcode 26.2** (Swift 6.2 工具鏈)

**檢查：**

```bash
xcodebuild -version
xcrun swift --version
```

如果版本不匹配，請更新 macOS/Xcode 並重新執行建置。

### 應用程式在權限授予時崩潰

如果應用程式在您嘗試允許**語音辨識**或**麥克風**存取時崩潰，這可能是由於 TCC 快取損壞或簽名不匹配所致。

**修復：**

1. 重設 TCC 權限：

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. 如果失敗，請暫時更改 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/apps/macos/package-mac-app.sh) 中的 `BUNDLE_ID`，以強制 macOS 進行「全新開始」。

### Gateway「正在啟動...」無限期

如果 Gateway 狀態一直顯示「正在啟動...」，請檢查是否有殭屍行程佔用連接埠：

```bash
openclaw gateway status
openclaw gateway stop

# 如果您沒有使用 LaunchAgent (開發模式 / 手動執行)，請尋找監聽器：
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

如果手動執行佔用連接埠，請停止該行程 (Ctrl+C)。作為最後手段，請終止您在上方找到的 PID。
