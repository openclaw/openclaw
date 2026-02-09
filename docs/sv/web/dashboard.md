---
summary: "Åtkomst och autentisering för Gateway-dashboarden (Control UI)"
read_when:
  - Ändrar autentisering eller exponeringslägen för dashboarden
title: "Dashboard"
---

# Dashboard (Control UI)

Gateway-dashboarden är den webbaserade Control UI som som standard serveras på `/`
(åsidosätt med `gateway.controlUi.basePath`).

Snabb öppning (lokal Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (eller [http://localhost:18789/](http://localhost:18789/))

Viktiga referenser:

- [Control UI](/web/control-ui) för användning och UI-funktioner.
- [Tailscale](/gateway/tailscale) för Serve/Funnel-automation.
- [Web surfaces](/web) för bindningslägen och säkerhetsnoteringar.

Autentisering är påtvingad på WebSocket handskakning via `connect.params.auth`
(token eller lösenord). Se `gateway.auth` i [Gateway configuration](/gateway/configuration).

Säkerhetsanteckning: Control UI är en **administratörsyta** (chatt, konfigurera, exec godkännanden).
Utsätt den inte offentligt. UI lagrar token i `localStorage` efter första laddningen.
Föredrar localhost, Tailscale Serve, eller en SSH-tunnel.

## Snabbaste vägen (rekommenderas)

- Efter introduktionen öppnar CLI automatiskt dashboarden och skriver ut en ren (icke-tokeniserad) länk.
- Öppna igen när som helst: `openclaw dashboard` (kopierar länk, öppnar webbläsaren om möjligt, visar SSH-tips om headless).
- Om UI:t ber om autentisering, klistra in token från `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) i Control UI-inställningarna.

## Token-grunder (lokalt vs fjärr)

- **Localhost**: öppna `http://127.0.0.1:18789/`.
- **Tokenkälla**: `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`); UI:t lagrar en kopia i localStorage efter att du anslutit.
- **Inte localhost**: använd Tailscale Serve (tokenless if `gateway.auth.allowTailscale: true`), tailnet binda med en token, eller en SSH-tunnel. Se [Webbytor](/web).

## Om du ser ”unauthorized” / 1008

- Säkerställ att gatewayen är nåbar (lokalt: `openclaw status`; fjärr: SSH-tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` och öppna sedan `http://127.0.0.1:18789/`).
- Hämta token från gateway-värden: `openclaw config get gateway.auth.token` (eller generera en: `openclaw doctor --generate-gateway-token`).
- I dashboardens inställningar klistrar du in token i autentiseringsfältet och ansluter.
