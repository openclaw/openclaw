---
summary: "Überblick über die Plattformunterstützung (Gateway + Companion-Apps)"
read_when:
  - Auf der Suche nach OS-Unterstützung oder Installationspfaden
  - Entscheidung, wo das Gateway betrieben werden soll
title: "Plattformen"
---

# Plattformen

Der OpenClaw-Core ist in TypeScript geschrieben. **Node ist die empfohlene Laufzeit**.
Bun wird für das Gateway nicht empfohlen (WhatsApp-/Telegram-Bugs).

Companion-Apps existieren für macOS (Menüleisten-App) und mobile Nodes (iOS/Android). Companion-Apps für Windows und
Linux sind geplant, aber das Gateway wird heute bereits vollständig unterstützt.
Native Companion-Apps für Windows sind ebenfalls geplant; das Gateway wird über WSL2 empfohlen.

## Wählen Sie Ihr Betriebssystem

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS & Hosting

- VPS-Hub: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS-Proxy): [exe.dev](/install/exe-dev)

## Häufige Links

- Installationsanleitung: [Erste Schritte](/start/getting-started)
- Gateway-Runbook: [Gateway](/gateway)
- Gateway-Konfiguration: [Konfiguration](/gateway/configuration)
- Dienststatus: `openclaw gateway status`

## Installation des Gateway-Dienstes (CLI)

Verwenden Sie eine der folgenden Optionen (alle unterstützt):

- Assistent (empfohlen): `openclaw onboard --install-daemon`
- Direkt: `openclaw gateway install`
- Konfigurationsablauf: `openclaw configure` → **Gateway service** auswählen
- Reparieren/Migrieren: `openclaw doctor` (bietet an, den Dienst zu installieren oder zu reparieren)

Das Service-Ziel hängt vom Betriebssystem ab:

- macOS: LaunchAgent (`bot.molt.gateway` oder `bot.molt.<profile>`; legacy `com.openclaw.*`)
- Linux/WSL2: systemd-Benutzerdienst (`openclaw-gateway[-<profile>].service`)
