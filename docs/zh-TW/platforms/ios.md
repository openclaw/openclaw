---
summary: "iOS 節點應用程式：連接到 Gateway、配對、畫布和疑難排解"
read_when:
  - 配對或重新連接 iOS 節點
  - 從原始碼執行 iOS 應用程式
  - 偵錯 Gateway 裝置探索或畫布指令
title: "iOS 應用程式"
---

# iOS 應用程式（節點）

可用性：內部預覽。iOS 應用程式尚未公開發佈。

## 功能說明

- 透過 WebSocket（LAN 或 tailnet）連接到 Gateway。
- 暴露節點功能：畫布、螢幕快照、相機捕捉、定位、對話模式、語音喚醒。
- 接收 `node.invoke` 指令並回報節點狀態事件。

## 需求

- Gateway 正在另一個裝置（macOS、Linux 或透過 WSL2 的 Windows）上執行。
- 網路路徑：
  - 透過 Bonjour 的相同 LAN，**或**
  - 透過單播 DNS-SD 的 Tailnet（範例網域：`openclaw.internal.`），**或**
  - 手動主機/通訊埠（備用方案）。

## 快速開始（配對 + 連接）

1. 啟動 Gateway：

```bash
openclaw gateway --port 18789
```

2. 在 iOS 應用程式中，開啟設定並選擇一個已探索到的 gateway（或啟用「手動主機」並輸入主機/通訊埠）。

3. 在 gateway 主機上批准配對請求：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. 驗證連接：

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 裝置探索路徑

### Bonjour (LAN)

Gateway 在 `local.` 上公告 `_openclaw-gw._tcp`。iOS 應用程式會自動列出這些。

### Tailnet (跨網路)

如果 mDNS 被封鎖，請使用單播 DNS-SD 區域（選擇一個網域；範例：`openclaw.internal.`）和 Tailscale 分割 DNS。
有關 CoreDNS 範例，請參閱 [Bonjour](/gateway/bonjour)。

### 手動主機/通訊埠

在設定中，啟用 **Manual Host** 並輸入 gateway 主機 + 通訊埠（預設 `18789`）。

## 畫布 + A2UI

iOS 節點會呈現一個 WKWebView 畫布。使用 `node.invoke` 來驅動它：

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

注意事項：

- Gateway 畫布主機提供 `/__openclaw__/canvas/` 和 `/__openclaw__/a2ui/`。
- 當公告畫布主機 URL 時，iOS 節點會在連接時自動導航到 A2UI。
- 使用 `canvas.navigate` 和 `{"url":""}` 返回內建腳手架。

### 畫布評估 / 快照

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 語音喚醒 + 對話模式

- 語音喚醒和對話模式在設定中可用。
- iOS 可能會暫停背景音訊；當應用程式未啟用時，請將語音功能視為盡力而為。

## 常見錯誤

- `NODE_BACKGROUND_UNAVAILABLE`：將 iOS 應用程式帶到前景（畫布/相機/螢幕指令需要它）。
- `A2UI_HOST_NOT_CONFIGURED`：Gateway 未公告畫布主機 URL；請檢查 [Gateway 設定](/gateway/configuration) 中的 `canvasHost`。
- 配對提示從未出現：執行 `openclaw nodes pending` 並手動批准。
- 重新安裝後重新連接失敗：Keychain 配對權杖已清除；請重新配對節點。

## 相關文件

- [配對](/gateway/pairing)
- [裝置探索](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
