---
summary: >-
  CLI reference for `openclaw browser` (profiles, tabs, actions, extension
  relay)
read_when:
  - You use `openclaw browser` and want examples for common tasks
  - You want to control a browser running on another machine via a node host
  - >-
    You want to use the Chrome extension relay (attach/detach via toolbar
    button)
title: browser
---

# `openclaw browser`

管理 OpenClaw 的瀏覽器控制伺服器並執行瀏覽器操作（標籤、快照、螢幕截圖、導航、點擊、輸入）。

[[BLOCK_1]]

- 瀏覽器工具 + API: [Browser tool](/tools/browser)
- Chrome 擴充功能中繼: [Chrome extension](/tools/chrome-extension)

## 常用標誌

- `--url <gatewayWsUrl>`: Gateway WebSocket URL（預設為設定中的設定）。
- `--token <token>`: Gateway token（如果需要的話）。
- `--timeout <ms>`: 請求超時（毫秒）。
- `--browser-profile <name>`: 選擇一個瀏覽器設定檔（預設來自設定）。
- `--json`: 機器可讀的輸出（在支援的情況下）。

## 快速開始（本地）

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiles

[[BLOCK_1]]  
Profiles 是命名的瀏覽器路由設定。在實際應用中：  
[[BLOCK_1]]

- `openclaw`: 啟動/附加到由 OpenClaw 管理的專用 Chrome 實例（隔離的使用者資料目錄）。
- `chrome`: 通過 Chrome 擴充功能中繼控制您現有的 Chrome 標籤頁。

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

使用特定的設定檔：

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / actions

Snapshot:

```bash
openclaw browser snapshot
```

[[BLOCK_1]]

```bash
openclaw browser screenshot
```

Navigate/click/type (基於參考的 UI 自動化):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 擴充功能中繼（透過工具列按鈕附加）

此模式允許代理控制您手動附加的現有 Chrome 標籤頁（不會自動附加）。

將未打包的擴充功能安裝到穩定的路徑：

```bash
openclaw browser extension install
openclaw browser extension path
```

然後在 Chrome → `chrome://extensions` → 啟用「開發者模式」→ 「載入未封裝的擴充功能」→ 選擇已列印的資料夾。

完整指南: [Chrome 擴充功能](/tools/chrome-extension)

## 遠端瀏覽器控制 (節點主機代理)

如果 Gateway 執行在與瀏覽器不同的機器上，請在擁有 Chrome/Brave/Edge/Chromium 的機器上執行 **node host**。Gateway 將會將瀏覽器的操作代理到該 node（不需要單獨的瀏覽器控制伺服器）。

使用 `gateway.nodes.browser.mode` 來控制自動路由，並使用 `gateway.nodes.browser.node` 來固定特定的節點，如果有多個節點連接的話。

Security + 遠端設置: [瀏覽器工具](/tools/browser), [遠端存取](/gateway/remote), [Tailscale](/gateway/tailscale), [安全性](/gateway/security)
