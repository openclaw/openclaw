---
read_when:
  - 你需要了解网络架构和安全概览
  - 你正在调试本地访问与 tailnet 访问或配对问题
  - 你想获取网络文档的权威列表
summary: 网络中心：Gateway网关接口、配对、发现和安全
title: 网络
x-i18n:
  generated_at: "2026-02-01T21:17:17Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0fe4e7dbc8ddea312c8f3093af9b6bc71d9ae4007df76ae24b85889871933bc8
  source_path: network.md
  workflow: 15
---

# 网络中心

本中心汇集了 OpenClaw 如何在 localhost、局域网和 tailnet 之间连接、配对和保护设备的核心文档。

## 核心模型

- [Gateway网关架构](/concepts/architecture)
- [Gateway网关协议](/gateway/protocol)
- [Gateway网关运维手册](/gateway)
- [Web 接口 + 绑定模式](/web)

## 配对 + 身份

- [配对概览（私信 + 节点）](/start/pairing)
- [Gateway网关拥有的节点配对](/gateway/pairing)
- [设备 CLI（配对 + 令牌轮换）](/cli/devices)
- [配对 CLI（私信 审批）](/cli/pairing)

本地信任：

- 本地连接（local loopback 或 Gateway网关主机自身的 tailnet 地址）可以自动批准配对，以保持同主机用户体验的流畅性。
- 非本地的 tailnet/局域网客户端仍需要明确的配对审批。

## 发现 + 传输

- [发现与传输](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [远程访问（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 节点 + 传输

- [节点概览](/nodes)
- [Bridge 协议（旧版节点）](/gateway/bridge-protocol)
- [节点运维手册：iOS](/platforms/ios)
- [节点运维手册：Android](/platforms/android)

## 安全

- [安全概览](/gateway/security)
- [Gateway网关配置参考](/gateway/configuration)
- [故障排除](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
