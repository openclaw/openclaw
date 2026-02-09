---
summary: "Overzicht van platformondersteuning (Gateway + Companion-apps)"
read_when:
  - Op zoek naar OS-ondersteuning of installatiepaden
  - Beslissen waar de Gateway moet draaien
title: "Platformen"
---

# Platformen

De OpenClaw-core is geschreven in TypeScript. **Node is de aanbevolen runtime**.
Bun wordt niet aanbevolen voor de Gateway (WhatsApp/Telegram-bugs).

Er bestaan Companion-apps voor macOS (menubalk-app) en mobiele nodes (iOS/Android). Windows- en
Linux-Companion-apps zijn gepland, maar de Gateway wordt vandaag volledig ondersteund.
Native Companion-apps voor Windows zijn ook gepland; de Gateway wordt aanbevolen via WSL2.

## Kies je OS

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

## Veelgebruikte links

- Installatiegids: [Aan de slag](/start/getting-started)
- Gateway-runbook: [Gateway](/gateway)
- Gateway-configuratie: [Configuratie](/gateway/configuration)
- Servicestatus: `openclaw gateway status`

## Gateway-service installeren (CLI)

Gebruik een van deze (allemaal ondersteund):

- Wizard (aanbevolen): `openclaw onboard --install-daemon`
- Direct: `openclaw gateway install`
- Configuratieflow: `openclaw configure` → selecteer **Gateway service**
- Repareren/migreren: `openclaw doctor` (biedt aan de service te installeren of te repareren)

Het service-doel is afhankelijk van het OS:

- macOS: LaunchAgent (`bot.molt.gateway` of `bot.molt.<profile>`; legacy `com.openclaw.*`)
- Linux/WSL2: systemd-gebruikersservice (`openclaw-gateway[-<profile>].service`)
