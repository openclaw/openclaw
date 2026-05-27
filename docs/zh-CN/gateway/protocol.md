---
read_when:
  - 实现或更新 Gateway 网关 WS 客户端
  - 调试协议不匹配或连接失败
  - 重新生成协议模式/模型
summary: Gateway 网关 WebSocket 协议：握手、帧、版本控制
title: Gateway 网关协议
x-i18n:
  generated_at: "2026-02-03T07:48:42Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bdafac40d53565901b2df450617287664d77fe4ff52681fa00cab9046b2fd850
  source_path: gateway/protocol.md
  workflow: 15
---

# Gateway 网关协议（WebSocket）

Gateway 网关 WS 协议是 OpenClaw 的**单一控制平面 + 节点传输**。所有客户端（CLI、Web UI、macOS 应用、iOS/Android 节点、无头节点）都通过 WebSocket 连接，并在握手时声明其**角色** + **作用域**。

## 传输

- WebSocket，带有 JSON 负载的文本帧。
- 第一帧**必须**是 `connect` 请求。

## 握手（connect）

Gateway 网关 → 客户端（连接前质询）：

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

客户端 → Gateway 网关：

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

Gateway 网关 → 客户端：

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

当颁发设备令牌时，`hello-ok` 还包含：

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### 节点示例

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

## 帧格式

- **Request**：`{type:"req", id, method, params}`
- **Response**：`{type:"res", id, ok, payload|error}`
- **Event**：`{type:"event", event, payload, seq?, stateVersion?}`

有副作用的方法需要**幂等键**（见模式）。

## 角色 + 作用域

### 角色

- `operator` = 控制平面客户端（CLI/UI/自动化）。
- `node` = 能力宿主（camera/screen/canvas/system.run）。

### 作用域（operator）

常用作用域：

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### 能力/命令/权限（node）

节点在连接时声明能力声明：

- `caps`：高级能力类别。
- `commands`：invoke 的命令允许列表。
- `permissions`：细粒度开关（例如 `screen.record`、`camera.capture`）。

Gateway 网关将这些视为**声明**并强制执行服务器端允许列表。

## 在线状态

- `system-presence` 返回以设备身份为键的条目。
- 在线状态条目包含 `deviceId`、`roles` 和 `scopes`，以便 UI 可以为每个设备显示单行，
  即使它同时以 **operator** 和 **node** 身份连接。

### 节点辅助方法

- 节点可以调用 `skills.bins` 来获取当前的 skill 可执行文件列表，
  用于自动允许检查。

## Exec 审批

- 当 exec 请求需要审批时，Gateway 网关广播 `exec.approval.requested`。
- 操作者客户端通过调用 `exec.approval.resolve` 来解决（需要 `operator.approvals` 作用域）。

## 版本控制

- `PROTOCOL_VERSION` 在 `src/gateway/protocol/schema.ts` 中。
- 客户端发送 `minProtocol` + `maxProtocol`；服务器拒绝不匹配的。
- 模式 + 模型从 TypeBox 定义生成：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 认证

- 如果设置了 `OPENCLAW_GATEWAY_TOKEN`（或 `--token`），`connect.params.auth.token`
  必须匹配，否则套接字将被关闭。
- 配对后，Gateway 网关会颁发一个作用于连接角色 + 作用域的**设备令牌**。它在 `hello-ok.auth.deviceToken` 中返回，
  客户端应将其持久化以供将来连接使用。
- 设备令牌可以通过 `device.token.rotate` 和 `device.token.revoke` 轮换/撤销（需要 `operator.pairing` 作用域）。

## 设备身份 + 配对

- 节点应包含从密钥对指纹派生的稳定设备身份（`device.id`）。
- Gateway 网关为每个设备 + 角色颁发令牌。
- 新设备 ID 需要配对批准，除非启用了本地自动批准。
- **本地**连接包括 loopback 和 Gateway 网关主机自身的 tailnet 地址
  （因此同主机 tailnet 绑定仍可自动批准）。
- 所有 WS 客户端在 `connect` 期间必须包含 `device` 身份（operator + node）。
  控制 UI **仅**在启用 `gateway.controlUi.allowInsecureAuth` 时可以省略它
  （或使用 `gateway.controlUi.dangerouslyDisableDeviceAuth` 用于紧急情况）。
- 非本地连接必须签署服务器提供的 `connect.challenge` nonce。

## TLS + 固定

- WS 连接支持 TLS。
- 客户端可以选择性地固定 Gateway 网关证书指纹（见 `gateway.tls`
  配置加上 `gateway.remote.tlsFingerprint` 或 CLI `--tls-fingerprint`）。

## 范围

此协议暴露**完整的 Gateway 网关 API**（status、channels、models、chat、
agent、sessions、nodes、approvals 等）。确切的接口由 `src/gateway/protocol/schema.ts` 中的 TypeBox 模式定义。
