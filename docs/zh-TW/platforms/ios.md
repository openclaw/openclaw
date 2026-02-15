---
summary: "iOS node 應用程式：連接到 Gateway、配對、Canvas 以及疑難排解"
read_when:
  - 配對或重新連接 iOS node 時
  - 從原始碼執行 iOS 應用程式時
  - 偵錯 Gateway 裝置探索或 Canvas 指令時
title: "iOS 應用程式"
---

# iOS 應用程式 (Node)

可用性：內部預覽。iOS 應用程式尚未公開發佈。

## 功能說明

- 透過 WebSocket 連接到 Gateway（區域網路或 tailnet）。
- 提供 node 功能：Canvas、螢幕截圖、相機擷取、位置、對話模式、語音喚醒。
- 接收 `node.invoke` 指令並回報 node 狀態事件。

## 系統需求

- 在另一台裝置（macOS、Linux 或透過 WSL2 的 Windows）上執行的 Gateway。
- 網路路徑：
  - 透過 Bonjour 在同一區域網路，**或**
  - 透過單播 DNS-SD 的 Tailnet（範例網域：`openclaw.internal.`），**或**
  - 手動設定主機/連接埠（備用方案）。

## 快速開始（配對 + 連接）

1. 啟動 Gateway：

```bash
openclaw gateway --port 18789
```

2. 在 iOS 應用程式中，開啟 Settings 並選擇偵測到的 Gateway（或啟用 Manual Host 並輸入主機/連接埠）。

3. 在 Gateway 主機上核准配對請求：

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

### Bonjour (區域網路)

Gateway 會在 `local.` 上宣告 `_openclaw-gw._tcp`。iOS 應用程式會自動列出這些。

### Tailnet (跨網路)

如果 mDNS 被阻擋，請使用單播 DNS-SD 區域（選擇一個網域；例如：`openclaw.internal.`）和 Tailscale split DNS。
請參閱 [Bonjour](/gateway/bonjour) 以取得 CoreDNS 範例。

### 手動主機/連接埠

在 Settings 中，啟用 **Manual Host** 並輸入 Gateway 主機與連接埠（預設為 `18789`）。

## Canvas + A2UI

iOS node 會渲染一個 WKWebView canvas。使用 `node.invoke` 來驅動它：

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

注意事項：

- Gateway canvas 主機提供 `/__openclaw__/canvas/` 和 `/__openclaw__/a2ui/` 服務。
- 當宣告了 canvas 主機 URL 時，iOS node 在連接時會自動導覽至 A2UI。
- 使用 `canvas.navigate` 搭配 `{"url":""}` 可返回內建的架構。

### Canvas eval / 截圖

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 語音喚醒 + 對話模式

- 語音喚醒與對話模式可在 Settings 中設定。
- iOS 可能會暫停背景音訊；當應用程式不處於活動狀態時，請將語音功能視為儘力而為（best-effort）。

## 常見錯誤

- `NODE_BACKGROUND_UNAVAILABLE`：將 iOS 應用程式切換至前台（Canvas/相機/螢幕指令需要前台執行）。
- `A2UI_HOST_NOT_CONFIGURED`：Gateway 未宣告 canvas 主機 URL；請檢查 [Gateway 設定](/gateway/configuration) 中的 `canvasHost`。
- 配對提示未出現：執行 `openclaw nodes pending` 並手動核准。
- 重新安裝後連接失敗：Keychain 配對權杖已被清除；請重新配對 node。

## 相關文件

- [配對](/gateway/pairing)
- [裝置探索](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
