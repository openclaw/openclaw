---
summary: "平台支援總覽（Gateway + 配套應用程式）"
read_when:
  - 尋找作業系統支援或安裝路徑時
  - 決定 Gateway 運行位置時
title: "平台"
---

# 平台

OpenClaw 核心以 TypeScript 編寫。**Node 是建議的執行環境**。
Gateway 不建議使用 Bun（因 WhatsApp/Telegram 錯誤）。

macOS (選單列應用程式) 和行動節點 (iOS/Android) 都有配套應用程式。Windows 和
Linux 配套應用程式正在規劃中，但 Gateway 目前已完全支援。
Windows 的原生配套應用程式也正在規劃中；建議透過 WSL2 使用 Gateway。

## 選擇您的作業系統

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS 與代管服務

- VPS 中心: [VPS 代管](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (虛擬機 + HTTPS 代理): [exe.dev](/install/exe-dev)

## 常用連結

- 安裝指南: [開始使用](/start/getting-started)
- Gateway 操作手冊: [Gateway](/gateway)
- Gateway 設定: [設定](/gateway/configuration)
- 服務狀態: `openclaw gateway status`

## Gateway 服務安裝 (CLI)

請使用以下其中一種方式（皆支援）：

- 精靈 (建議): `openclaw onboard --install-daemon`
- 直接安裝: `openclaw gateway install`
- 設定流程: `openclaw configure` → 選擇 **Gateway 服務**
- 修復/遷移: `openclaw doctor` (提供安裝或修復服務)

服務目標取決於作業系統：

- macOS: LaunchAgent (`bot.molt.gateway` 或 `bot.molt.<profile>`；舊版 `com.openclaw.*`)
- Linux/WSL2: systemd 使用者服務 (`openclaw-gateway[-<profile>].service`)
