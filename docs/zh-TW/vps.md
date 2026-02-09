---
summary: "OpenClaw 的 VPS 託管中樞（Oracle/Fly/Hetzner/GCP/exe.dev）"
read_when:
  - 您想在雲端執行 Gateway 閘道器
  - 您需要一份 VPS／託管指南的快速地圖
title: "VPS 託管"
---

# VPS 託管

此中樞連結到支援的 VPS／託管指南，並以高層次說明雲端部署的運作方式。

## 選擇提供者

- **Railway**（一鍵＋瀏覽器設定）：[Railway](/install/railway)
- **Northflank**（一鍵＋瀏覽器設定）：[Northflank](/install/northflank)
- **Oracle Cloud（Always Free）**：[Oracle](/platforms/oracle) — 每月 $0（Always Free、ARM；容量／註冊可能較為挑剔）
- **Fly.io**：[Fly.io](/install/fly)
- **Hetzner（Docker）**：[Hetzner](/install/hetzner)
- **GCP（Compute Engine）**：[GCP](/install/gcp)
- **exe.dev**（VM＋HTTPS 代理）：[exe.dev](/install/exe-dev)
- **AWS（EC2／Lightsail／free tier）**：同樣運作良好。影片指南：
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547) 5. 影片指南：
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## 雲端設定如何運作

- **Gateway 閘道器在 VPS 上執行**，並持有狀態與工作區。
- 您可透過 **Control UI** 或 **Tailscale／SSH** 從筆電／手機連線。
- 將 VPS 視為單一事實來源，並**備份**狀態與工作區。
- 安全預設：將 Gateway 閘道器維持在 loopback，並透過 SSH 通道或 Tailscale Serve 存取。
  若您綁定至 `lan`/`tailnet`，請要求 `gateway.auth.token` 或 `gateway.auth.password`。
  6. 若綁定至 `lan`/`tailnet`，需要設定 `gateway.auth.token` 或 `gateway.auth.password`。

遠端存取：[Gateway remote](/gateway/remote)  
平台中樞：[Platforms](/platforms)

## 搭配 VPS 使用 nodes

您可以將 Gateway 閘道器保留在雲端，並在本機裝置
（Mac／iOS／Android／headless）配對 **nodes**。Nodes 提供本機的螢幕／相機／畫布，以及 `system.run`
能力，而 Gateway 閘道器則留在雲端。 Nodes provide local screen/camera/canvas and `system.run`
capabilities while the Gateway stays in the cloud.

文件：[Nodes](/nodes)，[Nodes CLI](/cli/nodes)
