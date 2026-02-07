---
read_when:
  - 运行或调试 Gateway 网关进程
  - 调查单实例强制执行
summary: 使用 WebSocket 监听器绑定的 Gateway 网关单例保护
title: Gateway 网关锁
x-i18n:
  generated_at: "2026-02-03T07:47:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 15fdfa066d1925da8b4632073a876709f77ca8d40e6828c174a30d953ba4f8e9
  source_path: gateway/gateway-lock.md
  workflow: 15
---

# Gateway 网关锁

最后更新：2025-12-11

## 原因

- 确保同一主机上每个基础端口只运行一个 Gateway 网关实例；额外的 Gateway 网关必须使用隔离的配置文件和唯一的端口。
- 在崩溃/SIGKILL 后不留下过时的锁文件。
- 当控制端口已被占用时快速失败并给出清晰的错误。

## 机制

- Gateway 网关在启动时立即使用独占 TCP 监听器绑定 WebSocket 监听器（默认 `ws://127.0.0.1:18789`）。
- 如果绑定因 `EADDRINUSE` 失败，启动会抛出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 操作系统在任何进程退出时（包括崩溃和 SIGKILL）自动释放监听器——不需要单独的锁文件或清理步骤。
- 关闭时，Gateway 网关关闭 WebSocket 服务器和底层 HTTP 服务器以及时释放端口。

## 错误表面

- 如果另一个进程持有端口，启动会抛出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 其他绑定失败会显示为 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`。

## 运维说明

- 如果端口被*另一个*进程占用，错误是相同的；释放端口或使用 `openclaw gateway --port <port>` 选择另一个端口。
- macOS 应用在启动 Gateway 网关之前仍维护自己的轻量级 PID 保护；运行时锁由 WebSocket 绑定强制执行。
