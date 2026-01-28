---
read_when:
  - 实现或更新 Gateway网关 WebSocket 客户端
  - 调试协议不匹配或连接失败问题
  - 重新生成协议 schema/模型
summary: Gateway网关 WebSocket 协议：握手、帧、版本控制
title: Gateway网关协议
x-i18n:
  generated_at: "2026-02-01T20:35:39Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bdafac40d53565901b2df450617287664d77fe4ff52681fa00cab9046b2fd850
  source_path: gateway/protocol.md
  workflow: 14
---

# Gateway网关协议 (WebSocket)

Gateway网关 WebSocket 协议是 OpenClaw 的**统一控制平面 + 节点传输层**。所有客户端（CLI、Web UI、macOS 应用、iOS/Android 节点、无头节点）均通过 WebSocket 连接，并在握手时声明其**角色** + **作用域**。

## 传输

- WebSocket，文本帧携带 JSON 负载。
- 第一帧**必须**是 `connect` 请求。

## 握手 (connect)

Gateway网关 → 客户端（连接前挑战）：

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

客户端 → Gateway网关：

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

Gateway网关 → 客户端：

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

当签发设备令牌时，`hello-ok` 还包含：

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

- **请求**：`{type:"req", id, method, params}`
- **响应**：`{type:"res", id, ok, payload|error}`
- **事件**：`{type:"event", event, payload, seq?, stateVersion?}`

具有副作用的方法需要**幂等键**（参见 schema）。

## 角色 + 作用域

### 角色

- `operator` = 控制平面客户端（CLI/UI/自动化）。
- `node` = 能力宿主（摄像头/屏幕/画布/system.run）。

### 作用域 (operator)

常用作用域：

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### 能力/命令/权限 (node)

节点在连接时声明能力：

- `caps`：高级能力类别。
- `commands`：允许调用的命令白名单。
- `permissions`：细粒度开关（例如 `screen.record`、`camera.capture`）。

Gateway网关将这些视为**声明**，并在服务端执行白名单校验。

## 在线状态

- `system-presence` 返回以设备身份为键的条目。
- 在线状态条目包含 `deviceId`、`roles` 和 `scopes`，这样 UI 可以为每个设备显示一行，即使该设备同时以 **operator** 和 **node** 身份连接。

### 节点辅助方法

- 节点可以调用 `skills.bins` 获取当前 Skills 可执行文件列表，用于自动允许检查。

## 执行审批

- 当执行请求需要审批时，Gateway网关会广播 `exec.approval.requested`。
- Operator 客户端通过调用 `exec.approval.resolve` 进行处理（需要 `operator.approvals` 作用域）。

## 版本控制

- `PROTOCOL_VERSION` 定义在 `src/gateway/protocol/schema.ts` 中。
- 客户端发送 `minProtocol` + `maxProtocol`；服务端在不匹配时拒绝连接。
- Schema 和模型从 TypeBox 定义生成：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## 认证

- 如果设置了 `OPENCLAW_GATEWAY_TOKEN`（或 `--token`），`connect.params.auth.token` 必须匹配，否则连接将被关闭。
- 配对完成后，Gateway网关会签发一个**设备令牌**，其作用域限定为连接的角色 + 作用域。该令牌在 `hello-ok.auth.deviceToken` 中返回，客户端应持久化保存以供后续连接使用。
- 设备令牌可通过 `device.token.rotate` 和 `device.token.revoke` 进行轮换/撤销（需要 `operator.pairing` 作用域）。

## 设备身份 + 配对

- 节点应包含一个稳定的设备身份（`device.id`），由密钥对指纹派生。
- Gateway网关按设备 + 角色签发令牌。
- 新设备 ID 需要配对审批，除非启用了本地自动审批。
- **本地**连接包括 local loopback 和 Gateway网关主机自身的 tailnet 地址（因此同一主机的 tailnet 绑定仍可自动审批）。
- 所有 WebSocket 客户端在 `connect` 时必须包含 `device` 身份（operator + node）。控制 UI 仅在启用 `gateway.controlUi.allowInsecureAuth` 时可以省略（或使用 `gateway.controlUi.dangerouslyDisableDeviceAuth` 作为紧急措施）。
- 非本地连接必须对服务端提供的 `connect.challenge` nonce 进行签名。

## TLS + 证书固定

- WebSocket 连接支持 TLS。
- 客户端可选择固定 Gateway网关证书指纹（参见 `gateway.tls` 配置以及 `gateway.remote.tlsFingerprint` 或 CLI `--tls-fingerprint`）。

## 范围

此协议暴露了**完整的 Gateway网关 API**（状态、渠道、模型、聊天、智能体、会话、节点、审批等）。确切的 API 接口由 `src/gateway/protocol/schema.ts` 中的 TypeBox schema 定义。
