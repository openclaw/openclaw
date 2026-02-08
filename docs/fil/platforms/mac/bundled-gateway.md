---
summary: "Gateway runtime sa macOS (panlabas na launchd service)"
read_when:
  - Pag-package ng OpenClaw.app
  - Pag-debug ng macOS gateway launchd service
  - Pag-install ng gateway CLI para sa macOS
title: "Gateway sa macOS"
x-i18n:
  source_path: platforms/mac/bundled-gateway.md
  source_hash: 4a3e963d13060b12
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:37Z
---

# Gateway sa macOS (panlabas na launchd)

Hindi na bina-bundle ng OpenClaw.app ang Node/Bun o ang Gateway runtime. Inaasahan ng macOS app ang **panlabas** na `openclaw` na pag-install ng CLI, hindi nito ini-spawn ang Gateway bilang child process, at namamahala ito ng per‑user na launchd service para panatilihing tumatakbo ang Gateway (o kumokonekta sa umiiral na lokal na Gateway kung mayroon nang tumatakbo).

## I-install ang CLI (kinakailangan para sa local mode)

Kailangan mo ng Node 22+ sa Mac, pagkatapos ay i-install ang `openclaw` nang global:

```bash
npm install -g openclaw@<version>
```

Ang **Install CLI** na button ng macOS app ay nagpapatakbo ng parehong daloy gamit ang npm/pnpm (hindi inirerekomenda ang bun para sa Gateway runtime).

## Launchd (Gateway bilang LaunchAgent)

Label:

- `bot.molt.gateway` (o `bot.molt.<profile>`; maaaring manatili ang legacy na `com.openclaw.*`)

Lokasyon ng plist (per‑user):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (o `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Manager:

- Ang macOS app ang may-ari ng pag-install/pag-update ng LaunchAgent sa Local mode.
- Maaari rin itong i-install ng CLI: `openclaw gateway install`.

Gawi:

- Ang “OpenClaw Active” ay nag-e-enable/nagdi-disable ng LaunchAgent.
- Ang pag-quit ng app ay **hindi** humihinto sa gateway (pinananatili itong buhay ng launchd).
- Kung may Gateway nang tumatakbo sa naka-configure na port, kumokonekta ang app dito sa halip na magsimula ng bago.

Pag-log:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Pagiging tugma ng bersyon

Tinitingnan ng macOS app ang bersyon ng gateway laban sa sarili nitong bersyon. Kung hindi tugma, i-update ang global CLI upang tumugma sa bersyon ng app.

## Smoke check

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Pagkatapos:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
