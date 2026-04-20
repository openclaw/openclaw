---
summary: "`openclaw node` 命令行参考（无头节点主机）"
read_when:
  - 运行无头节点主机
  - 为 system.run 配对非 macOS 节点
title: "node"
---

# `openclaw node`

运行一个**无头节点主机**，连接到 Gateway WebSocket 并在此机器上公开
`system.run` / `system.which`。

## 为什么使用节点主机？

当你希望代理在网络中的**其他机器**上运行命令，而不需要在那里安装完整的 macOS  companion 应用时，使用节点主机。

常见用例：

- 在远程 Linux/Windows 机器（构建服务器、实验室机器、NAS）上运行命令。
- 在网关上保持 exec **沙盒化**，但将已批准的运行委托给其他主机。
- 为自动化或 CI 节点提供轻量级、无头的执行目标。

执行仍然受到节点主机上的**执行批准**和每个代理的允许列表的保护，因此你可以保持命令访问的范围明确。

## 浏览器代理（零配置）

如果节点上未禁用 `browser.enabled`，节点主机会自动宣传浏览器代理。这允许代理在该节点上使用浏览器自动化，无需额外配置。

默认情况下，代理公开节点的正常浏览器配置文件表面。如果你设置了 `nodeHost.browserProxy.allowProfiles`，代理会变得限制性：拒绝非允许列出的配置文件目标，并通过代理阻止持久配置文件创建/删除路由。

如果需要，在节点上禁用它：

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## 运行（前台）

```bash
openclaw node run --host <gateway-host> --port 18789
```

选项：

- `--host <host>`: Gateway WebSocket 主机（默认：`127.0.0.1`）
- `--port <port>`: Gateway WebSocket 端口（默认：`18789`）
- `--tls`: 为网关连接使用 TLS
- `--tls-fingerprint <sha256>`: 预期的 TLS 证书指纹（sha256）
- `--node-id <id>`: 覆盖节点 ID（清除配对令牌）
- `--display-name <name>`: 覆盖节点显示名称

## 节点主机的网关认证

`openclaw node run` 和 `openclaw node install` 从配置/环境中解析网关认证（节点命令上没有 `--token`/`--password` 标志）：

- 首先检查 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`。
- 然后是本地配置回退：`gateway.auth.token` / `gateway.auth.password`。
- 在本地模式下，节点主机有意不继承 `gateway.remote.token` / `gateway.remote.password`。
- 如果 `gateway.auth.token` / `gateway.auth.password` 通过 SecretRef 明确配置且未解析，节点认证解析会失败（无远程回退掩码）。
- 在 `gateway.mode=remote` 中，远程客户端字段（`gateway.remote.token` / `gateway.remote.password`）也符合远程优先级规则。
- 节点主机认证解析仅接受 `OPENCLAW_GATEWAY_*` 环境变量。

## 服务（后台）

将无头节点主机安装为用户服务。

```bash
openclaw node install --host <gateway-host> --port 18789
```

选项：

- `--host <host>`: Gateway WebSocket 主机（默认：`127.0.0.1`）
- `--port <port>`: Gateway WebSocket 端口（默认：`18789`）
- `--tls`: 为网关连接使用 TLS
- `--tls-fingerprint <sha256>`: 预期的 TLS 证书指纹（sha256）
- `--node-id <id>`: 覆盖节点 ID（清除配对令牌）
- `--display-name <name>`: 覆盖节点显示名称
- `--runtime <runtime>`: 服务运行时（`node` 或 `bun`）
- `--force`: 如果已安装，则重新安装/覆盖

管理服务：

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

使用 `openclaw node run` 运行前台节点主机（无服务）。

服务命令接受 `--json` 以获得机器可读的输出。

## 配对

第一次连接会在网关上创建待处理的设备配对请求（`role: node`）。
通过以下方式批准：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

如果节点使用更改的认证详细信息（角色/范围/公钥）重试配对，
之前的待处理请求将被取代，并创建新的 `requestId`。
在批准前再次运行 `openclaw devices list`。

节点主机将其节点 ID、令牌、显示名称和网关连接信息存储在
`~/.openclaw/node.json` 中。

## 执行批准

`system.run` 由本地执行批准控制：

- `~/.openclaw/exec-approvals.json`
- [执行批准](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`（从网关编辑）

对于已批准的异步节点执行，OpenClaw 在提示前准备规范的 `systemRunPlan`。
后来批准的 `system.run` 转发会重用该存储的计划，
因此在创建批准请求后对命令/cwd/会话字段的编辑会被拒绝，而不是更改节点执行的内容。