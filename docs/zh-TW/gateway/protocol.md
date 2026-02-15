---
summary: "Gateway WebSocket 協定：握手、訊框、版本控制"
read_when:
  - 實作或更新 Gateway WS 用戶端
  - 偵錯協定不符或連線失敗
  - 重新產生協定結構描述/模型
title: "Gateway協定"
---

# Gateway協定 (WebSocket)

Gateway WS 協定是 OpenClaw 的**單一控制平面 + 節點傳輸**。所有用戶端 (CLI、網頁使用者介面、macOS 應用程式、iOS/Android 節點、無頭節點) 皆透過 WebSocket 連線，並在握手時聲明其**角色** + **範圍**。

## 傳輸

- WebSocket，帶有 JSON 酬載的文字訊框。
- 第一個訊框**必須**是 `connect` 請求。

## 握手 (connect)

Gateway → 用戶端 (連線前質詢)：

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

用戶端 → Gateway：

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → 用戶端：

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

當發出裝置憑證時，`hello-ok` 也包含：

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### 節點範例

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## 訊框

- **請求 (Request)**：`{type:"req", id, method, params}`
- **回應 (Response)**：`{type:"res", id, ok, payload|error}`
- **事件 (Event)**：`{type:"event", event, payload, seq?, stateVersion?}`

具副作用的方法需要**冪等鍵** (詳見結構描述)。

## 角色 + 範圍

### 角色

- `operator` = 控制平面用戶端 (CLI/UI/自動化)。
- `node` = 功能主機 (camera/screen/canvas/system.run)。

### 範圍 (operator)

常見範圍：

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### 功能/命令/權限 (node)

節點在連線時聲明功能聲明：

- `caps`：高層次功能類別。
- `commands`：呼叫命令的允許清單。
- `permissions`：細粒度開關 (例如 `screen.record`、`camera.capture`)。

Gateway將這些視為**聲明**並強制執行伺服器端允許清單。

## 在線狀態

- `system-presence` 會傳回以裝置身分作為鍵的項目。
- 在線狀態項目包含 `deviceId`、`roles` 和 `scopes`，因此使用者介面可以為每個裝置顯示單行，
  即使它同時以 **operator** 和 **node** 的身分連線。

### 節點輔助方法

- 節點可以呼叫 `skills.bins` 來擷取 Skills 可執行檔的目前清單，
  用於自動允許檢查。

## 執行核准

- 當執行請求需要核准時，Gateway會廣播 `exec.approval.requested`。
- 操作員用戶端透過呼叫 `exec.approval.resolve` 來解決 (需要 `operator.approvals` 範圍)。

## 版本控制

- `PROTOCOL_VERSION` 位於 `src/gateway/protocol/schema.ts` 中。
- 用戶端傳送 `minProtocol` + `maxProtocol`；伺服器拒絕不符的。
- 結構描述 + 模型是從 TypeBox 定義產生的：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 憑證

- 如果設定了 `OPENCLAW_GATEWAY_TOKEN` (或 `--token`)，`connect.params.auth.token`
  必須符合，否則通訊端會關閉。
- 配對後，Gateway會發出一個**裝置憑證**，其範圍設定為連線角色 + 範圍。它會在 `hello-ok.auth.deviceToken` 中傳回，用戶端應將其持續儲存以供未來連線使用。
- 裝置憑證可透過 `device.token.rotate` 和 `device.token.revoke` 輪換/撤銷 (需要 `operator.pairing` 範圍)。

## 裝置身分 + 配對

- 節點應包含從金鑰對指紋衍生的穩定裝置身分 (`device.id`)。
- Gateway會為每個裝置 + 角色發出憑證。
- 新裝置 ID 需要配對核准，除非啟用本機自動核准。
- **本機**連線包括 local loopback 和 Gateway主機本身的 Tailscale 位址
  (因此同主機 Tailscale 繫結仍可自動核准)。
- 所有 WS 用戶端在 `connect` 期間必須包含 `device` 身分 (operator + node)。
  控制使用者介面**僅在**啟用 `gateway.controlUi.allowInsecureAuth` 時才能省略它
  (或使用 `gateway.controlUi.dangerouslyDisableDeviceAuth` 以供緊急情況使用)。
- 非本機連線必須簽署伺服器提供的 `connect.challenge` nonce。

## TLS + 釘選

- WS 連線支援 TLS。
- 用戶端可選擇釘選 Gateway憑證指紋 (請參閱 `gateway.tls`
  設定以及 `gateway.remote.tlsFingerprint` 或 CLI `--tls-fingerprint`)。

## 範圍

此協定公開了**完整的 Gateway API** (狀態、頻道、模型、聊天、
智慧代理、工作階段、節點、核准等)。確切的介面是由 `src/gateway/protocol/schema.ts` 中的 TypeBox 結構描述定義的。
