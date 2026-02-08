---
summary: "網路中樞：Gateway 閘道器介面、配對、探索與安全性"
read_when:
  - 你需要網路架構與安全性的整體概覽
  - 你正在除錯本機與 tailnet 存取或配對問題
  - 你想要官方的網路相關文件清單
title: "網路"
x-i18n:
  source_path: network.md
  source_hash: 6a0d5080db73de4c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:24Z
---

# Network hub

此中樞連結了核心文件，說明 OpenClaw 如何在 localhost、LAN 與 tailnet 之間連線、配對並保護裝置。

## Core model

- [Gateway architecture](/concepts/architecture)
- [Gateway protocol](/gateway/protocol)
- [Gateway runbook](/gateway)
- [Web surfaces + bind modes](/web)

## Pairing + identity

- [Pairing overview (DM + nodes)](/channels/pairing)
- [Gateway-owned node pairing](/gateway/pairing)
- [Devices CLI (pairing + token rotation)](/cli/devices)
- [Pairing CLI (DM approvals)](/cli/pairing)

Local trust：

- 本機連線（loopback 或 Gateway 閘道器主機自身的 tailnet 位址）可以自動核准配對，以保持同一主機上的使用體驗順暢。
- 非本機的 tailnet／LAN 用戶端仍需要明確的配對核准。

## Discovery + transports

- [Discovery & transports](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Remote access (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodes + transports

- [Nodes overview](/nodes)
- [Bridge protocol (legacy nodes)](/gateway/bridge-protocol)
- [Node runbook: iOS](/platforms/ios)
- [Node runbook: Android](/platforms/android)

## Security

- [Security overview](/gateway/security)
- [Gateway config reference](/gateway/configuration)
- [Troubleshooting](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
