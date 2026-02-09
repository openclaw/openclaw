---
summary: "iOS 節點應用程式：連線至 Gateway 閘道器、配對、畫布與疑難排解"
read_when:
  - 配對或重新連線 iOS 節點
  - 從原始碼執行 iOS 應用程式
  - 除錯 Gateway 閘道器探索或畫布命令
title: "iOS 應用程式"
---

# iOS 應用程式（Node）

可用性：內部預覽。 The iOS app is not publicly distributed yet.

## What it does

- 透過 WebSocket（LAN 或 tailnet）連線至 Gateway 閘道器。
- 提供節點能力：Canvas、螢幕快照、相機擷取、位置、對話模式、語音喚醒。
- 接收 `node.invoke` 命令並回報節點狀態事件。

## 需求

- Gateway 閘道器需在另一個裝置上執行（macOS、Linux，或透過 WSL2 的 Windows）。
- 網路路徑：
  - 透過 Bonjour 的同一個 LAN，**或**
  - 透過單播 DNS-SD 的 Tailnet（範例網域：`openclaw.internal.`），**或**
  - Manual host/port (fallback).

## 快速開始（配對＋連線）

1. 啟動 Gateway 閘道器：

```bash
openclaw gateway --port 18789
```

2. 在 iOS 應用程式中，開啟 Settings 並選擇已探索到的 Gateway 閘道器（或啟用 Manual Host 並輸入主機／連接埠）。

3. Approve the pairing request on the gateway host:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. 驗證連線：

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 探索路徑

### Bonjour（LAN）

Gateway 閘道器會在 `local.` 上公告 `_openclaw-gw._tcp`。iOS 應用程式會自動列出這些項目。 The iOS app lists these automatically.

### Tailnet（跨網路）

若 mDNS 被封鎖，請使用單播 DNS-SD 區域（選擇一個網域；範例：`openclaw.internal.`）以及 Tailscale 分割 DNS。
請參閱 [Bonjour](/gateway/bonjour) 以取得 CoreDNS 範例。
See [Bonjour](/gateway/bonjour) for the CoreDNS example.

### 手動主機／連接埠

在 Settings 中啟用 **Manual Host**，並輸入 Gateway 閘道器主機＋連接埠（預設為 `18789`）。

## Canvas + A2UI

iOS 節點會渲染 WKWebView 畫布。使用 `node.invoke` 來驅動它： Use `node.invoke` to drive it:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

注意事項：

- Gateway 閘道器的畫布主機會提供 `/__openclaw__/canvas/` 與 `/__openclaw__/a2ui/`。
- 當公告畫布主機 URL 時，iOS 節點會在連線時自動導向 A2UI。
- 使用 `canvas.navigate` 與 `{"url":""}` 返回內建的 scaffold。

### Canvas eval／snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 語音喚醒＋對話模式

- 語音喚醒與對話模式可在 Settings 中使用。
- iOS 可能會暫停背景音訊；當應用程式未在前景時，請將語音功能視為最佳努力。

## 常見錯誤

- `NODE_BACKGROUND_UNAVAILABLE`：將 iOS 應用程式切換到前景（畫布／相機／螢幕命令需要如此）。
- `A2UI_HOST_NOT_CONFIGURED`：Gateway 閘道器未公告畫布主機 URL；請在 [Gateway 設定](/gateway/configuration) 中檢查 `canvasHost`。
- 配對提示未出現：執行 `openclaw nodes pending` 並手動核准。
- 重新安裝後無法重新連線：Keychain 的配對權杖已被清除；請重新配對節點。

## 相關文件

- [配對](/gateway/pairing)
- [探索](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
