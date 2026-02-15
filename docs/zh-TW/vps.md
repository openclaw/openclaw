---
summary: "OpenClaw 的 VPS 託管中心 (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - 您想在雲端執行 Gateway
  - 您需要 VPS/託管指南的快速索引
title: "VPS 託管"
---

# VPS 託管

本中心提供支援的 VPS/託管指南連結，並說明雲端部署的高階運作方式。

## 選擇供應商

- **Railway** (一鍵安裝 + 瀏覽器設定): [Railway](/install/railway)
- **Northflank** (一鍵安裝 + 瀏覽器設定): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — 每月 $0 (Always Free, ARM；容量/註冊過程可能較不穩定)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS 代理): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/免費方案)**: 同樣運作良好。影片指南：
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## 雲端設定運作方式

- **Gateway 執行於 VPS**，並管理狀態與工作空間。
- 您可以透過 **Control UI** 或 **Tailscale/SSH** 從筆記型電腦/手機連線。
- 請將 VPS 視為單一事實來源 (source of truth)，並**備份**其狀態與工作空間。
- 安全預設值：將 Gateway 保持在 local loopback，並透過 SSH 通道或 Tailscale Serve 存取。
  如果您綁定到 `lan`/`tailnet`，則需要 `gateway.auth.token` 或 `gateway.auth.password`。

遠端存取：[Gateway 遠端](/gateway/remote)  
平台中心：[Platforms](/platforms)

## 在 VPS 上使用 Node

您可以將 Gateway 保留在雲端，並配對您本地裝置（Mac/iOS/Android/headless）上的 **nodes**。Nodes 提供本地螢幕/攝影機/畫布與 `system.run` 功能，而 Gateway 則維持在雲端執行。

文件：[Nodes](/nodes), [Nodes CLI](/cli/nodes)
