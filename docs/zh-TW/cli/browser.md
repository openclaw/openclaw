---
summary: "OpenClaw 瀏覽器 CLI 的參考資料（剖面、分頁、動作、擴充功能中繼）"
read_when:
  - 您使用 `openclaw browser` 並想了解常見任務的範例
  - 您想透過節點主機控制在另一台機器上執行的瀏覽器
  - 您想使用 Chrome 擴充功能中繼（透過工具列按鈕連接/分離）
title: "browser"
---

# `openclaw browser`

管理 OpenClaw 的瀏覽器控制伺服器並執行瀏覽器動作（分頁、快照、螢幕截圖、導覽、點擊、輸入）。

相關資訊：

- 瀏覽器工具 + API：[瀏覽器工具](/tools/browser)
- Chrome 擴充功能中繼：[Chrome 擴充功能](/tools/chrome-extension)

## 常見旗標

- `--url <gatewayWsUrl>`: Gateway WebSocket URL（預設為設定）。
- `--token <token>`: Gateway 權杖（如果需要）。
- `--timeout <ms>`: 請求逾時（毫秒）。
- `--browser-profile <name>`: 選擇瀏覽器剖面（預設來自設定）。
- `--json`: 機器可讀輸出（在支援的情況下）。

## 快速開始（本機）

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## 剖面

剖面是具名的瀏覽器路由設定。實際上：

- `openclaw`: 啟動/連接至專屬的 OpenClaw 管理 Chrome 實例（隔離的使用者資料目錄）。
- `chrome`: 控制您現有的 Chrome 分頁（透過 Chrome 擴充功能中繼）。

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

使用特定的剖面：

```bash
openclaw browser --browser-profile work tabs
```

## 分頁

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## 快照 / 螢幕截圖 / 動作

快照：

```bash
openclaw browser snapshot
```

螢幕截圖：

```bash
openclaw browser screenshot
```

導覽/點擊/輸入（基於參考的 UI 自動化）：

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 擴充功能中繼（透過工具列按鈕連接）

此模式允許智慧代理控制您手動連接的現有 Chrome 分頁（它不會自動連接）。

安裝未封裝的擴充功能到一個穩定的路徑：

```bash
openclaw browser extension install
openclaw browser extension path
```

然後 Chrome → `chrome://extensions` → 啟用「開發人員模式」→「載入未封裝項目」→ 選取列印的檔案夾。

完整指南：[Chrome 擴充功能](/tools/chrome-extension)

## 遠端瀏覽器控制（節點主機代理）

如果 Gateway 在與瀏覽器不同的機器上執行，請在具有 Chrome/Brave/Edge/Chromium 的機器上執行一個 **節點主機**。Gateway 會將瀏覽器動作代理到該節點（無需獨立的瀏覽器控制伺服器）。

使用 `gateway.nodes.browser.mode` 控制自動路由，以及 `gateway.nodes.browser.node` 以固定特定節點，如果連接了多個節點。

安全性 + 遠端設定：[瀏覽器工具](/tools/browser)、[遠端存取](/gateway/remote)、[Tailscale](/gateway/tailscale)、[安全性](/gateway/security)
