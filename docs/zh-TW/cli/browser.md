---
summary: "openclaw browser 的 CLI 參考文件（設定檔、分頁、操作、擴充功能轉發）"
read_when:
  - 當您使用 `openclaw browser` 並需要常用任務的範例時
  - 當您想透過節點主機 (node host) 控制在另一台機器上執行的瀏覽器時
  - 當您想使用 Chrome 擴充功能轉發（透過工具列按鈕連接/中斷連接）時
title: "browser"
---

# `openclaw browser`

管理 OpenClaw 的瀏覽器控制伺服器並執行瀏覽器操作（分頁、快照、螢幕截圖、導覽、點擊、輸入）。

相關內容：

- 瀏覽器工具 + API：[Browser tool](/tools/browser)
- Chrome 擴充功能轉發：[Chrome extension](/tools/chrome-extension)

## 常用旗標

- `--url <gatewayWsUrl>`：Gateway WebSocket URL（預設為設定值）。
- `--token <token>`：Gateway token（如果需要）。
- `--timeout <ms>`：請求逾時（毫秒）。
- `--browser-profile <name>`：選擇瀏覽器設定檔（預設為設定中的值）。
- `--json`：機器可讀的輸出格式（若支援）。

## 快速開始（本地）

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## 設定檔 (Profiles)

設定檔是具名的瀏覽器路由設定。實務上：

- `openclaw`：啟動/連接到一個專用的 OpenClaw 管理 Chrome 執行體（具備隔離的使用者資料目錄）。
- `chrome`：透過 Chrome 擴充功能轉發控制您現有的 Chrome 分頁。

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

使用特定設定檔：

```bash
openclaw browser --browser-profile work tabs
```

## 分頁 (Tabs)

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## 快照 / 螢幕截圖 / 操作

快照：

```bash
openclaw browser snapshot
```

螢幕截圖：

```bash
openclaw browser screenshot
```

導覽/點擊/輸入（基於 ref 的 UI 自動化）：

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 擴充功能轉發（透過工具列按鈕連接）

此模式讓智慧代理控制您手動連接的現有 Chrome 分頁（它不會自動連接）。

將解壓縮後的擴充功能安裝到穩定路徑：

```bash
openclaw browser extension install
openclaw browser extension path
```

然後在 Chrome → `chrome://extensions` → 開啟「開發者模式」 → 「載入解壓縮」 → 選擇印出的資料夾。

完整指南：[Chrome extension](/tools/chrome-extension)

## 遠端瀏覽器控制（節點主機代理）

如果 Gateway 在與瀏覽器不同的機器上執行，請在裝有 Chrome/Brave/Edge/Chromium 的機器上執行 **node host**。Gateway 將會把瀏覽器操作代理至該節點（不需要獨立的瀏覽器控制伺服器）。

使用 `gateway.nodes.browser.mode` 控制自動路由，如果連接了多個節點，請使用 `gateway.nodes.browser.node` 指定特定節點。

安全性 + 遠端設定：[Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
