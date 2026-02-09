---
summary: "為從事 OpenClaw macOS 應用程式開發的開發者提供的設定指南"
read_when:
  - 設定 macOS 開發環境時
title: "macOS 開發者設定"
---

# macOS 開發者設定

本指南說明從原始碼建置並執行 OpenClaw macOS 應用程式所需的必要步驟。

## 先決條件

在建置應用程式之前，請確保已安裝以下項目：

1. **Xcode 26.2+**：Swift 開發所需。
2. **Node.js 22+ 與 pnpm**：Gateway 閘道器、CLI 以及封裝指令碼所需。

## 1) 安裝相依套件

Install the project-wide dependencies:

```bash
pnpm install
```

## 2. 建置並封裝應用程式

若要建置 macOS 應用程式並將其封裝為 `dist/OpenClaw.app`，請執行：

```bash
./scripts/package-mac-app.sh
```

如果您沒有 Apple Developer ID 憑證，該指令碼將自動使用 **ad-hoc 簽署**（`-`）。

如需瞭解開發執行模式、簽署旗標以及 Team ID 疑難排解，請參閱 macOS 應用程式 README：
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Note**: Ad-hoc signed apps may trigger security prompts. If the app crashes immediately with "Abort trap 6", see the [Troubleshooting](#troubleshooting) section.

## 3. 安裝 CLI

macOS 應用程式需要全域安裝的 `openclaw` CLI 來管理背景工作。

**安裝方式（建議）：**

1. 開啟 OpenClaw 應用程式。
2. 前往 **General** 設定分頁。
3. 點擊 **「Install CLI」**。

或者，您也可以手動安裝：

```bash
npm install -g openclaw@<version>
```

## Troubleshooting

### 建置失敗：工具鏈或 SDK 不相容

macOS 應用程式的建置預期使用最新的 macOS SDK 與 Swift 6.2 工具鏈。

**系統相依套件（必須）：**

- **透過「軟體更新」提供的最新 macOS 版本**（Xcode 26.2 SDK 所需）
- **Xcode 26.2**（Swift 6.2 工具鏈）

**檢查方式：**

```bash
xcodebuild -version
xcrun swift --version
```

若版本不相符，請更新 macOS／Xcode，然後重新執行建置。

### App Crashes on Permission Grant

如果在嘗試允許 **語音辨識** 或 **麥克風** 存取時應用程式發生當機，可能是因為 TCC 快取損毀或簽章不相符。

**解決方式：**

1. 重設 TCC 權限：

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. 若仍無法解決，請在 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 中暫時變更 `BUNDLE_ID`，以強制 macOS 從「全新狀態」重新處理。

### Gateway 一直顯示「Starting...」

如果 Gateway 閘道器狀態持續停留在「Starting...」，請檢查是否有殭屍程序佔用了連接埠：

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

If a manual run is holding the port, stop that process (Ctrl+C). As a last resort, kill the PID you found above.
