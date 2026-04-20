---
summary: "网络中心：网关表面、配对、发现和安全"
read_when:
  - 您需要网络架构和安全概述
  - 您正在调试本地与 tailnet 访问或配对
  - 您想要网络文档的规范列表
title: "网络"
---

# 网络中心

本中心链接了 OpenClaw 如何在 localhost、LAN 和 tailnet 之间连接、配对和保护设备的核心文档。

## 核心模型

大多数操作通过网关 (`openclaw gateway`) 进行，这是一个拥有通道连接和 WebSocket 控制平面的单一长期运行进程。

- **优先使用环回**：网关 WS 默认值为 `ws://127.0.0.1:18789`。非环回绑定需要有效的网关认证路径：共享密钥令牌/密码认证，或正确配置的非环回 `trusted-proxy` 部署。
- **每台主机一个网关** 是推荐的。为了隔离，可以使用隔离的配置文件和端口运行多个网关（[多个网关](/gateway/multiple-gateways)）。
- **Canvas 主机** 与网关在同一端口上提供服务（`/__openclaw__/canvas/`、`/__openclaw__/a2ui/`），当绑定超出环回时，受网关认证保护。
- **远程访问** 通常是 SSH 隧道或 Tailscale VPN（[远程访问](/gateway/remote)）。

关键参考：

- [网关架构](/concepts/architecture)
- [网关协议](/gateway/protocol)
- [网关运行手册](/gateway)
- [Web 表面 + 绑定模式](/web)

## 配对 + 身份

- [配对概述（DM + 节点）](/channels/pairing)
- [网关拥有的节点配对](/gateway/pairing)
- [设备 CLI（配对 + 令牌轮换）](/cli/devices)
- [配对 CLI（DM 批准）](/cli/pairing)

本地信任：

- 直接本地环回连接可以自动批准配对，以保持同主机用户体验流畅。
- OpenClaw 还为可信共享密钥辅助流程提供了窄后端/容器本地自连接路径。
- Tailnet 和 LAN 客户端，包括同主机 tailnet 绑定，仍然需要明确的配对批准。

## 发现 + 传输

- [发现和传输](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [远程访问（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 节点 + 传输

- [节点概述](/nodes)
- [桥接协议（旧节点，历史）](/gateway/bridge-protocol)
- [节点运行手册：iOS](/platforms/ios)
- [节点运行手册：Android](/platforms/android)

## 安全

- [安全概述](/gateway/security)
- [网关配置参考](/gateway/configuration)
- [故障排除](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
