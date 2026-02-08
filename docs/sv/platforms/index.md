---
summary: "Översikt över plattformsstöd (Gateway + Companion-appar)"
read_when:
  - Letar efter OS-stöd eller installationssökvägar
  - Bestämmer var du ska köra Gateway
title: "Plattformar"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:55Z
---

# Plattformar

OpenClaw-kärnan är skriven i TypeScript. **Node är den rekommenderade körtiden**.
Bun rekommenderas inte för Gateway (WhatsApp-/Telegram-buggar).

Companion-appar finns för macOS (menyradsapp) och mobila noder (iOS/Android). Companion-appar för Windows och
Linux är planerade, men Gateway stöds fullt ut redan i dag.
Inbyggda Companion-appar för Windows är också planerade; Gateway rekommenderas via WSL2.

## Välj ditt OS

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS och hosting

- VPS-hubb: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS-proxy): [exe.dev](/install/exe-dev)

## Vanliga länkar

- Installationsguide: [Kom igång](/start/getting-started)
- Gateway-runbook: [Gateway](/gateway)
- Gateway-konfiguration: [Konfiguration](/gateway/configuration)
- Tjänststatus: `openclaw gateway status`

## Installation av Gateway-tjänst (CLI)

Använd ett av dessa (alla stöds):

- Guide (rekommenderas): `openclaw onboard --install-daemon`
- Direkt: `openclaw gateway install`
- Konfigurera flöde: `openclaw configure` → välj **Gateway service**
- Reparera/migrera: `openclaw doctor` (erbjuder att installera eller fixa tjänsten)

Tjänstemålet beror på OS:

- macOS: LaunchAgent (`bot.molt.gateway` eller `bot.molt.<profile>`; äldre `com.openclaw.*`)
- Linux/WSL2: systemd-användartjänst (`openclaw-gateway[-<profile>].service`)
