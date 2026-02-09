---
summary: "Adgang og autentificering til Gateway-dashboardet (Control UI)"
read_when:
  - Ændring af autentificering eller eksponeringsmetoder for dashboardet
title: "Dashboard"
---

# Dashboard (Control UI)

Gateway-dashboardet er den browserbaserede Control UI, der som standard serveres på `/`
(kan tilsidesættes med `gateway.controlUi.basePath`).

Hurtig åbning (lokal Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (eller [http://localhost:18789/](http://localhost:18789/))

Vigtige referencer:

- [Control UI](/web/control-ui) for brug og UI-funktioner.
- [Tailscale](/gateway/tailscale) for Serve/Funnel-automatisering.
- [Web surfaces](/web) for bind-modes og sikkerhedsnoter.

Godkendelse håndhæves på WebSocket handshake via `connect.params.auth`
(token eller adgangskode). Se `gateway.auth` i [Gateway konfiguration](/gateway/configuration).

Sikkerheds note: Control UI er en **admin overflade** (chat, config, exec godkendelser).
Må ikke udsætte det offentligt. Brugerfladen gemmer token i `localStorage` efter første indlæsning.
Foretrækker localhost, Tailscale Serve, eller en SSH-tunnel.

## Hurtig vej (anbefalet)

- Efter introduktion åbner CLI automatisk dashboardet og udskriver et rent (ikke-tokeniseret) link.
- Åbn igen når som helst: `openclaw dashboard` (kopierer linket, åbner browseren hvis muligt, viser SSH-tip hvis headless).
- Hvis UI’et beder om autentificering, indsæt tokenet fra `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) i Control UI-indstillingerne.

## Token-grundlæggende (lokal vs. fjern)

- **Localhost**: åbn `http://127.0.0.1:18789/`.
- **Token-kilde**: `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`); UI’et gemmer en kopi i localStorage, efter du forbinder.
- **Ikke localhost**: brug Tailscale Serve (tokenless if `gateway.auth.allowTailscale: true`), tailnet bind med en token, eller en SSH tunnel. Se [Weboverflader](/web).

## Hvis du ser “unauthorized” / 1008

- Sørg for, at gatewayen er tilgængelig (lokalt: `openclaw status`; fjernt: SSH-tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` og åbn derefter `http://127.0.0.1:18789/`).
- Hent tokenet fra gateway-værten: `openclaw config get gateway.auth.token` (eller generér et: `openclaw doctor --generate-gateway-token`).
- I dashboard-indstillingerne indsætter du tokenet i auth-feltet og forbinder derefter.
