---
summary: "Integreret Tailscale Serve/Funnel til Gateway-dashboardet"
read_when:
  - Eksponering af Gateway Control UI uden for localhost
  - Automatisering af adgang til tailnet eller offentligt dashboard
title: "Tailscale"
x-i18n:
  source_path: gateway/tailscale.md
  source_hash: c4842b10848d4fdd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:21Z
---

# Tailscale (Gateway-dashboard)

OpenClaw kan automatisk konfigurere Tailscale **Serve** (tailnet) eller **Funnel** (offentlig) til
Gateway-dashboardet og WebSocket-porten. Det holder Gateway bundet til loopback, mens
Tailscale leverer HTTPS, routing og (for Serve) identitets-headere.

## Tilstande

- `serve`: Kun tailnet Serve via `tailscale serve`. Gatewayen forbliver på `127.0.0.1`.
- `funnel`: Offentlig HTTPS via `tailscale funnel`. OpenClaw kræver en delt adgangskode.
- `off`: Standard (ingen Tailscale-automatisering).

## Autentificering

Sæt `gateway.auth.mode` for at styre handshaket:

- `token` (standard når `OPENCLAW_GATEWAY_TOKEN` er sat)
- `password` (delt hemmelighed via `OPENCLAW_GATEWAY_PASSWORD` eller konfiguration)

Når `tailscale.mode = "serve"` og `gateway.auth.allowTailscale` er `true`,
kan gyldige Serve-proxyanmodninger autentificere via Tailscale-identitets-headere
(`tailscale-user-login`) uden at angive token/adgangskode. OpenClaw verificerer
identiteten ved at resolve `x-forwarded-for`-adressen via den lokale Tailscale-
daemon (`tailscale whois`) og matcher den med headeren, før den accepteres.
OpenClaw betragter kun en anmodning som Serve, når den ankommer fra loopback med
Tailscales `x-forwarded-for`, `x-forwarded-proto` og `x-forwarded-host`-
headere.
For at kræve eksplicitte legitimationsoplysninger, sæt `gateway.auth.allowTailscale: false` eller
tving `gateway.auth.mode: "password"`.

## Konfigurationseksempler

### Kun tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Åbn: `https://<magicdns>/` (eller din konfigurerede `gateway.controlUi.basePath`)

### Kun tailnet (bind til Tailnet-IP)

Brug dette, når du vil have Gateway til at lytte direkte på Tailnet-IP’en (ingen Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Forbind fra en anden Tailnet-enhed:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Bemærk: loopback (`http://127.0.0.1:18789`) vil **ikke** fungere i denne tilstand.

### Offentligt internet (Funnel + delt adgangskode)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Foretræk `OPENCLAW_GATEWAY_PASSWORD` frem for at committe en adgangskode til disk.

## CLI-eksempler

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Noter

- Tailscale Serve/Funnel kræver, at `tailscale` CLI er installeret og logget ind.
- `tailscale.mode: "funnel"` nægter at starte, medmindre autentificeringstilstanden er `password`, for at undgå offentlig eksponering.
- Sæt `gateway.tailscale.resetOnExit`, hvis du vil have OpenClaw til at fortryde `tailscale serve`-
  eller `tailscale funnel`-konfiguration ved nedlukning.
- `gateway.bind: "tailnet"` er en direkte Tailnet-binding (ingen HTTPS, ingen Serve/Funnel).
- `gateway.bind: "auto"` foretrækker loopback; brug `tailnet`, hvis du vil have kun Tailnet.
- Serve/Funnel eksponerer kun **Gateway control UI + WS**. Noder forbinder over
  det samme Gateway WS-endpoint, så Serve kan fungere til nodeadgang.

## Browserkontrol (fjern-Gateway + lokal browser)

Hvis du kører Gatewayen på én maskine, men vil styre en browser på en anden maskine,
så kør en **node host** på browsermaskinen og hold begge på samme tailnet.
Gatewayen vil proxy browserhandlinger til noden; ingen separat kontrolserver eller Serve-URL er nødvendig.

Undgå Funnel til browserkontrol; behandl node-parring som operatøradgang.

## Tailscale-forudsætninger + begrænsninger

- Serve kræver, at HTTPS er aktiveret for dit tailnet; CLI’en beder, hvis det mangler.
- Serve injicerer Tailscale-identitets-headere; Funnel gør ikke.
- Funnel kræver Tailscale v1.38.3+, MagicDNS, HTTPS aktiveret og en funnel-nodeattribut.
- Funnel understøtter kun portene `443`, `8443` og `10000` over TLS.
- Funnel på macOS kræver open source-varianten af Tailscale-appen.

## Lær mere

- Overblik over Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve`-kommando: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Overblik over Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel`-kommando: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
