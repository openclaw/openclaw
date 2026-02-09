---
summary: "Pangkalahatang-ideya ng suporta sa platform (Gateway + companion apps)"
read_when:
  - Naghahanap ng suporta sa OS o mga path ng pag-install
  - Nagpapasya kung saan patakbuhin ang Gateway
title: "Mga Platform"
---

# Mga Platform

Ang OpenClaw core ay nakasulat sa TypeScript. **Inirerekomendang runtime ang Node**.
Hindi inirerekomenda ang Bun para sa Gateway (mga bug sa WhatsApp/Telegram).

May mga companion app para sa macOS (menu bar app) at mga mobile node (iOS/Android). May planong Windows at
Linux companion apps, ngunit ang Gateway ay ganap na suportado na ngayon.
May plano rin para sa mga native companion app sa Windows; inirerekomenda ang Gateway sa pamamagitan ng WSL2.

## Piliin ang iyong OS

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS at hosting

- VPS hub: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/install/exe-dev)

## Mga karaniwang link

- Gabay sa pag-install: [Pagsisimula](/start/getting-started)
- Gateway runbook: [Gateway](/gateway)
- Konpigurasyon ng Gateway: [Konpigurasyon](/gateway/configuration)
- Status ng serbisyo: `openclaw gateway status`

## Pag-install ng serbisyo ng Gateway (CLI)

Gumamit ng isa sa mga ito (lahat ay suportado):

- Wizard (inirerekomenda): `openclaw onboard --install-daemon`
- Direktang paraan: `openclaw gateway install`
- Configure flow: `openclaw configure` → piliin ang **Gateway service**
- Repair/migrate: `openclaw doctor` (nag-aalok na mag-install o mag-ayos ng serbisyo)

Nakadepende sa OS ang service target:

- macOS: LaunchAgent (`bot.molt.gateway` o `bot.molt.<profile>``; legacy `com.openclaw.\*\`)
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)
