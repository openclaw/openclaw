---
read_when:
  - 编辑 IPC 合约或菜单栏应用 IPC
summary: OpenClaw 应用的 macOS IPC 架构、Gateway 网关节点传输和 PeekabooBridge
title: macOS IPC
x-i18n:
  generated_at: "2026-02-03T07:52:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d0211c334a4a59b71afb29dd7b024778172e529fa618985632d3d11d795ced92
  source_path: platforms/mac/xpc.md
  workflow: 15
---

# OpenClaw macOS IPC 架构

**当前模型：** 一个本地 Unix 套接字将**节点主机服务**连接到 **macOS 应用**，用于 exec 审批 + `system.run`。存在一个 `openclaw-mac` 调试 CLI 用于发现/连接检查；智能体操作仍通过 Gateway 网关 WebSocket 和 `node.invoke` 流转。UI 自动化使用 PeekabooBridge。

## 目标

- 单个 GUI 应用实例拥有所有面向 TCC 的工作（通知、屏幕录制、麦克风、语音、AppleScript）。
- 小型自动化接口：Gateway 网关 + 节点命令，加上用于 UI 自动化的 PeekabooBridge。
- 可预测的权限：始终是同一个签名的 bundle ID，由 launchd 启动，因此 TCC 授权保持有效。

## 工作原理

### Gateway 网关 + 节点传输

- 应用运行 Gateway 网关（本地模式）并作为节点连接到它。
- 智能体操作通过 `node.invoke` 执行（例如 `system.run`、`system.notify`、`canvas.*`）。

### 节点服务 + 应用 IPC

- 一个无头节点主机服务连接到 Gateway 网关 WebSocket。
- `system.run` 请求通过本地 Unix 套接字转发到 macOS 应用。
- 应用在 UI 上下文中执行 exec，必要时提示，并返回输出。

图示（SCI）：

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge（UI 自动化）

- UI 自动化使用名为 `bridge.sock` 的单独 UNIX 套接字和 PeekabooBridge JSON 协议。
- 主机优先顺序（客户端侧）：Peekaboo.app → Claude.app → OpenClaw.app → 本地执行。
- 安全性：桥接主机需要允许的 TeamID；仅 DEBUG 的同 UID 逃逸通道由 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 保护（Peekaboo 约定）。
- 参见：[PeekabooBridge 用法](/platforms/mac/peekaboo)了解详情。

## 操作流程

- 重启/重建：`SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 终止现有实例
  - Swift 构建 + 打包
  - 写入/引导/启动 LaunchAgent
- 单实例：如果具有相同 bundle ID 的另一个实例正在运行，应用会提前退出。

## 加固注意事项

- 优先要求所有特权接口的 TeamID 匹配。
- PeekabooBridge：`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（仅 DEBUG）可能允许同 UID 调用者用于本地开发。
- 所有通信仅保持本地；不暴露网络套接字。
- TCC 提示仅源自 GUI 应用包；在重建时保持签名的 bundle ID 稳定。
- IPC 加固：套接字模式 `0600`、令牌、对等 UID 检查、HMAC 质询/响应、短 TTL。
