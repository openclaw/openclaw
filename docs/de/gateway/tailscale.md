---
summary: "Integriertes Tailscale Serve/Funnel für das Gateway-Dashboard"
read_when:
  - Exponieren der Gateway-Control-UI außerhalb von localhost
  - Automatisieren des Tailnet- oder öffentlichen Dashboard-Zugriffs
title: "Tailscale"
---

# Tailscale (Gateway-Dashboard)

OpenClaw kann Tailscale **Serve** (Tailnet) oder **Funnel** (öffentlich) automatisch für das
Gateway-Dashboard und den WebSocket-Port konfigurieren. Dadurch bleibt das Gateway an den
Loopback gebunden, während Tailscale HTTPS, Routing und (bei Serve) Identitäts-Header bereitstellt.

## Modi

- `serve`: Reines Tailnet-Serve über `tailscale serve`. Das Gateway bleibt auf `127.0.0.1`.
- `funnel`: Öffentliches HTTPS über `tailscale funnel`. OpenClaw erfordert ein gemeinsames Passwort.
- `off`: Standard (keine Tailscale-Automatisierung).

## Authentifizierung

Setzen Sie `gateway.auth.mode`, um den Handshake zu steuern:

- `token` (Standard, wenn `OPENCLAW_GATEWAY_TOKEN` gesetzt ist)
- `password` (Shared Secret über `OPENCLAW_GATEWAY_PASSWORD` oder Konfiguration)

Wenn `tailscale.mode = "serve"` und `gateway.auth.allowTailscale` auf `true` gesetzt ist,
können gültige Serve-Proxy-Anfragen über Tailscale-Identitäts-Header
(`tailscale-user-login`) authentifiziert werden, ohne ein Token/Passwort anzugeben. OpenClaw verifiziert
die Identität, indem es die Adresse `x-forwarded-for` über den lokalen Tailscale-Daemon
(`tailscale whois`) auflöst und sie vor der Annahme mit dem Header abgleicht.
OpenClaw behandelt eine Anfrage nur dann als Serve, wenn sie vom Loopback stammt und
Tailscales `x-forwarded-for`-, `x-forwarded-proto`- und `x-forwarded-host`-Header enthält.
Um explizite Anmeldedaten zu erzwingen, setzen Sie `gateway.auth.allowTailscale: false` oder
erzwingen Sie `gateway.auth.mode: "password"`.

## Konfigurationsbeispiele

### Nur Tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Öffnen: `https://<magicdns>/` (oder Ihr konfiguriertes `gateway.controlUi.basePath`)

### Nur Tailnet (an Tailnet-IP binden)

Verwenden Sie dies, wenn das Gateway direkt an der Tailnet-IP lauschen soll (kein Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Verbindung von einem anderen Tailnet-Gerät herstellen:

- Control-UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Hinweis: Loopback (`http://127.0.0.1:18789`) funktioniert in diesem Modus **nicht**.

### Öffentliches Internet (Funnel + gemeinsames Passwort)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Bevorzugen Sie `OPENCLAW_GATEWAY_PASSWORD`, statt ein Passwort auf die Festplatte zu schreiben.

## CLI-Beispiele

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Hinweise

- Tailscale Serve/Funnel erfordert, dass die `tailscale`-CLI installiert und angemeldet ist.
- `tailscale.mode: "funnel"` startet nicht, solange der Authentifizierungsmodus nicht `password` ist, um eine öffentliche Exposition zu vermeiden.
- Setzen Sie `gateway.tailscale.resetOnExit`, wenn OpenClaw die `tailscale serve`-
  oder `tailscale funnel`-Konfiguration beim Herunterfahren rückgängig machen soll.
- `gateway.bind: "tailnet"` ist eine direkte Tailnet-Bindung (kein HTTPS, kein Serve/Funnel).
- `gateway.bind: "auto"` bevorzugt Loopback; verwenden Sie `tailnet`, wenn Sie ausschließlich Tailnet möchten.
- Serve/Funnel exponieren nur die **Gateway-Control-UI + WS**. Nodes verbinden sich über
  denselben Gateway-WS-Endpunkt, sodass Serve für den Node-Zugriff funktionieren kann.

## Browser-Steuerung (Remote-Gateway + lokaler Browser)

Wenn Sie das Gateway auf einer Maschine ausführen, aber einen Browser auf einer anderen steuern möchten,
führen Sie einen **Node-Host** auf der Browser-Maschine aus und halten Sie beide im selben Tailnet.
Das Gateway proxyt Browser-Aktionen an den Node; kein separater Control-Server oder Serve-URL erforderlich.

Vermeiden Sie Funnel für die Browser-Steuerung; behandeln Sie das Node-Pairing wie Operator-Zugriff.

## Tailscale-Voraussetzungen + Einschränkungen

- Serve erfordert aktiviertes HTTPS für Ihr Tailnet; die CLI fordert dazu auf, falls es fehlt.
- Serve injiziert Tailscale-Identitäts-Header; Funnel nicht.
- Funnel erfordert Tailscale v1.38.3+, MagicDNS, aktiviertes HTTPS und ein Funnel-Node-Attribut.
- Funnel unterstützt über TLS nur die Ports `443`, `8443` und `10000`.
- Funnel unter macOS erfordert die Open-Source-Variante der Tailscale-App.

## Mehr erfahren

- Überblick zu Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve`-Befehl: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Überblick zu Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel`-Befehl: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
