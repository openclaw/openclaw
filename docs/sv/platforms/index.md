---
summary: "Översikt över plattformsstöd (Gateway + Companion-appar)"
read_when:
  - Letar efter OS-stöd eller installationssökvägar
  - Bestämmer var du ska köra Gateway
title: "Plattformar"
---

# Plattformar

OpenClaw kärna är skriven i TypeScript. **Noden är den rekommenderade runtime**.
Bun rekommenderas inte för Gateway (WhatsApp/Telegram buggar).

Kompanjonappar finns för macOS (menyradens app) och mobila noder (iOS/Android). Windows och
Linux-följeslagare är planerade, men Gateway stöds fullt ut idag.
Inhemska följeslagare appar för Windows är också planerade; Gateway rekommenderas via WSL2.

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
