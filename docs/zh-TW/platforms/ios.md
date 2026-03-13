---
summary: "iOS node app: connect to the Gateway, pairing, canvas, and troubleshooting"
read_when:
  - Pairing or reconnecting the iOS node
  - Running the iOS app from source
  - Debugging gateway discovery or canvas commands
title: iOS App
---

# iOS App (Node)

可用性：內部預覽。iOS 應用尚未公開發佈。

## 功能說明

- 透過 WebSocket 連接到 Gateway（LAN 或 tailnet）。
- 提供節點功能：Canvas、螢幕快照、相機擷取、定位、對講模式、語音喚醒。
- 接收 `node.invoke` 指令並回報節點狀態事件。

## 系統需求

- Gateway 執行於另一台裝置（macOS、Linux，或透過 WSL2 的 Windows）。
- 網路路徑：
  - 同一 LAN 透過 Bonjour，**或**
  - Tailnet 透過單播 DNS-SD（範例網域：`openclaw.internal.`），**或**
  - 手動輸入主機/連接埠（備援方案）。

## 快速開始（配對 + 連線）

1. 啟動 Gateway：

```bash
openclaw gateway --port 18789
```

2. 在 iOS 應用中，開啟設定並選擇已偵測的 Gateway（或啟用手動主機並輸入主機/連接埠）。

3. 在 Gateway 主機上批准配對請求：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

4. 驗證連線狀態：

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 官方版本的中繼推播支援

官方發佈的 iOS 分發版本會使用外部推播中繼站，而非將原始 APNs token 發佈到閘道器。

閘道器端需求：

```json5
{
  gateway: {
    push: {
      apns: {
        relay: {
          baseUrl: "https://relay.example.com",
        },
      },
    },
  },
}
```

流程運作方式：

- iOS 應用程式使用 App Attest 和應用收據向中繼站註冊。
- 中繼站回傳一個不透明的中繼句柄以及一個註冊範圍內的發送授權。
- iOS 應用程式取得配對的閘道器身份，並將其包含在中繼註冊中，使中繼支援的註冊委派給該特定閘道器。
- 應用程式將該中繼支援的註冊透過 `push.apns.register` 轉發給配對的閘道器。
- 閘道器使用該儲存的中繼句柄進行 `push.test`、背景喚醒及喚醒提示。
- 閘道器中繼的基底 URL 必須與官方/TestFlight iOS 版本內建的中繼 URL 相符。
- 若應用程式之後連接到不同的閘道器或使用不同中繼基底 URL 的版本，則會刷新中繼註冊，而非重複使用舊的綁定。

閘道器在此流程中**不需要**：

- 全部署範圍的中繼 token。
- 官方/TestFlight 中繼支援推播所需的直接 APNs 金鑰。

預期的操作流程：

1. 安裝官方/TestFlight iOS 版本。
2. 在閘道器上設定 `gateway.push.apns.relay.baseUrl`。
3. 將應用程式與閘道器配對並完成連線。
4. 當應用程式取得 APNs token、操作員會話已連線且中繼註冊成功後，會自動發佈 `push.apns.register`。
5. 之後，`push.test`、重新連線喚醒及喚醒提示皆可使用儲存的中繼支援註冊。

相容性說明：

- `OPENCLAW_APNS_RELAY_BASE_URL` 仍可作為閘道器的臨時環境覆寫。

## 認證與信任流程

中繼站存在的目的是為了強制執行兩項限制，這是直接在閘道器上使用 APNs 無法為官方 iOS 版本提供的：

- 只有透過 Apple 發佈的正宗 OpenClaw iOS 版本能使用託管的中繼站。
- 閘道器只能對與該特定閘道器配對的 iOS 裝置發送中繼支援的推播。

逐跳流程：

1. `iOS app -> gateway`
   - App 會先透過一般的 Gateway 認證流程與 Gateway 配對。
   - 這會讓 App 獲得一個已認證的節點會話以及一個已認證的操作員會話。
   - 操作員會話用來呼叫 `gateway.identity.get`。

2. `iOS app -> relay`
   - App 透過 HTTPS 呼叫中繼註冊端點。
   - 註冊包含 App Attest 證明以及 App 收據。
   - 中繼會驗證 bundle ID、App Attest 證明和 Apple 收據，並要求官方/正式發行路徑。
   - 這就是阻擋本地 Xcode/開發版本使用託管中繼的原因。本地版本可能已簽署，但不符合中繼所期望的官方 Apple 發行證明。

3. `gateway identity delegation`
   - 在中繼註冊之前，App 從 `gateway.identity.get` 取得已配對的 Gateway 身份。
   - App 將該 Gateway 身份包含在中繼註冊的負載中。
   - 中繼回傳一個中繼句柄和一個註冊範圍的發送授權，這些都委派給該 Gateway 身份。

4. `gateway -> relay`
   - Gateway 會儲存來自 `push.apns.register` 的中繼句柄和發送授權。
   - 在 `push.test`，重新連線喚醒與喚醒推動時，Gateway 會用自己的裝置身份簽署發送請求。
   - 中繼會驗證儲存的發送授權和 Gateway 簽名，是否符合註冊時委派的 Gateway 身份。
   - 其他 Gateway 即使取得該句柄，也無法重用該註冊資料。

5. `relay -> APNs`
   - 中繼擁有正式版本的生產 APNs 憑證和原始 APNs token。
   - Gateway 永遠不會儲存中繼支援的正式版本的原始 APNs token。
   - 中繼會代表已配對的 Gateway 發送最終推播給 APNs。

此設計的目的：

- 將生產用 APNs 憑證從使用者 Gateway 中隔離。
- 避免在 Gateway 上儲存正式版本的原始 APNs token。
- 僅允許官方/TestFlight OpenClaw 版本使用託管中繼。
- 防止一個 Gateway 向屬於其他 Gateway 的 iOS 裝置發送喚醒推播。

本地/手動版本仍直接使用 APNs。如果你在測試這些版本且不使用中繼，Gateway 仍需直接擁有 APNs 憑證：

```bash
export OPENCLAW_APNS_TEAM_ID="TEAMID"
export OPENCLAW_APNS_KEY_ID="KEYID"
export OPENCLAW_APNS_PRIVATE_KEY_P8="$(cat /path/to/AuthKey_KEYID.p8)"
```

## 探測路徑

### Bonjour（區域網路）

Gateway 會在 `local.` 上廣播 `_openclaw-gw._tcp`。iOS App 會自動列出這些。

### Tailnet（跨網路）

如果 mDNS 被封鎖，請使用單播 DNS-SD 區域（選擇一個網域；例如：`openclaw.internal.`）以及 Tailscale 分割 DNS。
請參考 [Bonjour](/gateway/bonjour) 了解 CoreDNS 範例。

### 手動主機/埠號

在設定中，啟用 **手動主機** 並輸入閘道主機與連接埠（預設為 `18789`）。

## Canvas + A2UI

iOS 節點會渲染 WKWebView 畫布。使用 `node.invoke` 來操作它：

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

注意事項：

- 閘道畫布主機提供 `/__openclaw__/canvas/` 和 `/__openclaw__/a2ui/`。
- 它是由閘道 HTTP 伺服器提供（與 `gateway.port` 使用相同連接埠，預設為 `18789`）。
- 當廣告畫布主機 URL 時，iOS 節點連線後會自動導向 A2UI。
- 使用 `canvas.navigate` 和 `{"url":""}` 回到內建的腳手架。

### Canvas 評估 / 快照

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 語音喚醒 + 對話模式

- 語音喚醒與對話模式可在設定中啟用。
- iOS 可能會暫停背景音訊；當應用程式非活躍時，語音功能僅作為盡力而為。

## 常見錯誤

- `NODE_BACKGROUND_UNAVAILABLE`：請將 iOS 應用程式切換到前景（畫布/相機/螢幕指令需要此操作）。
- `A2UI_HOST_NOT_CONFIGURED`：閘道未廣告畫布主機 URL；請檢查 [閘道設定](/gateway/configuration) 中的 `canvasHost`。
- 配對提示從未出現：執行 `openclaw devices list` 並手動批准。
- 重新安裝後無法重新連線：鑰匙圈配對 token 已被清除；請重新配對節點。

## 相關文件

- [配對](/channels/pairing)
- [發現](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
