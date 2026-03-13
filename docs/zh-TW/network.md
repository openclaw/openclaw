---
summary: "Network hub: gateway surfaces, pairing, discovery, and security"
read_when:
  - You need the network architecture + security overview
  - You are debugging local vs tailnet access or pairing
  - You want the canonical list of networking docs
title: Network
---

# 網路中心

此中心連結了 OpenClaw 如何在本地主機、區域網路及 tailnet 中連接、配對及保護裝置的核心文件。

## 核心模型

- [閘道架構](/concepts/architecture)
- [閘道協定](/gateway/protocol)
- [閘道操作手冊](/gateway)
- [網頁介面與綁定模式](/web)

## 配對與身份認證

- [配對概覽（DM + 節點）](/channels/pairing)
- [閘道擁有的節點配對](/gateway/pairing)
- [裝置 CLI（配對與 token 旋轉）](/cli/devices)
- [配對 CLI（DM 批准）](/cli/pairing)

本地信任：

- 本地連線（迴路或閘道主機自身的 tailnet 位址）可自動批准配對，以保持同主機使用者體驗流暢。
- 非本地 tailnet/LAN 用戶端仍需明確的配對批准。

## 探測與傳輸

- [探測與傳輸](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [遠端存取（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 節點與傳輸

- [節點概覽](/nodes)
- [橋接協定（舊版節點）](/gateway/bridge-protocol)
- [節點操作手冊：iOS](/platforms/ios)
- [節點操作手冊：Android](/platforms/android)

## 安全性

- [安全性概覽](/gateway/security)
- [閘道設定參考](/gateway/configuration)
- [故障排除](/gateway/troubleshooting)
- [診斷工具](/gateway/doctor)
