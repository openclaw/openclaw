---
read_when:
  - 运行或调试 Gateway网关进程时
  - 调查单实例强制机制时
summary: Gateway网关单例守卫：通过 WebSocket 监听器绑定实现
title: Gateway网关锁
x-i18n:
  generated_at: "2026-02-01T20:25:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 15fdfa066d1925da8b4632073a876709f77ca8d40e6828c174a30d953ba4f8e9
  source_path: gateway/gateway-lock.md
  workflow: 14
---

# Gateway网关锁

最后更新：2025-12-11

## 原因

- 确保同一主机上每个基础端口只运行一个 Gateway网关实例；额外的 Gateway网关必须使用隔离的配置文件和唯一端口。
- 在崩溃/SIGKILL 后不会留下过期的锁文件。
- 当控制端口已被占用时，快速失败并给出清晰的错误信息。

## 机制

- Gateway网关在启动时立即通过独占 TCP 监听器绑定 WebSocket 监听器（默认 `ws://127.0.0.1:18789`）。
- 如果绑定失败并返回 `EADDRINUSE`，启动时将抛出 `Gateway网关LockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 操作系统会在进程以任何方式退出时自动释放监听器，包括崩溃和 SIGKILL——无需单独的锁文件或清理步骤。
- 关闭时，Gateway网关会关闭 WebSocket 服务器和底层 HTTP 服务器以及时释放端口。

## 错误表现

- 如果另一个进程持有该端口，启动时将抛出 `Gateway网关LockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 其他绑定失败将表现为 `Gateway网关LockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`。

## 运维说明

- 如果端口被*其他*进程占用，错误信息相同；请释放该端口或使用 `openclaw gateway --port <port>` 选择另一个端口。
- macOS 应用在启动 Gateway网关之前仍会维护自己的轻量级 PID 守卫；运行时锁由 WebSocket 绑定强制执行。
