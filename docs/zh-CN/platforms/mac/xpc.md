---
read_when:
  - 编辑 IPC 协议或菜单栏应用 IPC
summary: OpenClaw 应用、gateway 节点传输和 PeekabooBridge 的 macOS IPC 架构
title: macOS IPC
x-i18n:
  generated_at: "2026-02-01T21:33:31Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d0211c334a4a59b71afb29dd7b024778172e529fa618985632d3d11d795ced92
  source_path: platforms/mac/xpc.md
  workflow: 15
---

# OpenClaw macOS IPC 架构

**当前模型：** 本地 Unix 套接字将**节点宿主服务**连接到 **macOS 应用**，用于执行审批和 `system.run`。存在一个 `openclaw-mac` 调试 CLI 用于发现/连接检查；智能体操作仍通过 Gateway网关 WebSocket 和 `node.invoke` 传递。UI 自动化使用 PeekabooBridge。

## 目标

- 单个 GUI 应用实例负责所有面向 TCC 的工作（通知、屏幕录制、麦克风、语音、AppleScript）。
- 精简的自动化接口：Gateway网关 + 节点命令，加上用于 UI 自动化的 PeekabooBridge。
- 可预测的权限：始终使用相同的已签名 bundle ID，由 launchd 启动，确保 TCC 授权持久有效。

## 工作原理

### Gateway网关 + 节点传输

- 应用运行 Gateway网关（本地模式）并作为节点连接到它。
- 智能体操作通过 `node.invoke` 执行（例如 `system.run`、`system.notify`、`canvas.*`）。

### 节点服务 + 应用 IPC

- 无界面的节点宿主服务通过 WebSocket 连接到 Gateway网关。
- `system.run` 请求通过本地 Unix 套接字转发到 macOS 应用。
- 应用在 UI 上下文中执行操作，必要时提示用户确认，并返回输出。

架构图（SCI）：

```
Agent -> Gateway网关 -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge（UI 自动化）

- UI 自动化使用名为 `bridge.sock` 的独立 UNIX 套接字和 PeekabooBridge JSON 协议。
- 宿主优先级顺序（客户端侧）：Peekaboo.app → Claude.app → OpenClaw.app → 本地执行。
- 安全性：bridge 宿主要求允许的 TeamID；仅 DEBUG 模式下的同 UID 回退机制受 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（Peekaboo 约定）保护。
- 详见：[PeekabooBridge 用法](/platforms/mac/peekaboo)。

## 操作流程

- 重启/重新构建：`SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 终止现有实例
  - Swift 构建 + 打包
  - 写入/引导/启动 LaunchAgent
- 单实例：如果另一个具有相同 bundle ID 的实例正在运行，应用会提前退出。

## 安全加固说明

- 优先要求所有特权接口进行 TeamID 匹配。
- PeekabooBridge：`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（仅 DEBUG 模式）可允许同 UID 调用方用于本地开发。
- 所有通信仅限本地；不暴露网络套接字。
- TCC 提示仅来自 GUI 应用 bundle；跨重新构建时保持已签名的 bundle ID 稳定。
- IPC 加固：套接字模式 `0600`、令牌、对端 UID 检查、HMAC 质询/响应、短 TTL。
