---
summary: "使用 WebSocket 监听器绑定的网关单例保护"
read_when:
  - 运行或调试网关进程
  - 调查单实例强制执行
title: "网关锁定"
---

# 网关锁定

## 原因

- 确保每个主机上每个基础端口只运行一个网关实例；额外的网关必须使用隔离的配置文件和唯一的端口。
- 在崩溃/SIGKILL 后存活，不会留下过时的锁定文件。
- 当控制端口已被占用时，快速失败并显示清晰的错误。

## 机制

- 网关在启动时立即使用独占 TCP 监听器绑定 WebSocket 监听器（默认 `ws://127.0.0.1:18789`）。
- 如果绑定失败并出现 `EADDRINUSE`，启动会抛出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 操作系统在任何进程退出时自动释放监听器，包括崩溃和 SIGKILL—不需要单独的锁定文件或清理步骤。
- 在关闭时，网关关闭 WebSocket 服务器和底层 HTTP 服务器以迅速释放端口。

## 错误表面

- 如果另一个进程占用端口，启动会抛出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 其他绑定失败表现为 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`。

## 操作注意事项

- 如果端口被*另一个*进程占用，错误是相同的；释放端口或使用 `openclaw gateway --port <port>` 选择另一个端口。
- macOS 应用在生成网关之前仍然维护自己的轻量级 PID 保护；运行时锁定由 WebSocket 绑定强制执行。

## 相关

- [多个网关](/gateway/multiple-gateways) — 使用唯一端口运行多个实例
- [故障排除](/gateway/troubleshooting) — 诊断 `EADDRINUSE` 和端口冲突
