---
summary: "Toegang op afstand via SSH-tunnels (Gateway WS) en tailnets"
read_when:
  - Bij het uitvoeren of oplossen van problemen met externe Gateway-opstellingen
title: "Toegang op afstand"
---

# Toegang op afstand (SSH, tunnels en tailnets)

Deze repo ondersteunt “Op afstand via SSH” door één Gateway (de master) draaiend te houden op een toegewijde host (desktop/server) en clients daarmee te verbinden.

- Voor **operators (jij / de macOS-app)**: SSH-tunneling is de universele fallback.
- Voor **nodes (iOS/Android en toekomstige apparaten)**: verbind met de Gateway **WebSocket** (LAN/tailnet of SSH-tunnel indien nodig).

## Het kernidee

- De Gateway WebSocket bindt aan **loopback** op je geconfigureerde poort (standaard 18789).
- Voor extern gebruik forward je die loopback-poort over SSH (of gebruik je een tailnet/VPN en tunnel je minder).

## Veelvoorkomende VPN/tailnet-opstellingen (waar de agent draait)

Zie de **Gateway-host** als “waar de agent draait.” Die beheert sessies, auth-profielen, kanalen en status.
Je laptop/desktop (en nodes) verbinden met die host.

### 1. Altijd-aan Gateway in je tailnet (VPS of thuisserver)

Draai de Gateway op een persistente host en bereik deze via **Tailscale** of SSH.

- **Beste UX:** behoud `gateway.bind: "loopback"` en gebruik **Tailscale Serve** voor de Control UI.
- **Fallback:** behoud loopback + SSH-tunnel vanaf elke machine die toegang nodig heeft.
- **Voorbeelden:** [exe.dev](/install/exe-dev) (eenvoudige VM) of [Hetzner](/install/hetzner) (productie-VPS).

Dit is ideaal wanneer je laptop vaak slaapt maar je de agent altijd aan wilt hebben.

### 2. Thuisdesktop draait de Gateway, laptop is afstandsbediening

De laptop draait **niet** de agent. Deze verbindt extern:

- Gebruik de macOS-appmodus **Op afstand via SSH** (Instellingen → Algemeen → “OpenClaw draait”).
- De app opent en beheert de tunnel, zodat WebChat + healthchecks “gewoon werken”.

Runbook: [macOS-toegang op afstand](/platforms/mac/remote).

### 3. Laptop draait de Gateway, externe toegang vanaf andere machines

Houd de Gateway lokaal maar stel deze veilig beschikbaar:

- SSH-tunnel naar de laptop vanaf andere machines, of
- Bied de Control UI aan via Tailscale Serve en houd de Gateway alleen op loopback.

Gids: [Tailscale](/gateway/tailscale) en [Web-overzicht](/web).

## Command flow (wat waar draait)

Eén Gateway-service beheert status + kanalen. Nodes zijn randapparaten.

Voorbeeldflow (Telegram → node):

- Telegram-bericht komt binnen bij de **Gateway**.
- De Gateway draait de **agent** en beslist of een node-tool wordt aangeroepen.
- De Gateway roept de **node** aan via de Gateway WebSocket (`node.*` RPC).
- De node retourneert het resultaat; de Gateway antwoordt terug naar Telegram.

Notities:

- **Nodes draaien de gateway-service niet.** Er zou slechts één gateway per host moeten draaien, tenzij je bewust geïsoleerde profielen draait (zie [Meerdere gateways](/gateway/multiple-gateways)).
- macOS-app “node-modus” is gewoon een node-client over de Gateway WebSocket.

## SSH-tunnel (CLI + tools)

Maak een lokale tunnel naar de externe Gateway WS:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Met de tunnel actief:

- `openclaw health` en `openclaw status --deep` bereiken nu de externe gateway via `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` kan indien nodig ook de geforwarde URL targeten via `--url`.

Let op: vervang `18789` door je geconfigureerde `gateway.port` (of `--port`/`OPENCLAW_GATEWAY_PORT`).
Let op: wanneer je `--url` doorgeeft, valt de CLI niet terug op config- of omgevingscredentials.
Neem `--token` of `--password` expliciet op. Ontbrekende expliciete credentials is een fout.

## CLI-standaardinstellingen voor remote

Je kunt een remote target opslaan zodat CLI-opdrachten dit standaard gebruiken:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Wanneer de gateway alleen op loopback draait, houd de URL op `ws://127.0.0.1:18789` en open eerst de SSH-tunnel.

## Chat UI over SSH

WebChat gebruikt geen aparte HTTP-poort meer. De SwiftUI-chat-UI verbindt direct met de Gateway WebSocket.

- Forward `18789` over SSH (zie hierboven) en verbind clients vervolgens met `ws://127.0.0.1:18789`.
- Geef op macOS de voorkeur aan de appmodus “Op afstand via SSH”, die de tunnel automatisch beheert.

## macOS-app “Op afstand via SSH”

De macOS-menubalkapp kan dezelfde setup end-to-end aansturen (remote statuschecks, WebChat en Voice Wake-forwarding).

Runbook: [macOS-toegang op afstand](/platforms/mac/remote).

## Beveiligingsregels (remote/VPN)

Korte versie: **houd de Gateway alleen op loopback** tenzij je zeker weet dat je een bind nodig hebt.

- **Loopback + SSH/Tailscale Serve** is de veiligste standaard (geen publieke blootstelling).
- **Niet-loopback binds** (`lan`/`tailnet`/`custom`, of `auto` wanneer loopback niet beschikbaar is) moeten auth-tokens/wachtwoorden gebruiken.
- `gateway.remote.token` is **alleen** voor externe CLI-aanroepen — het schakelt **geen** lokale authenticatie in.
- `gateway.remote.tlsFingerprint` pint het externe TLS-certificaat bij gebruik van `wss://`.
- **Tailscale Serve** kan authenticeren via identity headers wanneer `gateway.auth.allowTailscale: true`.
  Stel dit in op `false` als je in plaats daarvan tokens/wachtwoorden wilt gebruiken.
- Behandel browserbediening als operator-toegang: alleen tailnet + bewuste node-koppeling.

Verdieping: [Beveiliging](/gateway/security).
