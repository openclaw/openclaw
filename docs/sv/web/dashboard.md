---
summary: "Åtkomst och autentisering för Gateway-dashboarden (Control UI)"
read_when:
  - Ändrar autentisering eller exponeringslägen för dashboarden
title: "Dashboard"
x-i18n:
  source_path: web/dashboard.md
  source_hash: e4fc372b72f030f9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:52Z
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

Autentisering tillämpas vid WebSocket-handshaken via `connect.params.auth`
(token eller lösenord). Se `gateway.auth` i [Gateway-konfiguration](/gateway/configuration).

Säkerhetsnotering: Control UI är en **adminyta** (chatt, konfig, exec-godkännanden).
Exponera den inte offentligt. UI:t lagrar token i `localStorage` efter första inläsningen.
Föredra localhost, Tailscale Serve eller en SSH-tunnel.

## Snabbaste vägen (rekommenderas)

- Efter introduktionen öppnar CLI automatiskt dashboarden och skriver ut en ren (icke-tokeniserad) länk.
- Öppna igen när som helst: `openclaw dashboard` (kopierar länk, öppnar webbläsaren om möjligt, visar SSH-tips om headless).
- Om UI:t ber om autentisering, klistra in token från `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) i Control UI-inställningarna.

## Token-grunder (lokalt vs fjärr)

- **Localhost**: öppna `http://127.0.0.1:18789/`.
- **Tokenkälla**: `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`); UI:t lagrar en kopia i localStorage efter att du anslutit.
- **Inte localhost**: använd Tailscale Serve (tokenlöst om `gateway.auth.allowTailscale: true`), tailnet-bindning med token eller en SSH-tunnel. Se [Web surfaces](/web).

## Om du ser ”unauthorized” / 1008

- Säkerställ att gatewayen är nåbar (lokalt: `openclaw status`; fjärr: SSH-tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` och öppna sedan `http://127.0.0.1:18789/`).
- Hämta token från gateway-värden: `openclaw config get gateway.auth.token` (eller generera en: `openclaw doctor --generate-gateway-token`).
- I dashboardens inställningar klistrar du in token i autentiseringsfältet och ansluter.
