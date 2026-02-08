---
summary: "Pangkalahatang-ideya ng suporta sa platform (Gateway + companion apps)"
read_when:
  - Naghahanap ng suporta sa OS o mga path ng pag-install
  - Nagpapasya kung saan patakbuhin ang Gateway
title: "Mga Platform"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:37Z
---

# Mga Platform

Ang OpenClaw core ay isinulat sa TypeScript. **Node ang inirerekomendang runtime**.
Hindi inirerekomenda ang Bun para sa Gateway (may mga bug sa WhatsApp/Telegram).

May mga companion app para sa macOS (menu bar app) at mga mobile node (iOS/Android). Ang mga companion app para sa Windows at
Linux ay planado, ngunit ganap na suportado na ang Gateway ngayon.
Planado rin ang mga native companion app para sa Windows; inirerekomenda ang Gateway via WSL2.

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

- macOS: LaunchAgent (`bot.molt.gateway` o `bot.molt.<profile>`; legacy `com.openclaw.*`)
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)
