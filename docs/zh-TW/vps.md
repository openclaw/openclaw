---
summary: "OpenClaw 的 VPS 託管中心 (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - 當您想在雲端運行 Gateway 時
  - 當您需要一份 VPS/託管指南快速對照時
title: "VPS 託管"
---

# VPS 託管

此中心連結到支援的 VPS/託管指南，並高層次地解釋了雲端部署的運作方式。

## 選擇供應商

- **Railway** (一鍵式 + 瀏覽器設定): [Railway](/install/railway)
- **Northflank** (一鍵式 + 瀏覽器設定): [Northflank](/install/northflank)
- **Oracle Cloud (永遠免費)**: [Oracle](/platforms/oracle) — $0/月 (永遠免費, ARM; 容量/註冊可能有些挑剔)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: 也運作良好。影片指南：
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## 雲端設定的運作方式

- **Gateway 運行在 VPS 上**，並擁有狀態 + 工作區。
- 您可以透過 **控制介面** 或 **Tailscale/SSH** 從您的筆記型電腦/手機連接。
- 將 VPS 視為事實的來源，並**備份**狀態 + 工作區。
- 安全預設：保持 Gateway 在 local loopback 上，並透過 SSH 通道或 Tailscale Serve 存取它。
  如果您綁定到 `lan`/`tailnet`，則需要 `gateway.auth.token` 或 `gateway.auth.password`。

遠端存取: [Gateway 遠端](/gateway/remote)
平台中心: [平台](/platforms)

## 將節點與 VPS 搭配使用

您可以將 Gateway 保留在雲端，並將**節點**配對到您的本機裝置 (Mac/iOS/Android/無頭設備)。節點提供本機螢幕/相機/畫布和 `system.run` 功能，而 Gateway 則保留在雲端。

文件: [節點](/nodes), [節點 CLI](/cli/nodes)
