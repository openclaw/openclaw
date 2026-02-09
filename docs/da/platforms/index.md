---
summary: "Overblik over platformsupport (Gateway + Companion-apps)"
read_when:
  - Leder efter OS-support eller installationsveje
  - Overvejer hvor Gateway skal køre
title: "Platforme"
---

# Platforme

OpenClaw kerne er skrevet i TypeScript. **Node er den anbefalede runtime**.
Bun anbefales ikke til Gateway (WhatsApp/Telegram bugs).

Der findes ledsagende apps til macOS (menulinje-app) og mobilknuder (iOS/Android). Windows og
Linux følgesvend apps er planlagt, men Gateway understøttes fuldt ud i dag.
Indfødte følgesvend apps til Windows er også planlagt; Gateway anbefales via WSL2.

## Vælg dit OS

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS & hosting

- VPS-hub: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS-proxy): [exe.dev](/install/exe-dev)

## Fælles links

- Installationsguide: [Kom godt i gang](/start/getting-started)
- Gateway-runbook: [Gateway](/gateway)
- Gateway-konfiguration: [Konfiguration](/gateway/configuration)
- Tjenestestatus: `openclaw gateway status`

## Installation af Gateway-tjeneste (CLI)

Brug en af disse (alle understøttes):

- Opsætningsguide (anbefalet): `openclaw onboard --install-daemon`
- Direkte: `openclaw gateway install`
- Konfigurer flow: `openclaw configure` → vælg **Gateway-tjeneste**
- Reparer/migrér: `openclaw doctor` (tilbyder at installere eller rette tjenesten)

Tjenestemålet afhænger af OS:

- macOS: LaunchAgent (`bot.molt.gateway` eller `bot.molt.<profile>`; arv `com.openclaw.*`)
- Linux/WSL2: systemd-brugertjeneste (`openclaw-gateway[-<profile>].service`)
