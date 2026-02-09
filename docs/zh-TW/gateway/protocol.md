---
summary: "Gateway WebSocket 通訊協定：交握、框架、版本控管"
read_when:
  - 實作或更新 Gateway WS 用戶端
  - 偵錯通訊協定不相容或連線失敗
  - 重新產生通訊協定結構描述／模型
title: "Gateway 通訊協定"
---

# Gateway 通訊協定（WebSocket）

Gateway WS 通訊協定是 OpenClaw 的**單一控制平面 + 節點傳輸**。所有用戶端（CLI、Web UI、macOS 應用程式、iOS/Android 節點、無介面節點）皆透過 WebSocket 連線，並在交握時宣告其**角色**與**範圍**。 All clients (CLI, web UI, macOS app, iOS/Android nodes, headless
nodes) connect over WebSocket and declare their **role** + **scope** at
handshake time.

## 29. 傳輸

- WebSocket，文字框架，JSON 載荷。
- 第一個框架**必須**是 `connect` 請求。

## 交握（連線）

Gateway → 用戶端（連線前挑戰）：

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

當裝置權杖被發行時，`hello-ok` 也會包含：

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

## 框架

- **請求**：`{type:"req", id, method, params}`
- **回應**：`{type:"res", id, ok, payload|error}`
- **事件**：`{type:"event", event, payload, seq?, stateVersion?}`

Side-effecting methods require **idempotency keys** (see schema).

## 角色 + 範圍

### 角色

- `operator` = 控制平面用戶端（CLI／UI／自動化）。
- `node` = 能力主機（camera／screen／canvas／system.run）。

### 範圍（操作員）

常見範圍：

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### 能力／命令／權限（節點）

節點在連線時宣告能力主張：

- `caps`：高階能力分類。
- `commands`：可呼叫的命令允許清單。
- `permissions`：細部切換（例如 `screen.record`、`camera.capture`）。

Gateway 會將這些視為**主張**並在伺服器端強制套用允許清單。

## Presence

- `system-presence` 會回傳以裝置身分為鍵的項目。
- 存在狀態項目包含 `deviceId`、`roles` 與 `scopes`，使 UI 即使在同一裝置同時以**操作員**與**節點**連線時，也能顯示為單一列。

### 31. 節點輔助方法

- 節點可呼叫 `skills.bins` 以取得目前 Skills 可執行項目的清單，用於自動允許檢查。

## Exec 核准

- 當 exec 請求需要核准時，Gateway 會廣播 `exec.approval.requested`。
- 操作員用戶端可透過呼叫 `exec.approval.resolve` 進行處理（需要 `operator.approvals` 範圍）。

## 32. 版本管理

- `PROTOCOL_VERSION` 位於 `src/gateway/protocol/schema.ts` 中。
- 用戶端會送出 `minProtocol` + `maxProtocol`；伺服器會拒絕不相符的情況。
- 結構描述與模型由 TypeBox 定義產生：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- 若設定了 `OPENCLAW_GATEWAY_TOKEN`（或 `--token`），`connect.params.auth.token` 必須相符，否則將關閉連線。
- 33. 配對完成後，Gateway 會發行一個以連線角色 + 範圍為界定的**裝置權杖**。 34. 該權杖會在 `hello-ok.auth.deviceToken` 中回傳，客戶端應將其持久化以供日後連線使用。
- 裝置權杖可透過 `device.token.rotate` 與 `device.token.revoke` 進行輪替或撤銷（需要 `operator.pairing` 範圍）。

## 裝置身分 + 配對

- 35. 節點應包含穩定的裝置身分（`device.id`），其來源為金鑰對指紋。
- 36. Gateway 會依每個裝置 + 角色發行權杖。
- 新的裝置 ID 需要配對核准，除非已啟用本地自動核准。
- **本地**連線包含 loopback 與 Gateway 閘道器主機本身的 tailnet 位址（因此同主機的 tailnet 綁定仍可自動核准）。
- 37. 所有 WS 客戶端在 `connect` 時都必須包含 `device` 身分（操作員 + 節點）。
  38. 僅在啟用 `gateway.controlUi.allowInsecureAuth`（或作為破窗用途的 `gateway.controlUi.dangerouslyDisableDeviceAuth`）時，控制 UI 才可省略。
- 非本地連線必須簽署伺服器提供的 `connect.challenge` nonce。

## TLS + 釘選

- WS 連線支援 TLS。
- 用戶端可選擇釘選 Gateway 憑證指紋（請參閱 `gateway.tls` 設定，以及 `gateway.remote.tlsFingerprint` 或 CLI `--tls-fingerprint`）。

## 39. 範圍

This protocol exposes the **full gateway API** (status, channels, models, chat,
agent, sessions, nodes, approvals, etc.). 41. 確切的介面由 `src/gateway/protocol/schema.ts` 中的 TypeBox 結構描述定義。
