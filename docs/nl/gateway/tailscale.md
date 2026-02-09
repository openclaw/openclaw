---
summary: "Geïntegreerde Tailscale Serve/Funnel voor het Gateway-dashboard"
read_when:
  - Het Gateway Control UI buiten localhost beschikbaar maken
  - Toegang tot het tailnet of een openbaar dashboard automatiseren
title: "Tailscale"
---

# Tailscale (Gateway-dashboard)

OpenClaw kan Tailscale **Serve** (tailnet) of **Funnel** (openbaar) automatisch configureren voor het
Gateway-dashboard en de WebSocket-poort. Dit houdt de Gateway gebonden aan loopback terwijl
Tailscale HTTPS, routering en (voor Serve) identiteitsheaders levert.

## Modi

- `serve`: Alleen tailnet-Serve via `tailscale serve`. De gateway blijft op `127.0.0.1`.
- `funnel`: Openbare HTTPS via `tailscale funnel`. OpenClaw vereist een gedeeld wachtwoord.
- `off`: Standaard (geen Tailscale-automatisering).

## Authenticatie

Stel `gateway.auth.mode` in om de handshake te regelen:

- `token` (standaard wanneer `OPENCLAW_GATEWAY_TOKEN` is ingesteld)
- `password` (gedeeld geheim via `OPENCLAW_GATEWAY_PASSWORD` of config)

Wanneer `tailscale.mode = "serve"` en `gateway.auth.allowTailscale` is `true`,
kunnen geldige Serve-proxyverzoeken authenticeren via Tailscale-identiteitsheaders
(`tailscale-user-login`) zonder een token/wachtwoord aan te leveren. OpenClaw verifieert
de identiteit door het `x-forwarded-for`-adres via de lokale Tailscale-
daemon (`tailscale whois`) op te lossen en dit te matchen met de header voordat het wordt geaccepteerd.
OpenClaw behandelt een verzoek alleen als Serve wanneer het via loopback binnenkomt met
Tailscale’s `x-forwarded-for`, `x-forwarded-proto` en `x-forwarded-host`-
headers.
Om expliciete inloggegevens te vereisen, stel `gateway.auth.allowTailscale: false` in of
forceer `gateway.auth.mode: "password"`.

## Config-voorbeelden

### Alleen tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Open: `https://<magicdns>/` (of je geconfigureerde `gateway.controlUi.basePath`)

### Alleen tailnet (binden aan Tailnet-IP)

Gebruik dit wanneer je wilt dat de Gateway direct luistert op het Tailnet-IP (geen Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Verbind vanaf een ander Tailnet-apparaat:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Let op: loopback (`http://127.0.0.1:18789`) werkt **niet** in deze modus.

### Openbaar internet (Funnel + gedeeld wachtwoord)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Geef de voorkeur aan `OPENCLAW_GATEWAY_PASSWORD` boven het vastleggen van een wachtwoord op schijf.

## CLI-voorbeelden

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notities

- Tailscale Serve/Funnel vereist dat de `tailscale` CLI is geïnstalleerd en aangemeld.
- `tailscale.mode: "funnel"` weigert te starten tenzij de auth-modus `password` is om publieke blootstelling te voorkomen.
- Stel `gateway.tailscale.resetOnExit` in als je wilt dat OpenClaw `tailscale serve`
  of `tailscale funnel`-configuratie ongedaan maakt bij afsluiten.
- `gateway.bind: "tailnet"` is een directe Tailnet-binding (geen HTTPS, geen Serve/Funnel).
- `gateway.bind: "auto"` geeft de voorkeur aan loopback; gebruik `tailnet` als je alleen tailnet wilt.
- Serve/Funnel stellen alleen de **Gateway control UI + WS** bloot. Nodes verbinden via
  hetzelfde Gateway WS-eindpunt, dus Serve kan werken voor node-toegang.

## Browserbediening (externe Gateway + lokale browser)

Als je de Gateway op één machine draait maar een browser op een andere machine wilt aansturen,
start dan een **node-host** op de browsermachine en houd beide op hetzelfde tailnet.
De Gateway proxyt browseracties naar de node; er is geen aparte control server of Serve-URL nodig.

Vermijd Funnel voor browserbediening; behandel node-koppeling als operator-toegang.

## Tailscale-vereisten + beperkingen

- Serve vereist dat HTTPS is ingeschakeld voor je tailnet; de CLI vraagt hierom als het ontbreekt.
- Serve injecteert Tailscale-identiteitsheaders; Funnel doet dat niet.
- Funnel vereist Tailscale v1.38.3+, MagicDNS, HTTPS ingeschakeld en een funnel-node-attribuut.
- Funnel ondersteunt alleen poorten `443`, `8443` en `10000` over TLS.
- Funnel op macOS vereist de open-source Tailscale-appvariant.

## Meer informatie

- Overzicht Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve`-opdracht: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Overzicht Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel`-opdracht: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
