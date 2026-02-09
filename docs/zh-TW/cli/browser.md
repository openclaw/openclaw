---
summary: "「openclaw browser」的 CLI 參考（設定檔、分頁、動作、擴充功能轉接）"
read_when:
  - 當你使用「openclaw browser」並想要常見任務的範例時
  - 當你想要透過節點主機控制在另一台機器上執行的瀏覽器時
  - 當你想要使用 Chrome 擴充功能轉接（透過工具列按鈕附加／分離）時
title: "瀏覽器"
---

# `openclaw browser`

Manage OpenClaw’s browser control server and run browser actions (tabs, snapshots, screenshots, navigation, clicks, typing).

Related:

- 瀏覽器工具 + API：[Browser tool](/tools/browser)
- Chrome 擴充功能轉接：[Chrome extension](/tools/chrome-extension)

## 常用旗標

- `--url <gatewayWsUrl>`：Gateway WebSocket URL（預設來自設定）。
- `--token <token>`：Gateway 權杖（如需要）。
- `--timeout <ms>`：請求逾時（毫秒）。
- `--browser-profile <name>`：選擇瀏覽器設定檔（預設來自設定）。
- `--json`：機器可讀的輸出（在支援的地方）。

## 快速開始（本機）

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiles

Profiles are named browser routing configs. In practice:

- `openclaw`：啟動／附加到由 OpenClaw 管理的專用 Chrome 執行個體（隔離的使用者資料目錄）。
- `chrome`：透過 Chrome 擴充功能轉接控制你現有的 Chrome 分頁。

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

使用特定設定檔：

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

## 快照／螢幕截圖／動作

快照：

```bash
openclaw browser snapshot
```

螢幕截圖：

```bash
openclaw browser screenshot
```

導覽／點擊／輸入（以參照為基礎的 UI 自動化）：

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 擴充功能轉接（透過工具列按鈕附加）

此模式可讓代理程式控制你手動附加的既有 Chrome 分頁（不會自動附加）。

將未封裝的擴充功能安裝到穩定路徑：

```bash
openclaw browser extension install
openclaw browser extension path
```

接著在 Chrome → `chrome://extensions` → 啟用「Developer mode」→「Load unpacked」→ 選取輸出的資料夾。

完整指南：[Chrome extension](/tools/chrome-extension)

## 遠端瀏覽器控制（節點主機代理）

若 Gateway 與瀏覽器不在同一台機器上，請在具備 Chrome／Brave／Edge／Chromium 的機器上執行 **節點主機**。Gateway 會將瀏覽器動作代理到該節點（不需要獨立的瀏覽器控制伺服器）。 The Gateway will proxy browser actions to that node (no separate browser control server required).

使用 `gateway.nodes.browser.mode` 來控制自動路由，並在多個節點連線時使用 `gateway.nodes.browser.node` 來固定特定節點。

安全性與遠端設定：[Browser tool](/tools/browser)、[Remote access](/gateway/remote)、[Tailscale](/gateway/tailscale)、[Security](/gateway/security)
