---
summary: "Gateway-Weboberflächen: Control UI, Bind-Modi und Sicherheit"
read_when:
  - Sie möchten auf das Gateway über Tailscale zugreifen
  - Sie möchten die browserbasierte Control UI und die Konfigurationsbearbeitung
title: "Web"
---

# Web (Gateway)

Das Gateway stellt eine kleine **browserbasierte Control UI** (Vite + Lit) über denselben Port wie das Gateway-WebSocket bereit:

- Standard: `http://<host>:18789/`
- optionales Präfix: setzen Sie `gateway.controlUi.basePath` (z. B. `/openclaw`)

Funktionen sind in der [Control UI](/web/control-ui) beschrieben.
Diese Seite konzentriert sich auf Bind-Modi, Sicherheit und webseitige Oberflächen.

## Webhooks

Wenn `hooks.enabled=true`, stellt das Gateway außerdem einen kleinen Webhook-Endpunkt auf demselben HTTP-Server bereit.
Siehe [Gateway-Konfiguration](/gateway/configuration) → `hooks` für Authentifizierung und Payloads.

## Konfiguration (standardmäßig aktiviert)

Die Control UI ist **standardmäßig aktiviert**, wenn Assets vorhanden sind (`dist/control-ui`).
Sie können dies über die Konfiguration steuern:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale-Zugriff

### Integriertes Serve (empfohlen)

Belassen Sie das Gateway auf dem Loopback und lassen Sie Tailscale Serve als Proxy fungieren:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Starten Sie dann das Gateway:

```bash
openclaw gateway
```

Öffnen Sie:

- `https://<magicdns>/` (oder Ihr konfiguriertes `gateway.controlUi.basePath`)

### Tailnet-Bind + Token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Starten Sie dann das Gateway (Token erforderlich für Nicht-Loopback-Binds):

```bash
openclaw gateway
```

Öffnen Sie:

- `http://<tailscale-ip>:18789/` (oder Ihr konfiguriertes `gateway.controlUi.basePath`)

### Öffentliches Internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Sicherheitshinweise

- Gateway-Authentifizierung ist standardmäßig erforderlich (Token/Passwort oder Tailscale-Identitäts-Header).
- Nicht-Loopback-Binds **erfordern** weiterhin ein gemeinsames Token/Passwort (`gateway.auth` oder env).
- Der Assistent generiert standardmäßig ein Gateway-Token (auch auf Loopback).
- Die UI sendet `connect.params.auth.token` oder `connect.params.auth.password`.
- Die Control UI sendet Anti-Clickjacking-Header und akzeptiert nur Same-Origin-Browser-
  WebSocket-Verbindungen, sofern `gateway.controlUi.allowedOrigins` nicht gesetzt ist.
- Mit Serve können Tailscale-Identitäts-Header die Authentifizierung erfüllen, wenn
  `gateway.auth.allowTailscale` `true` ist (kein Token/Passwort erforderlich). Setzen Sie
  `gateway.auth.allowTailscale: false`, um explizite Anmeldedaten zu verlangen. Siehe
  [Tailscale](/gateway/tailscale) und [Sicherheit](/gateway/security).
- `gateway.tailscale.mode: "funnel"` erfordert `gateway.auth.mode: "password"` (gemeinsames Passwort).

## UI bauen

Das Gateway stellt statische Dateien aus `dist/control-ui` bereit. Erstellen Sie diese mit:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
