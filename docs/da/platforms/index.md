---
summary: "Overblik over platformsupport (Gateway + Companion-apps)"
read_when:
  - Leder efter OS-support eller installationsveje
  - Overvejer hvor Gateway skal køre
title: "Platforme"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:24Z
---

# Platforme

OpenClaw-kernen er skrevet i TypeScript. **Node er den anbefalede runtime**.
Bun anbefales ikke til Gateway (WhatsApp/Telegram-fejl).

Companion-apps findes til macOS (menulinje-app) og mobile noder (iOS/Android). Windows- og
Linux-Companion-apps er planlagt, men Gateway er fuldt understøttet i dag.
Native Companion-apps til Windows er også planlagt; Gateway anbefales via WSL2.

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

- macOS: LaunchAgent (`bot.molt.gateway` eller `bot.molt.<profile>`; legacy `com.openclaw.*`)
- Linux/WSL2: systemd-brugertjeneste (`openclaw-gateway[-<profile>].service`)
