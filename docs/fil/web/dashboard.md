---
summary: "Access at auth ng Gateway dashboard (Control UI)"
read_when:
  - Pagbabago ng authentication o exposure modes ng dashboard
title: "Dashboard"
---

# Dashboard (Control UI)

Ang Gateway dashboard ay ang browser Control UI na sine-serve sa `/` bilang default
(maaaring i-override gamit ang `gateway.controlUi.basePath`).

Mabilis na pagbukas (lokal na Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (o [http://localhost:18789/](http://localhost:18789/))

Mga pangunahing sanggunian:

- [Control UI](/web/control-ui) para sa paggamit at mga kakayahan ng UI.
- [Tailscale](/gateway/tailscale) para sa Serve/Funnel automation.
- [Web surfaces](/web) para sa mga bind mode at mga tala sa seguridad.

Ipinapatupad ang authentication sa WebSocket handshake sa pamamagitan ng `connect.params.auth`
(token o password). Tingnan ang `gateway.auth` sa [Gateway configuration](/gateway/configuration).

Paalaala sa seguridad: ang Control UI ay isang **admin surface** (chat, config, exec approvals).
Huwag itong ilantad sa publiko. Ini-store ng UI ang token sa `localStorage` pagkatapos ng unang load.
Mas mainam ang localhost, Tailscale Serve, o isang SSH tunnel.

## Mabilis na ruta (inirerekomenda)

- Pagkatapos ng onboarding, awtomatikong binubuksan ng CLI ang dashboard at nagpi-print ng malinis (walang token) na link.
- Buksan muli anumang oras: `openclaw dashboard` (kinokopya ang link, binubuksan ang browser kung maaari, at nagpapakita ng SSH hint kung headless).
- Kung humihingi ng auth ang UI, i-paste ang token mula sa `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`) sa mga setting ng Control UI.

## Mga batayan ng token (lokal vs remote)

- **Localhost**: buksan ang `http://127.0.0.1:18789/`.
- **Pinagmulan ng token**: `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`); nag-iimbak ang UI ng kopya sa localStorage pagkatapos mong kumonek.
- **Hindi localhost**: gumamit ng Tailscale Serve (walang token kung `gateway.auth.allowTailscale: true`), tailnet bind na may token, o SSH tunnel. Tingnan ang [Web surfaces](/web).

## Kung makita mo ang “unauthorized” / 1008

- Tiyaking naaabot ang gateway (lokal: `openclaw status`; remote: SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` pagkatapos ay buksan ang `http://127.0.0.1:18789/`).
- Kunin ang token mula sa host ng Gateway: `openclaw config get gateway.auth.token` (o gumawa ng bago: `openclaw doctor --generate-gateway-token`).
- Sa mga setting ng dashboard, i-paste ang token sa auth field, pagkatapos ay kumonek.
