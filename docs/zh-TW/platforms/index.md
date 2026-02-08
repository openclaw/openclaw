---
summary: "平台支援總覽（Gateway 閘道器 + 配套應用程式）"
read_when:
  - 尋找作業系統支援或安裝路徑
  - 決定在哪裡執行 Gateway 閘道器
title: "平台"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:37Z
---

# 平台

OpenClaw 核心以 TypeScript 撰寫。**Node 是建議的執行階段**。
Gateway 閘道器不建議使用 Bun（WhatsApp／Telegram 的問題）。

配套應用程式提供 macOS（選單列應用程式）與行動節點（iOS／Android）。Windows 與
Linux 的配套應用程式已在規劃中，但 Gateway 閘道器目前已完整支援。
Windows 的原生配套應用程式亦在規劃中；建議透過 WSL2 執行 Gateway 閘道器。

## 選擇你的作業系統

- macOS： [macOS](/platforms/macos)
- iOS： [iOS](/platforms/ios)
- Android： [Android](/platforms/android)
- Windows： [Windows](/platforms/windows)
- Linux： [Linux](/platforms/linux)

## VPS 與託管

- VPS 中樞： [VPS hosting](/vps)
- Fly.io： [Fly.io](/install/fly)
- Hetzner（Docker）： [Hetzner](/install/hetzner)
- GCP（Compute Engine）： [GCP](/install/gcp)
- exe.dev（VM + HTTPS proxy）： [exe.dev](/install/exe-dev)

## 常用連結

- 安裝指南： [入門指南](/start/getting-started)
- Gateway 閘道器執行手冊： [Gateway](/gateway)
- Gateway 閘道器設定： [設定](/gateway/configuration)
- 服務狀態： `openclaw gateway status`

## Gateway 閘道器服務安裝（CLI）

使用以下其中一種（皆受支援）：

- 精靈（建議）： `openclaw onboard --install-daemon`
- 直接安裝： `openclaw gateway install`
- 設定流程： `openclaw configure` → 選擇 **Gateway service**
- 修復／遷移： `openclaw doctor`（提供安裝或修復服務）

服務目標依作業系統而定：

- macOS： LaunchAgent（`bot.molt.gateway` 或 `bot.molt.<profile>`；舊版 `com.openclaw.*`）
- Linux／WSL2： systemd 使用者服務（`openclaw-gateway[-<profile>].service`）
