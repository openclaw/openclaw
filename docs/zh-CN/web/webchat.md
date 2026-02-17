---
read_when:
  - 调试或配置 WebChat 访问
summary: 用于聊天 UI 的 loopback WebChat 静态主机和 Gateway 网关 WS 使用
title: WebChat
x-i18n:
  generated_at: "2026-02-03T10:13:28Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b5ee2b462c8c979ac27f80dea0cf12cf62b3c799cf8fd0a7721901e26efeb1a0
  source_path: web/webchat.md
  workflow: 15
---

# WebChat（Gateway 网关 WebSocket UI）

状态：macOS/iOS SwiftUI 聊天 UI 直接与 Gateway 网关 WebSocket 通信。

## 它是什么

- Gateway 网关的原生聊天 UI（无嵌入式浏览器，无本地静态服务器）。
- 使用与其他渠道相同的会话和路由规则。
- 确定性路由：回复始终返回到 WebChat。

## 快速开始

1. 启动 Gateway 网关。
2. 打开 WebChat UI（macOS/iOS 应用）或控制 UI 聊天标签页。
3. 确保已配置 Gateway 网关认证（默认需要，即使在 loopback 上）。

## 工作原理（行为）

- UI 连接到 Gateway 网关 WebSocket 并使用 `chat.history`、`chat.send` 和 `chat.inject`。
- `chat.inject` 直接将助手注释追加到转录并广播到 UI（无智能体运行）。
- 历史记录始终从 Gateway 网关获取（无本地文件监听）。
- 如果 Gateway 网关不可达，WebChat 为只读模式。

## 远程使用

- 远程模式通过 SSH/Tailscale 隧道传输 Gateway 网关 WebSocket。
- 你不需要运行单独的 WebChat 服务器。

## 配置参考（WebChat）

完整配置：[配置](/gateway/configuration)

渠道选项：

- 没有专用的 `webchat.*` 块。WebChat 使用下面的 Gateway 网关端点 + 认证设置。

相关的全局选项：

- `gateway.port`、`gateway.bind`：WebSocket 主机/端口。
- `gateway.auth.mode`、`gateway.auth.token`、`gateway.auth.password`：WebSocket 认证。
- `gateway.remote.url`、`gateway.remote.token`、`gateway.remote.password`：远程 Gateway 网关目标。
- `session.*`：会话存储和主键默认值。
