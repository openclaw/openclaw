---
summary: "网络中心：网关表面、配对、发现和安全"
read_when:
  - 你需要网络架构和安全概述
  - 你正在调试本地vs tailnet访问或配对
  - 你想要网络文档的规范列表
title: "网络"
---

# 网络中心

本中心链接了OpenClaw如何在本地主机、LAN和tailnet之间连接、配对和保护设备的核心文档。

## 核心模型

大多数操作通过网关（`openclaw gateway`）进行，这是一个长期运行的单一进程，负责通道连接和WebSocket控制平面。

- **首选环回**：网关WS默认为`ws://127.0.0.1:18789`。
  非环回绑定需要有效的网关认证路径：共享密钥令牌/密码认证，或正确配置的非环回`trusted-proxy`部署。
- **每个主机一个网关**是推荐的。对于隔离，使用隔离的配置文件和端口运行多个网关（[多个网关](/gateway/multiple-gateways)）。
- **Canvas主机**在与网关相同的端口上提供服务（`/__openclaw__/canvas/`，`/__openclaw__/a2ui/`），当绑定超出环回时受到网关认证保护。
- **远程访问**通常是SSH隧道或Tailscale VPN（[远程访问](/gateway/remote)）。

关键参考：

- [网关架构](/concepts/architecture)
- [网关协议](/gateway/protocol)
- [网关运行手册](/gateway)
- [Web表面+绑定模式](/web)

## 配对+身份

- [配对概述（DM + 节点）](/channels/pairing)
- [网关拥有的节点配对](/gateway/pairing)
- [设备CLI（配对+令牌轮换）](/cli/devices)
- [配对CLI（DM批准）](/cli/pairing)

本地信任：

- 直接本地环回连接可以自动批准配对，以保持同一主机的用户体验流畅。
- OpenClaw还具有窄后端/容器本地自连接路径，用于受信任的共享密钥助手流程。
- Tailnet和LAN客户端，包括同一主机的tailnet绑定，仍然需要明确的配对批准。

## 发现+传输

- [发现和传输](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [远程访问（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 节点+传输

- [节点概述](/nodes)
- [桥接协议（传统节点，历史）](/gateway/bridge-protocol)
- [节点运行手册：iOS](/platforms/ios)
- [节点运行手册：Android](/platforms/android)

## 安全

- [安全概述](/gateway/security)
- [网关配置参考](/gateway/configuration)
- [故障排除](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)