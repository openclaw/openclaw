---
read_when:
  - 你需要了解网络架构和安全概述
  - 你正在调试本地访问、tailnet 访问或配对问题
  - 你想要获取网络文档的权威列表
summary: 网络中心：Gateway 网关接口、配对、设备发现和安全
title: 网络
x-i18n:
  generated_at: "2026-02-03T10:07:45Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0fe4e7dbc8ddea312c8f3093af9b6bc71d9ae4007df76ae24b85889871933bc8
  source_path: network.md
  workflow: 15
---

# 网络中心

本中心汇集了 OpenClaw 如何在 localhost、局域网和 tailnet 之间连接、配对和保护设备的核心文档。

## 核心模型

- [Gateway 网关架构](/concepts/architecture)
- [Gateway 网关协议](/gateway/protocol)
- [Gateway 网关运维手册](/gateway)
- [Web 接口 + 绑定模式](/web)

## 配对 + 身份

- [配对概述（私信 + 节点）](/start/pairing)
- [Gateway 网关拥有的节点配对](/gateway/pairing)
- [Devices CLI（配对 + token 轮换）](/cli/devices)
- [Pairing CLI（私信审批）](/cli/pairing)

本地信任：

- 本地连接（loopback 或 Gateway 网关主机自身的 tailnet 地址）可以自动批准配对，以保持同主机用户体验的流畅性。
- 非本地的 tailnet/局域网客户端仍需要显式的配对批准。

## 设备发现 + 传输协议

- [设备发现与传输协议](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [远程访问（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 节点 + 传输协议

- [节点概述](/nodes)
- [桥接协议（旧版节点）](/gateway/bridge-protocol)
- [节点运维手册：iOS](/platforms/ios)
- [节点运维手册：Android](/platforms/android)

## 安全

- [安全概述](/gateway/security)
- [Gateway 网关配置参考](/gateway/configuration)
- [故障排除](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
