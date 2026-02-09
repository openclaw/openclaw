---
summary: "Integrerad Tailscale Serve/Funnel för Gateway-instrumentpanelen"
read_when:
  - Exponera Gateway-kontrollgränssnittet utanför localhost
  - Automatisera åtkomst till tailnet eller offentlig instrumentpanel
title: "Tailscale"
---

# Tailscale (Gateway-instrumentpanel)

OpenClaw kan automatiskt konfigurera Tailscale **Serve** (tailnet) eller **Funnel** (offentligt) för
Gateway-instrumentpanelen och WebSocket-porten. Detta håller Gateway bunden till loopback medan
Tailscale tillhandahåller HTTPS, routing och (för server) identitetshuvuden.

## Lägen

- `serve`: Endast Tailnet-Serve via `tailscale serve`. Gateway stannar på `127.0.1`.
- `trattel`: Offentlig HTTPS via `tailscale tratt`. OpenClaw kräver ett delat lösenord.
- `off`: Standard (ingen Tailscale-automatisering).

## Autentisering

Sätt `gateway.auth.mode` för att styra handskakningen:

- `token` (standard när `OPENCLAW_GATEWAY_TOKEN` är satt)
- `password` (delad hemlighet via `OPENCLAW_GATEWAY_PASSWORD` eller konfig)

När `tailscale.mode = "serve"` och` gateway.auth.allowTailscale` är `true`,
giltig Serve proxy förfrågningar kan autentiseras via Tailscale identitetshuvuden
(`tailscale-user-login`) utan att ange ett token/lösenord. OpenClaw verifierar
identiteten genom att lösa `x-forwarded-for`-adressen via den lokala Tailscale
-demonen (`tailscale whois`) och matcha den med huvudet innan den accepteras.
OpenClaw behandlar endast en begäran som Serve när den anländer från loopback med
Tailscale's `x-forwarded-for`, `x-forwarded-proto` och `x-forwarded-host`
headers.
För att kräva explicita användaruppgifter, ange `gateway.auth.allowTailscale: false` eller
tvinga `gateway.auth.mode: "password"`.

## Konfig-exempel

### Endast tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Öppna: `https://<magicdns>/` (eller din konfigurerade `gateway.controlUi.basePath`)

### Endast tailnet (bind till Tailnet-IP)

Använd detta när du vill att Gateway ska lyssna direkt på Tailnet-IP:n (ingen Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Anslut från en annan Tailnet-enhet:

- Kontroll-UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Obs: loopback (`http://127.0.0.1:18789`) kommer **inte** att fungera i detta läge.

### Offentligt internet (Funnel + delat lösenord)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Föredra `OPENCLAW_GATEWAY_PASSWORD` framför att checka in ett lösenord på disk.

## CLI-exempel

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Noteringar

- Tailscale Serve/Funnel kräver att `tailscale` CLI är installerat och inloggat.
- `tailscale.mode: "funnel"` vägrar att starta om inte autentiseringsläget är `password` för att undvika offentlig exponering.
- Sätt `gateway.tailscale.resetOnExit` om du vill att OpenClaw ska ångra `tailscale serve`
  eller `tailscale funnel`-konfiguration vid nedstängning.
- `gateway.bind: "tailnet"` är en direkt Tailnet-bindning (ingen HTTPS, ingen Serve/Funnel).
- `gateway.bind: "auto"` föredrar loopback; använd `tailnet` om du vill ha endast tailnet.
- Serva/Trnel endast exponera **Gateway control UI + WS**. Noder ansluter över
  samma Gateway WS slutpunkt, så Serve kan fungera för nod åtkomst.

## Webbläsarkontroll (fjärr-Gateway + lokal webbläsare)

Om du kör Gateway på en maskin men vill köra en webbläsare på en annan maskin,
kör en **nod värd** på webbläsarmaskinen och hålla båda på samma tailnet.
Gateway kommer proxy webbläsare åtgärder till noden, ingen separat kontrollserver eller Serve URL behövs.

Undvik Funnel för webbläsarkontroll; behandla nodparning som operatörsåtkomst.

## Tailscale-förutsättningar + begränsningar

- Serve kräver att HTTPS är aktiverat för ditt tailnet; CLI:t uppmanar om det saknas.
- Serve injicerar Tailscales identitetshuvuden; Funnel gör det inte.
- Funnel kräver Tailscale v1.38.3+, MagicDNS, HTTPS aktiverat och ett funnel-node-attribut.
- Funnel stöder endast portarna `443`, `8443` och `10000` över TLS.
- Funnel på macOS kräver den öppna källkodsvarianten av Tailscale-appen.

## Läs mer

- Översikt över Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- Kommandot `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Översikt över Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- Kommandot `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
