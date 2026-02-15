---
summary: "網路中心：Gateway 介面、配對、裝置探索與安全性"
read_when:
  - 您需要網路架構 + 安全性總覽
  - 您正在偵錯本機與 tailnet 存取或配對
  - 您想查詢權威性的網路文件列表
title: "網路"
---

# 網路中心

此中心連結了 OpenClaw 如何在 localhost、LAN 和 tailnet 之間連接、配對和保護裝置安全的核心文件。

## 核心模型

- [Gateway 架構](/concepts/architecture)
- [Gateway 協定](/gateway/protocol)
- [Gateway 操作手冊](/gateway)
- [網頁介面 + 繫結模式](/web)

## 配對 + 識別

- [配對總覽（私訊 + 節點）](/channels/pairing)
- [Gateway 擁有的節點配對](/gateway/pairing)
- [裝置 CLI（配對 + 權杖輪替）](/cli/devices)
- [配對 CLI（私訊核准）](/cli/pairing)

本機信任：

- 本機連線 (local loopback 或 Gateway 主機自身的 tailnet 位址) 可以自動核准配對，以維持同主機的使用者體驗流暢。
- 非本機 tailnet/LAN 用戶端仍需明確的配對核准。

## 裝置探索 + 傳輸協定

- [裝置探索與傳輸協定](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [遠端存取 (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 節點 + 傳輸協定

- [節點總覽](/nodes)
- [橋接協定（舊版節點）](/gateway/bridge-protocol)
- [節點操作手冊：iOS](/platforms/ios)
- [節點操作手冊：Android](/platforms/android)

## 安全性

- [安全性總覽](/gateway/security)
- [Gateway 設定參考](/gateway/configuration)
- [疑難排解](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
