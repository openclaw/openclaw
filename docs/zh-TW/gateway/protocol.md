---
summary: "Gateway WebSocket 協定：握手、框架、版本控制"
read_when:
  - 實作或更新 Gateway WS 用戶端時
  - 偵錯協定不匹配或連線失敗時
  - 重新產生協定結構描述/模型時
    title: "Gateway 協定"
---

# Gateway 協定 (WebSocket)

Gateway WS 協定是 OpenClaw 的單一控制平面與節點傳輸層。所有用戶端（CLI、網頁 UI、macOS 應用程式、iOS/Android 節點、無頭節點）都透過 WebSocket 連線，並在握手時宣告其 **角色 (role)** 與 **範圍 (scope)**。

## 傳輸

- WebSocket，帶有 JSON 酬載 (payload) 的文字框架。
- 第一個框架 **必須** 是 `connect` 請求。

## 握手 (connect)

Gateway → 用戶端 (預連線挑戰)：

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

當核發裝置權杖 (device token) 時，`hello-ok` 也會包含：

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

## 框架格式

- **請求 (Request)**：`{type:"req", id, method, params}`
- **回應 (Response)**：`{type:"res", id, ok, payload|error}`
- **事件 (Event)**：`{type:"event", event, payload, seq?, stateVersion?}`

具副作用的方法需要 **等冪鍵 (idempotency keys)**（請參閱結構描述）。

## 角色與範圍

### 角色

- `operator` = 控制平面用戶端 (CLI/UI/自動化)。
- `node` = 功能主機 (camera/screen/canvas/system.run)。

### 範圍 (操作者)

常用範圍：

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### 功能 (Caps)／指令／權限 (節點)

節點在連線時宣告功能聲明：

- `caps`：高階功能類別。
- `commands`：可呼叫的指令允許清單。
- `permissions`：細粒度切換 (例如 `screen.record`, `camera.capture`)。

Gateway 會將這些視為 **聲明 (claims)** 並強制執行伺服器端的允許清單。

## 在線狀態

- `system-presence` 回傳以裝置識別碼為鍵的項目。
- 在線狀態項目包含 `deviceId`、`roles` 和 `scopes`，以便 UI 即使在裝置同時以 **operator** 和 **node** 身分連線時，也能為每個裝置顯示單一資料列。

### 節點輔助方法

- 節點可以呼叫 `skills.bins` 來獲取目前的 Skills 執行檔列表，以便進行自動允許檢查。

## 執行核准

- 當執行請求需要核准時，Gateway 會廣播 `exec.approval.requested`。
- 操作者用戶端透過呼叫 `exec.approval.resolve` 來解決（需要 `operator.approvals` 範圍）。

## 版本控制

- `PROTOCOL_VERSION` 位於 `src/gateway/protocol/schema.ts`。
- 用戶端傳送 `minProtocol` + `maxProtocol`；伺服器會拒絕不匹配的連線。
- 結構描述與模型是從 TypeBox 定義產生的：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 認證

- 如果設定了 `OPENCLAW_GATEWAY_TOKEN` (或 `--token`)，`connect.params.auth.token` 必須匹配，否則通訊端 (socket) 將被關閉。
- 配對後，Gateway 會核發一個針對連線角色與範圍設定的 **裝置權杖 (device token)**。它會在 `hello-ok.auth.deviceToken` 中回傳，用戶端應將其永久儲存以供未來連線使用。
- 裝置權杖可以透過 `device.token.rotate` 和 `device.token.revoke` 進行輪換或撤銷（需要 `operator.pairing` 範圍）。

## 裝置識別與配對

- 節點應包含一個衍生自金鑰對指紋的穩定裝置識別碼 (`device.id`)。
- Gateway 為每個裝置與角色核發權杖。
- 新的裝置 ID 需要配對核准，除非啟用了本地自動核准。
- **本地 (Local)** 連線包含 local loopback 和 Gateway 主機自身的 tailnet 位址（因此同主機的 tailnet 綁定仍可自動核准）。
- 所有 WS 用戶端在 `connect` 期間必須包含 `device` 識別（操作者與節點）。控制 UI **僅在** 啟用 `gateway.controlUi.allowInsecureAuth` 時可以省略它（或在緊急情況下使用 `gateway.controlUi.dangerouslyDisableDeviceAuth`）。
- 非本地連線必須簽署伺服器提供的 `connect.challenge` nonce。

## TLS 與固定 (Pinning)

- WS 連線支援 TLS。
- 用戶端可以選擇性地固定 Gateway 憑證指紋（請參閱 `gateway.tls` 設定以及 `gateway.remote.tlsFingerprint` 或 CLI `--tls-fingerprint`）。

## 範圍

此協定公開了 **完整的 Gateway API**（狀態、頻道、模型、聊天、智慧代理、工作階段、節點、核准等）。確切的介面由 `src/gateway/protocol/schema.ts` 中的 TypeBox 結構描述定義。
