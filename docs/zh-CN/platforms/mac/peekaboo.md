---
read_when:
  - 在 OpenClaw.app 中托管 PeekabooBridge
  - 通过 Swift Package Manager 集成 Peekaboo
  - 更改 PeekabooBridge 协议/路径
summary: 用于 macOS UI 自动化的 PeekabooBridge 集成
title: Peekaboo Bridge
x-i18n:
  generated_at: "2026-02-01T21:32:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b5b9ddb9a7c59e153a1d5d23c33616bb1542b5c7dadedc3af340aeee9ba03487
  source_path: platforms/mac/peekaboo.md
  workflow: 15
---

# Peekaboo Bridge（macOS UI 自动化）

OpenClaw 可以将 **PeekabooBridge** 作为本地的、权限感知的 UI 自动化代理进行托管。这使得 `peekaboo` CLI 能够驱动 UI 自动化，同时复用 macOS 应用的 TCC 权限。

## 这是什么（以及不是什么）

- **宿主**：OpenClaw.app 可以作为 PeekabooBridge 宿主。
- **客户端**：使用 `peekaboo` CLI（无需单独的 `openclaw ui ...` 界面）。
- **界面**：视觉叠加层保留在 Peekaboo.app 中；OpenClaw 只是一个轻量代理宿主。

## 启用桥接

在 macOS 应用中：

- 设置 → **启用 Peekaboo Bridge**

启用后，OpenClaw 会启动一个本地 UNIX 套接字服务器。如果禁用，宿主会停止，`peekaboo` 将回退到其他可用宿主。

## 客户端发现顺序

Peekaboo 客户端通常按以下顺序尝试宿主：

1. Peekaboo.app（完整用户体验）
2. Claude.app（如已安装）
3. OpenClaw.app（轻量代理）

使用 `peekaboo bridge status --verbose` 查看当前活跃的宿主及使用的套接字路径。你可以通过以下方式覆盖：

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## 安全与权限

- 桥接会验证**调用方的代码签名**；强制执行 TeamID 白名单（Peekaboo 宿主 TeamID + OpenClaw 应用 TeamID）。
- 请求在约 10 秒后超时。
- 如果缺少所需权限，桥接会返回清晰的错误信息，而不是启动系统设置。

## 快照行为（自动化）

快照存储在内存中，并在短暂窗口期后自动过期。如果需要更长的保留时间，请从客户端重新捕获。

## 故障排除

- 如果 `peekaboo` 报告"bridge client is not authorized"，请确保客户端已正确签名，或仅在**调试**模式下使用 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 运行宿主。
- 如果未找到宿主，请打开其中一个宿主应用（Peekaboo.app 或 OpenClaw.app）并确认已授予权限。
