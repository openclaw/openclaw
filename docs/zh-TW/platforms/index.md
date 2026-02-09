---
summary: "平台支援總覽（Gateway 閘道器 + 配套應用程式）"
read_when:
  - 尋找作業系統支援或安裝路徑
  - 決定在哪裡執行 Gateway 閘道器
title: "平台"
---

# 平台

OpenClaw core is written in TypeScript. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

Companion apps exist for macOS (menu bar app) and mobile nodes (iOS/Android). Windows and
Linux companion apps are planned, but the Gateway is fully supported today.
Native companion apps for Windows are also planned; the Gateway is recommended via WSL2.

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
