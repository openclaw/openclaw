---
summary: "Gateway runtime sa macOS (panlabas na launchd service)"
read_when:
  - Pag-package ng OpenClaw.app
  - Pag-debug ng macOS gateway launchd service
  - Pag-install ng gateway CLI para sa macOS
title: "Gateway sa macOS"
---

# Gateway sa macOS (panlabas na launchd)

Hindi na bina-bundle ng OpenClaw.app ang Node/Bun o ang Gateway runtime. Inaasahan ng macOS app ang isang **external** na `openclaw` CLI install, hindi nito sini-spawn ang Gateway bilang child process, at pinamamahalaan nito ang isang per‑user launchd service upang panatilihing tumatakbo ang Gateway (o kumokonekta sa isang umiiral nang lokal na Gateway kung mayroon nang tumatakbo).

## I-install ang CLI (kinakailangan para sa local mode)

Kailangan mo ng Node 22+ sa Mac, pagkatapos ay i-install ang `openclaw` nang global:

```bash
npm install -g openclaw@<version>
```

Ang **Install CLI** na button ng macOS app ay nagpapatakbo ng parehong daloy gamit ang npm/pnpm (hindi inirerekomenda ang bun para sa Gateway runtime).

## Launchd (Gateway bilang LaunchAgent)

Label:

- `bot.molt.gateway` (o `bot.molt.<profile>``; legacy `com.openclaw.\*\` ay maaaring manatili)

Lokasyon ng plist (per‑user):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (o `~/Library/LaunchAgents/bot.molt.<profile>`.plist\`)

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

Sinusuri ng macOS app ang bersyon ng gateway laban sa sarili nitong bersyon. Kung hindi sila magkatugma, i-update ang global CLI upang tumugma sa bersyon ng app.

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
