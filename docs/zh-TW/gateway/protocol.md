---
summary: "Gateway WebSocket protocol: handshake, frames, versioning"
read_when:
  - Implementing or updating gateway WS clients
  - Debugging protocol mismatches or connect failures
  - Regenerating protocol schema/models
title: Gateway Protocol
---

# Gateway 協議 (WebSocket)

Gateway WS 協議是 OpenClaw 的 **單一控制平面 + 節點傳輸**。所有用戶端（CLI、網頁 UI、macOS 應用程式、iOS/Android 節點、無頭節點）都透過 WebSocket 連接，並在握手時聲明他們的 **角色** + **範圍**。

## Transport

- WebSocket，帶有 JSON 負載的文字框架。
- 第一個框架 **必須** 是一個 `connect` 請求。

## Handshake (連接)

[[BLOCK_1]] Gateway → Client (pre-connect challenge): [[BLOCK_1]]

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client → Gateway:

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

[[BLOCK_1]]

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

當設備 token 被發出時，`hello-ok` 也包括：

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Node 範例

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

## Framing

- **Request**: `{type:"req", id, method, params}`
- **Response**: `{type:"res", id, ok, payload|error}`
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`

具有副作用的方法需要 **冪等鍵**（請參見架構）。

## Roles + scopes

### Roles

- `operator` = 控制平面用戶端 (CLI/UI/自動化)。
- `node` = 能力主機 (相機/螢幕/畫布/system.run)。

### Scopes (operator)

常見範圍：

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

方法範圍只是第一道關卡。一些透過 `chat.send` 的斜線指令在此之上會應用更嚴格的指令級檢查。例如，持久的 `/config set` 和 `/config unset` 寫入需要 `operator.admin`。

### Caps/commands/permissions (node)

[[BLOCK_1]] 節點在連接時聲明能力聲明：[[BLOCK_1]]

- `caps`: 高階能力類別。
- `commands`: 可調用的命令白名單。
- `permissions`: 細緻的開關 (例如 `screen.record`, `camera.capture`).

Gateway 將這些視為 **claims** 並強制執行伺服器端的允許清單。

## Presence

- `system-presence` 會返回以設備身份為鍵的條目。
- 存在條目包括 `deviceId`、`roles` 和 `scopes`，因此用戶介面可以為每個設備顯示單行，即使它同時以 **operator** 和 **node** 連接。

### Node 助手方法

- 節點可以呼叫 `skills.bins` 來獲取當前的技能可執行檔列表，以進行自動允許檢查。

### Operator helper methods

- 操作員可以呼叫 `tools.catalog` (`operator.read`) 來獲取代理的執行時工具目錄。回應包括分組的工具和來源元數據：
  - `source`: `core` 或 `plugin`
  - `pluginId`: 當 `source="plugin"` 時的插件擁有者
  - `optional`: 插件工具是否為可選項

## Exec approvals

- 當執行請求需要批准時，網關會廣播 `exec.approval.requested`。
- 操作員用戶端通過呼叫 `exec.approval.resolve` 來解決（需要 `operator.approvals` 範圍）。
- 對於 `host=node`，`exec.approval.request` 必須包含 `systemRunPlan`（標準 `argv`/`cwd`/`rawCommand`/會話元數據）。缺少 `systemRunPlan` 的請求將被拒絕。

## 版本控制

- `PROTOCOL_VERSION` 住在 `src/gateway/protocol/schema.ts`。
- 用戶端發送 `minProtocol` + `maxProtocol`；伺服器會拒絕不匹配的請求。
- 架構 + 模型是從 TypeBox 定義生成的：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- 如果 `OPENCLAW_GATEWAY_TOKEN` (或 `--token`) 被設定，`connect.params.auth.token` 必須匹配，否則插座將關閉。
- 配對後，Gateway 會發出一個 **設備token**，其範圍為連接角色 + 範圍。它會在 `hello-ok.auth.deviceToken` 中返回，並應由用戶端持久化以便未來連接使用。
- 設備token可以通過 `device.token.rotate` 和 `device.token.revoke` 進行輪換/撤銷（需要 `operator.pairing` 範圍）。
- 認證失敗包括 `error.details.code` 以及恢復提示：
  - `error.details.canRetryWithDeviceToken` (布林值)
  - `error.details.recommendedNextStep` (`retry_with_device_token`, `update_auth_configuration`, `update_auth_credentials`, `wait_then_retry`, `review_auth_configuration`)
- 用戶端對於 `AUTH_TOKEN_MISMATCH` 的行為：
  - 受信任的用戶端可能會嘗試一次有限的重試，使用快取的每設備token。
  - 如果該重試失敗，用戶端應停止自動重新連接循環並提供操作人員的行動指導。

## 裝置身份 + 配對

- 節點應包含從金鑰對指紋衍生的穩定設備身份 (`device.id`)。
- 閘道會根據設備和角色發放token。
- 除非啟用本地自動批准，否則新設備 ID 需要配對批准。
- **本地** 連接包括回送和閘道主機的尾網地址（因此同主機的尾網綁定仍然可以自動批准）。
- 所有 WS 用戶端在 `connect`（操作員 + 節點）期間必須包含 `device` 身份。控制 UI 只有在以下模式中可以省略：
  - `gateway.controlUi.allowInsecureAuth=true` 用於僅限本地主機的不安全 HTTP 相容性。
  - `gateway.controlUi.dangerouslyDisableDeviceAuth=true`（破玻璃，嚴重安全降級）。
- 所有連接必須簽署伺服器提供的 `connect.challenge` 隨機數。

### 裝置認證遷移診斷

對於仍然使用舊版挑戰簽名行為的舊版用戶端，`connect` 現在在 `error.details.code` 下返回 `DEVICE_AUTH_*` 詳細程式碼，並提供穩定的 `error.details.reason`。

常見的遷移失敗：

| 訊息                        | details.code                     | details.reason           | 意義                                          |
| --------------------------- | -------------------------------- | ------------------------ | --------------------------------------------- |
| `device nonce required`     | `DEVICE_AUTH_NONCE_REQUIRED`     | `device-nonce-missing`   | 用戶端省略了 `device.nonce`（或發送了空白）。 |
| `device nonce mismatch`     | `DEVICE_AUTH_NONCE_MISMATCH`     | `device-nonce-mismatch`  | 用戶端使用了過期/錯誤的 nonce 簽名。          |
| `device signature invalid`  | `DEVICE_AUTH_SIGNATURE_INVALID`  | `device-signature`       | 簽名有效載荷與 v2 有效載荷不匹配。            |
| `device signature expired`  | `DEVICE_AUTH_SIGNATURE_EXPIRED`  | `device-signature-stale` | 簽名的時間戳超出了允許的偏差範圍。            |
| `device identity mismatch`  | `DEVICE_AUTH_DEVICE_ID_MISMATCH` | `device-id-mismatch`     | `device.id` 與公鑰指紋不匹配。                |
| `device public key invalid` | `DEVICE_AUTH_PUBLIC_KEY_INVALID` | `device-public-key`      | 公鑰格式/標準化失敗。                         |

[[BLOCK_1]]

- 請始終等待 `connect.challenge`。
- 簽署包含伺服器隨機數的 v2 負載。
- 在 `connect.params.device.nonce` 中發送相同的隨機數。
- 優先使用的簽名負載是 `v3`，它除了設備/用戶端/角色/範圍/token/隨機數欄位外，還綁定了 `platform` 和 `deviceFamily`。
- 為了相容性，舊版 `v2` 簽名仍然被接受，但配對設備的元數據固定仍然控制重新連接時的命令政策。

## TLS + pinning

- WS 連線支援 TLS。
- 用戶端可以選擇性地固定閘道證書指紋（請參見 `gateway.tls` 設定以及 `gateway.remote.tlsFingerprint` 或 CLI `--tls-fingerprint`）。

## Scope

此協議公開了 **完整的閘道 API**（狀態、通道、模型、聊天、代理、會話、節點、批准等）。具體的介面由 `src/gateway/protocol/schema.ts` 中的 TypeBox 架構定義。
