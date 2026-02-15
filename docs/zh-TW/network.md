---
summary: "網路中心：Gateway 介面、配對、發現與安全性"
read_when:
  - 當你需要網路架構與安全性概覽時
  - 當你正在除錯本地與 tailnet 存取或配對時
  - 當你需要網路檔案的標準清單時
title: "網路"
---

# 網路中心

本中心連結了關於 OpenClaw 如何在 localhost、區域網路 (LAN) 與 tailnet 之間連接、配對與保護裝置的核心檔案。

## 核心模型

- [Gateway 架構](/concepts/architecture)
- [Gateway 協定](/gateway/protocol)
- [Gateway 運行手冊](/gateway)
- [Web 介面與綁定模式](/web)

## 配對與身份

- [配對概覽 (直接訊息 + 節點)](/channels/pairing)
- [Gateway 擁有的節點配對](/gateway/pairing)
- [裝置 CLI (配對與權杖輪轉)](/cli/devices)
- [配對 CLI (直接訊息核准)](/cli/pairing)

本地信任：

- 本地連接 (loopback 或 Gateway 主機自身的 tailnet 位址) 可以自動核准配對，以保持同主機的使用者體驗順暢。
- 非本地的 tailnet/區域網路客戶端仍需要明確的配對核准。

## 發現與傳輸

- [發現與傳輸](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [遠端存取 (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 節點與傳輸

- [節點概覽](/nodes)
- [Bridge 協定 (舊版節點)](/gateway/bridge-protocol)
- [節點運行手冊：iOS](/platforms/ios)
- [節點運行手冊：Android](/platforms/android)

## 安全性

- [安全性概覽](/gateway/security)
- [Gateway 設定參考](/gateway/configuration)
- [疑難排解](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
