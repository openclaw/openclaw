---
summary: "Integreret Tailscale Serve/Funnel til Gateway-dashboardet"
read_when:
  - Eksponering af Gateway Control UI uden for localhost
  - Automatisering af adgang til tailnet eller offentligt dashboard
title: "Tailscale"
---

# Tailscale (Gateway-dashboard)

OpenClaw kan automatisk konfigurere Tailscale **Serve** (tailnet) eller **Funnel** (offentlig) for
Gateway dashboard og WebSocket port. Dette holder Gateway bundet til loopback, mens
Tailscale giver HTTPS, routing, og (for Servere) identitet overskrifter.

## Tilstande

- `serve`: Tailnet-only Serve via `tailscale serve`. Porten forbliver på `127.0.0.1`.
- `tragt`: Offentlige HTTPS via `skræddersy tragt`. OpenClaw kræver en delt adgangskode.
- `off`: Standard (ingen Tailscale-automatisering).

## Autentificering

Sæt `gateway.auth.mode` for at styre handshaket:

- `token` (standard når `OPENCLAW_GATEWAY_TOKEN` er sat)
- `password` (delt hemmelighed via `OPENCLAW_GATEWAY_PASSWORD` eller konfiguration)

Når `tailscale.mode = "serve"` and `gateway.auth.allowTailscale` is `true`,
valid Serve proxy requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) without supply a token/password. OpenClaw verificerer
identiteten ved at løse 'x-forwarded-for'-adressen via den lokale Tailscale
-dæmonen ('tailscale whois') og matche den til headeren, før den accepteres.
OpenClaw behandler kun en anmodning som Servere, når den ankommer fra loopback med
Tailscales `x-forwarded-for`, `x-forwarded-proto`, og `x-forwarded-host`
headers.
For at kræve udtrykkelige legitimationsoplysninger, angiv `gateway.auth.allowTailscale: false` eller
force `gateway.auth.mode: "password"`.

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
- Serve/Tragt kun udsætte **Gateway control UI + WS**. Knuder forbinder over
  det samme Gateway WS-endepunkt, så Serve kan arbejde for node adgang.

## Browserkontrol (fjern-Gateway + lokal browser)

Hvis du kører Gateway på en maskine, men ønsker at køre en browser på en anden maskine,
køre en **node vært** på browseren maskine og holde begge på den samme hale.
Gateway vil proxy browser handlinger til indholdselementet, ingen separat kontrolserver eller Serverér URL nødvendig.

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
