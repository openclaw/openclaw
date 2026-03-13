---
summary: Platform support overview (Gateway + companion apps)
read_when:
  - Looking for OS support or install paths
  - Deciding where to run the Gateway
title: Platforms
---

# 平台

OpenClaw 核心是用 TypeScript 撰寫的。**推薦使用 Node 作為執行環境**。  
Bun 不建議用於 Gateway（WhatsApp/Telegram 會有錯誤）。

有 macOS（選單列應用程式）和行動節點（iOS/Android）的 Companion 應用程式。  
Windows 和 Linux 的 Companion 應用程式正在規劃中，但 Gateway 目前已完全支援。  
Windows 原生 Companion 應用程式也在規劃中；建議透過 WSL2 使用 Gateway。

## 選擇您的作業系統

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS 與主機托管

- VPS 集線器: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (虛擬機 + HTTPS 代理): [exe.dev](/install/exe-dev)

## 常用連結

- 安裝指南: [快速開始](/start/getting-started)
- Gateway 執行手冊: [Gateway](/gateway)
- Gateway 設定: [Configuration](/gateway/configuration)
- 服務狀態: `openclaw gateway status`

## Gateway 服務安裝（CLI）

可使用以下任一方式（皆支援）：

- 精靈（推薦）: `openclaw onboard --install-daemon`
- 直接安裝: `openclaw gateway install`
- 設定流程: `openclaw configure` → 選擇 **Gateway service**
- 修復/遷移: `openclaw doctor`（提供安裝或修復服務）

服務目標依作業系統而定：

- macOS: LaunchAgent (`ai.openclaw.gateway` 或 `ai.openclaw.<profile>`；舊版 `com.openclaw.*`)
- Linux/WSL2: systemd 使用者服務 (`openclaw-gateway[-<profile>].service`)
