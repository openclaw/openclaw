---
read_when:
  - 运行无头节点主机
  - 为 system.run 配对非 macOS 节点
summary: "`openclaw node`（无头节点主机）的 CLI 参考"
title: node
x-i18n:
  generated_at: "2026-02-01T20:21:18Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a8b1a57712663e2285c9ecd306fe57d067eb3e6820d7d8aec650b41b022d995a
  source_path: cli/node.md
  workflow: 14
---

# `openclaw node`

运行一个**无头节点主机**，连接到 Gateway网关 WebSocket 并在本机上暴露
`system.run` / `system.which`。

## 为什么使用节点主机？

当你希望智能体**在网络中的其他机器上运行命令**，而无需在那些机器上安装完整的 macOS 伴侣应用时，可以使用节点主机。

常见用例：

- 在远程 Linux/Windows 机器上运行命令（构建服务器、实验室机器、NAS）。
- 在 Gateway网关上保持执行**沙箱隔离**，但将已批准的运行委派给其他主机。
- 为自动化或 CI 节点提供轻量级、无头的执行目标。

执行仍受**执行审批**和节点主机上的按智能体白名单保护，因此你可以保持命令访问的范围明确可控。

## 浏览器代理（零配置）

如果节点上的 `browser.enabled` 未被禁用，节点主机会自动通告浏览器代理。这使智能体无需额外配置即可在该节点上使用浏览器自动化。

如需在节点上禁用：

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## 前台运行

```bash
openclaw node run --host <gateway-host> --port 18789
```

选项：

- `--host <host>`：Gateway网关 WebSocket 主机（默认：`127.0.0.1`）
- `--port <port>`：Gateway网关 WebSocket 端口（默认：`18789`）
- `--tls`：为 Gateway网关连接使用 TLS
- `--tls-fingerprint <sha256>`：预期的 TLS 证书指纹（sha256）
- `--node-id <id>`：覆盖节点 ID（清除配对令牌）
- `--display-name <name>`：覆盖节点显示名称

## 服务（后台运行）

将无头节点主机安装为用户服务。

```bash
openclaw node install --host <gateway-host> --port 18789
```

选项：

- `--host <host>`：Gateway网关 WebSocket 主机（默认：`127.0.0.1`）
- `--port <port>`：Gateway网关 WebSocket 端口（默认：`18789`）
- `--tls`：为 Gateway网关连接使用 TLS
- `--tls-fingerprint <sha256>`：预期的 TLS 证书指纹（sha256）
- `--node-id <id>`：覆盖节点 ID（清除配对令牌）
- `--display-name <name>`：覆盖节点显示名称
- `--runtime <runtime>`：服务运行时（`node` 或 `bun`）
- `--force`：如果已安装则重新安装/覆盖

管理服务：

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

使用 `openclaw node run` 进行前台节点主机运行（无服务）。

服务命令支持 `--json` 以获取机器可读输出。

## 配对

首次连接会在 Gateway网关上创建一个待处理的节点配对请求。
通过以下方式批准：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

节点主机将其节点 ID、令牌、显示名称和 Gateway网关连接信息存储在
`~/.openclaw/node.json` 中。

## 执行审批

`system.run` 受本地执行审批控制：

- `~/.openclaw/exec-approvals.json`
- [执行审批](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`（从 Gateway网关编辑）
