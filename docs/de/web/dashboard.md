---
summary: "Zugriff und Authentifizierung für das Gateway-Dashboard (Control UI)"
read_when:
  - Ändern der Authentifizierung oder der Expositionsmodi des Dashboards
title: "Dashboard"
---

# Dashboard (Control UI)

Das Gateway-Dashboard ist die browserbasierte Control UI, die standardmäßig unter `/` bereitgestellt wird
(Überschreiben mit `gateway.controlUi.basePath`).

Schnell öffnen (lokales Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (oder [http://localhost:18789/](http://localhost:18789/))

Zentrale Referenzen:

- [Control UI](/web/control-ui) zur Nutzung und zu UI-Funktionen.
- [Tailscale](/gateway/tailscale) für Serve-/Funnel-Automatisierung.
- [Web-Oberflächen](/web) für Bind-Modi und Sicherheitshinweise.

Die Authentifizierung wird beim WebSocket-Handshake über `connect.params.auth`
(Token oder Passwort) erzwungen. Siehe `gateway.auth` in der [Gateway-Konfiguration](/gateway/configuration).

Sicherheitshinweis: Die Control UI ist eine **Admin-Oberfläche** (Chat, Konfiguration, Exec-Freigaben).
Setzen Sie sie nicht öffentlich aus. Die UI speichert den Token nach dem ersten Laden in `localStorage`.
Bevorzugen Sie localhost, Tailscale Serve oder einen SSH-Tunnel.

## Schnellstart (empfohlen)

- Nach dem Onboarding öffnet die CLI das Dashboard automatisch und gibt einen sauberen (nicht tokenisierten) Link aus.
- Jederzeit erneut öffnen: `openclaw dashboard` (kopiert den Link, öffnet den Browser, wenn möglich, und zeigt bei Headless-Betrieb einen SSH-Hinweis).
- Wenn die UI zur Authentifizierung auffordert, fügen Sie den Token aus `gateway.auth.token` (oder `OPENCLAW_GATEWAY_TOKEN`) in die Control-UI-Einstellungen ein.

## Token-Grundlagen (lokal vs. remote)

- **Localhost**: Öffnen Sie `http://127.0.0.1:18789/`.
- **Token-Quelle**: `gateway.auth.token` (oder `OPENCLAW_GATEWAY_TOKEN`); die UI speichert nach der Verbindung eine Kopie in localStorage.
- **Nicht localhost**: Verwenden Sie Tailscale Serve (tokenlos, falls `gateway.auth.allowTailscale: true`), eine Tailnet-Bindung mit Token oder einen SSH-Tunnel. Siehe [Web-Oberflächen](/web).

## Wenn Sie „nicht autorisiert“ / 1008 sehen

- Stellen Sie sicher, dass das Gateway erreichbar ist (lokal: `openclaw status`; remote: SSH-Tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` und anschließend `http://127.0.0.1:18789/` öffnen).
- Rufen Sie den Token vom Gateway-Host ab: `openclaw config get gateway.auth.token` (oder generieren Sie einen: `openclaw doctor --generate-gateway-token`).
- Fügen Sie in den Dashboard-Einstellungen den Token in das Auth-Feld ein und verbinden Sie sich.
