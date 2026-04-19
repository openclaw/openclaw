---
summary: "网络中心：网关界面、配对、发现和安全"
read_when:
  - 您需要网络架构 + 安全概述
  - 您正在调试本地 vs 尾网访问或配对
  - 您需要网络文档的规范列表
title: "网络"
---

# 网络中心

本中心链接了关于 OpenClaw 如何连接、配对和保护跨本地主机、LAN 和尾网设备的核心文档。

## 核心模型

大多数操作流经网关（`openclaw gateway`），这是一个单一的长期运行进程，拥有渠道连接和 WebSocket 控制平面。

- **优先环回**：网关 WS 默认使用 `ws://127.0.0.1:18789`。非环回绑定需要有效的网关身份验证路径：共享密钥令牌/密码身份验证，或正确配置的非环回 `trusted-proxy` 部署。
- 建议**每个主机一个网关**。为了隔离，请使用隔离的配置文件和端口运行多个网关（[多个网关](/gateway/multiple-gateways)）。
- **画布主机**在与网关相同的端口上提供（`/__openclaw__/canvas/`、`/__openclaw__/a2ui/`），当绑定到环回以外的地址时，由网关身份验证保护。
- **远程访问**通常是 SSH 隧道或 Tailscale VPN（[远程访问](/gateway/remote)）。

关键参考资料：

- [网关架构](/concepts/architecture)
- [网关协议](/gateway/protocol)
- [网关运行手册](/gateway)
- [Web 界面 + 绑定模式](/web)

## 配对 + 身份

- [配对概述（DM + 节点）](/channels/pairing)
- [网关拥有的节点配对](/gateway/pairing)
- [设备 CLI（配对 + 令牌轮换）](/cli/devices)
- [配对 CLI（DM 批准）](/cli/pairing)

本地信任：

- 可以自动批准直接本地环回连接进行配对，以保持同一主机的用户体验流畅。
- OpenClaw 还具有狭窄的后端/容器本地自连接路径，用于受信任的共享密钥帮助程序流。
- 尾网和 LAN 客户端，包括同一主机的尾网绑定，仍需要显式配对批准。

## 发现 + 传输

- [发现 & 传输](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [远程访问（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 节点 + 传输

- [节点概述](/nodes)
- [桥接协议（旧版节点，历史）](/gateway/bridge-protocol)
- [节点运行手册：iOS](/platforms/ios)
- [节点运行手册：Android](/platforms/android)

## 安全

- [安全概述](/gateway/security)
- [网关配置参考](/gateway/configuration)
- [故障排除](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
