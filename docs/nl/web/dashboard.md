---
summary: "Toegang en authenticatie voor het Gateway-dashboard (Control UI)"
read_when:
  - Het wijzigen van dashboardauthenticatie of blootstellingsmodi
title: "Dashboard"
---

# Dashboard (Control UI)

Het Gateway-dashboard is de Control UI in de browser die standaard wordt aangeboden op `/`
(te overschrijven met `gateway.controlUi.basePath`).

Snel openen (lokale Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (of [http://localhost:18789/](http://localhost:18789/))

Belangrijke verwijzingen:

- [Control UI](/web/control-ui) voor gebruik en UI-mogelijkheden.
- [Tailscale](/gateway/tailscale) voor Serve/Funnel-automatisering.
- [Web surfaces](/web) voor bind-modi en beveiligingsnotities.

Authenticatie wordt afgedwongen bij de WebSocket-handshake via `connect.params.auth`
(token of wachtwoord). Zie `gateway.auth` in de [Gateway-configuratie](/gateway/configuration).

Beveiligingsnotitie: de Control UI is een **admin-oppervlak** (chat, config, uitvoeringsgoedkeuringen).
Stel deze niet publiekelijk bloot. De UI slaat de token na de eerste keer laden op in `localStorage`.
Geef de voorkeur aan localhost, Tailscale Serve of een SSH-tunnel.

## Snelle route (aanbevolen)

- Na onboarding opent de CLI automatisch het dashboard en print een schone (niet-getokeniseerde) link.
- Op elk moment opnieuw openen: `openclaw dashboard` (kopieert de link, opent de browser indien mogelijk, toont een SSH-hint als headless).
- Als de UI om authenticatie vraagt, plak de token uit `gateway.auth.token` (of `OPENCLAW_GATEWAY_TOKEN`) in de Control UI-instellingen.

## Token-basis (lokaal vs. extern)

- **Localhost**: open `http://127.0.0.1:18789/`.
- **Tokenbron**: `gateway.auth.token` (of `OPENCLAW_GATEWAY_TOKEN`); de UI slaat na het verbinden een kopie op in localStorage.
- **Niet localhost**: gebruik Tailscale Serve (tokenloos als `gateway.auth.allowTailscale: true`), tailnet-binding met een token, of een SSH-tunnel. Zie [Web surfaces](/web).

## Als je “unauthorized” / 1008 ziet

- Zorg dat de Gateway bereikbaar is (lokaal: `openclaw status`; extern: SSH-tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` en open daarna `http://127.0.0.1:18789/`).
- Haal de token op van de Gateway-host: `openclaw config get gateway.auth.token` (of genereer er een: `openclaw doctor --generate-gateway-token`).
- Plak in de dashboardinstellingen de token in het auth-veld en maak vervolgens verbinding.
