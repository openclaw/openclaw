---
read_when:
  - 调试或配置 WebChat 访问
summary: local loopback WebChat 静态主机及 Gateway网关 WebSocket 在聊天 UI 中的使用
title: WebChat
x-i18n:
  generated_at: "2026-02-01T21:44:15Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b5ee2b462c8c979ac27f80dea0cf12cf62b3c799cf8fd0a7721901e26efeb1a0
  source_path: web/webchat.md
  workflow: 15
---

# WebChat（Gateway网关 WebSocket UI）

状态：macOS/iOS SwiftUI 聊天 UI 直接连接 Gateway网关 WebSocket。

## 简介

- 一个 Gateway网关的原生聊天 UI（无内嵌浏览器，无本地静态服务器）。
- 使用与其他渠道相同的会话和路由规则。
- 确定性路由：回复始终返回到 WebChat。

## 快速开始

1. 启动 Gateway网关。
2. 打开 WebChat UI（macOS/iOS 应用）或控制台 UI 的聊天标签页。
3. 确保已配置 Gateway网关认证（默认必需，即使在 local loopback 上也是如此）。

## 工作原理（行为）

- UI 连接到 Gateway网关 WebSocket，使用 `chat.history`、`chat.send` 和 `chat.inject`。
- `chat.inject` 将助手备注直接追加到对话记录中并广播到 UI（不触发智能体运行）。
- 历史记录始终从 Gateway网关获取（无本地文件监听）。
- 如果 Gateway网关不可达，WebChat 为只读模式。

## 远程使用

- 远程模式通过 SSH/Tailscale 隧道传输 Gateway网关 WebSocket。
- 无需运行单独的 WebChat 服务器。

## 配置参考（WebChat）

完整配置：[配置](/gateway/configuration)

渠道选项：

- 没有专用的 `webchat.*` 配置块。WebChat 使用下方的 Gateway网关端点 + 认证设置。

相关全局选项：

- `gateway.port`、`gateway.bind`：WebSocket 主机/端口。
- `gateway.auth.mode`、`gateway.auth.token`、`gateway.auth.password`：WebSocket 认证。
- `gateway.remote.url`、`gateway.remote.token`、`gateway.remote.password`：远程 Gateway网关目标。
- `session.*`：会话存储和主键默认值。
