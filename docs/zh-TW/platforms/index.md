---
summary: "平台支援概覽 (Gateway + 配套應用)"
read_when:
  - 尋找作業系統支援或安裝路徑
  - 決定在何處執行 Gateway
title: "平台"
---

# 平台

OpenClaw 核心是以 TypeScript 編寫的。**Node 是推薦的執行階段 (runtime)**。
不建議將 Bun 用於 Gateway (WhatsApp/Telegram 錯誤)。

針對 macOS (選單列應用程式) 和行動節點 (iOS/Android) 提供了配套應用。Windows 和
Linux 的配套應用正在規劃中，但目前已完整支援 Gateway。
Windows 原生配套應用也在規劃中；目前建議透過 WSL2 使用 Gateway。

## 選擇您的作業系統

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS 與託管

- VPS 中心：[VPS 託管](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS 代理)：[exe.dev](/install/exe-dev)

## 常用連結

- 安裝指南：[入門指南](/start/getting-started)
- Gateway 運行指南：[Gateway](/gateway)
- Gateway 設定：[設定](/gateway/configuration)
- 服務狀態：`openclaw gateway status`

## Gateway 服務安裝 (CLI)

請使用以下其中一種方式 (皆支援)：

- 精靈 (推薦)：`openclaw onboard --install-daemon`
- 直接安裝：`openclaw gateway install`
- 設定流程：`openclaw configure` → 選擇 **Gateway 服務**
- 修復/遷移：`openclaw doctor` (會提供安裝或修復服務的選項)

服務目標取決於作業系統：

- macOS: LaunchAgent (`bot.molt.gateway` 或 `bot.molt.<profile>`；舊版為 `com.openclaw.*`)
- Linux/WSL2: systemd 使用者服務 (`openclaw-gateway[-<profile>].service`)
