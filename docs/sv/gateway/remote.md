---
summary: "Fjärråtkomst med SSH-tunnlar (Gateway WS) och tailnets"
read_when:
  - Körning eller felsökning av fjärrgateway-konfigurationer
title: "Fjärråtkomst"
---

# Fjärråtkomst (SSH, tunnlar och tailnets)

Det här repo:t stöder ”fjärr över SSH” genom att hålla en enda Gateway (master) igång på en dedikerad värd (desktop/server) och ansluta klienter till den.

- För **operatörer (du / macOS-appen)**: SSH-tunnling är den universella reserven.
- För **noder (iOS/Android och framtida enheter)**: anslut till Gateway **WebSocket** (LAN/tailnet eller SSH-tunnel vid behov).

## Grundidén

- Gateway WebSocket binder till **loopback** på din konfigurerade port (standard 18789).
- För fjärrbruk vidarebefordrar du den loopback-porten över SSH (eller använder ett tailnet/VPN och tunnlar mindre).

## Vanliga VPN-/tailnet-upplägg (där agenten bor)

Tänk på **Gateway värd** som “där agenten bor”. Det äger sessioner, auth profiler, kanaler och stat.
Din bärbara dator/skrivbord (och noder) ansluter till den värden.

### 1. Alltid-på Gateway i ditt tailnet (VPS eller hemserver)

Kör Gateway på en ihållande värd och nå den via **Tailscale** eller SSH.

- **Bästa UX:** behåll `gateway.bind: "loopback"` och använd **Tailscale Serve** för Control UI.
- **Reserv:** behåll loopback + SSH-tunnel från valfri maskin som behöver åtkomst.
- **Exempel:** [exe.dev](/install/exe-dev) (enkel VM) eller [Hetzner](/install/hetzner) (produktions-VPS).

Detta är idealiskt när din laptop ofta går i vila men du vill att agenten alltid ska vara igång.

### 2. Hemdator kör Gateway, laptop är fjärrkontroll

Den bärbara datorn kör **inte** agenten. Den ansluter på distans:

- Använd macOS-appens läge **Remote over SSH** (Inställningar → Allmänt → ”OpenClaw runs”).
- Appen öppnar och hanterar tunneln, så WebChat + hälsokontroller ”bara fungerar”.

Runbook: [macOS remote access](/platforms/mac/remote).

### 3. Laptop kör Gateway, fjärråtkomst från andra maskiner

Behåll Gateway lokalt men exponera den säkert:

- SSH-tunnel till laptopen från andra maskiner, eller
- Använd Tailscale Serve för Control UI och håll Gateway loopback-only.

Guide: [Tailscale](/gateway/tailscale) och [Web overview](/web).

## Kommandoflöde (vad körs var)

En gateway-tjänst äger stat + kanaler. Noder är kringutrustning.

Flödesexempel (Telegram → nod):

- Ett Telegram-meddelande anländer till **Gateway**.
- Gateway kör **agenten** och avgör om ett nodverktyg ska anropas.
- Gateway anropar **noden** över Gateway WebSocket (`node.*` RPC).
- Noden returnerar resultatet; Gateway svarar tillbaka till Telegram.

Noteringar:

- **Noder kör inte gateway-tjänsten.** Endast en gateway ska köras per värd om du inte avsiktligt kör isolerade profiler (se [Multiple gateways](/gateway/multiple-gateways)).
- macOS-appens ”node mode” är bara en nodklient över Gateway WebSocket.

## SSH-tunnel (CLI + verktyg)

Skapa en lokal tunnel till den fjärranslutna Gateway WS:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

När tunneln är uppe:

- `openclaw health` och `openclaw status --deep` når nu den fjärranslutna gatewayn via `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` kan också rikta in sig på den vidarebefordrade URL:en via `--url` vid behov.

Obs: ersätt `18789` med din konfigurerade `gateway.port` (eller `--port`/`OPENCLAW_GATEWAY_PORT`).
Notera: När du skickar `--url`, faller CLI inte tillbaka till config eller miljö referenser.
Inkludera `--token` eller` --lösenord` explicit. Saknar explicita referenser är ett fel.

## CLI-fjärrstandarder

Du kan spara ett fjärrmål så att CLI-kommandon använder det som standard:

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

När gatewayn är loopback-only, behåll URL:en på `ws://127.0.0.1:18789` och öppna SSH-tunneln först.

## Chatt-UI över SSH

WebChat använder inte längre en separat HTTP-port. SwiftUI chat UI ansluter direkt till Gateway WebSocket.

- Vidarebefordra `18789` över SSH (se ovan), och anslut sedan klienter till `ws://127.0.0.1:18789`.
- På macOS, föredra appens läge ”Remote over SSH”, som hanterar tunneln automatiskt.

## macOS-app ”Remote over SSH”

macOS-menyradsappen kan driva samma uppsättning från början till slut (fjärrstatuskontroller, WebChat och vidarebefordran av Voice Wake).

Runbook: [macOS remote access](/platforms/mac/remote).

## Säkerhetsregler (fjärr/VPN)

Kort version: **håll Gateway loopback-only** om du inte är säker på att du behöver en bindning.

- **Loopback + SSH/Tailscale Serve** är den säkraste standarden (ingen offentlig exponering).
- **Icke-loopback-bindningar** (`lan`/`tailnet`/`custom`, eller `auto` när loopback inte är tillgängligt) måste använda autentiseringstokens/lösenord.
- `gateway.remote.token` är **endast** för fjärr-CLI-anrop — det aktiverar **inte** lokal autentisering.
- `gateway.remote.tlsFingerprint` fäster det fjärranslutna TLS-certifikatet när `wss://` används.
- **Tailscale Serve** kan autentisera via identitetshuvuden när `gateway.auth.allowTailscale: true`.
  Sätt den till `false` om du vill ha tokens/lösenord istället.
- Behandla webbläsarkontroll som operatörsåtkomst: endast tailnet + avsiktlig nodparning.

Fördjupning: [Security](/gateway/security).
