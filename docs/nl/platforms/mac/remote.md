---
summary: "macOS-appstroom voor het bedienen van een externe OpenClaw-gateway via SSH"
read_when:
  - Het instellen of debuggen van externe Mac-bediening
title: "Externe bediening"
---

# Externe OpenClaw (macOS ⇄ externe host)

Deze stroom laat de macOS-app fungeren als een volledige afstandsbediening voor een OpenClaw-gateway die op een andere host (desktop/server) draait. Dit is de **Op afstand via SSH**-functie (remote run) van de app. Alle functies—health checks, Voice Wake-doorsturen en Web Chat—gebruiken dezelfde externe SSH-configuratie uit _Instellingen → Algemeen_.

## Modi

- **Lokaal (deze Mac)**: Alles draait op de laptop. Geen SSH nodig.
- **Op afstand via SSH (standaard)**: OpenClaw-opdrachten worden uitgevoerd op de externe host. De macOS-app opent een SSH-verbinding met `-o BatchMode` plus je gekozen identiteit/sleutel en een lokale port-forward.
- **Extern direct (ws/wss)**: Geen SSH-tunnel. De macOS-app verbindt rechtstreeks met de gateway-URL (bijvoorbeeld via Tailscale Serve of een publieke HTTPS reverse proxy).

## Externe transports

De externe modus ondersteunt twee transports:

- **SSH-tunnel** (standaard): Gebruikt `ssh -N -L ...` om de gatewaypoort naar localhost door te sturen. De gateway ziet het IP van de node als `127.0.0.1` omdat de tunnel loopback is.
- **Direct (ws/wss)**: Verbindt rechtstreeks met de gateway-URL. De gateway ziet het echte client-IP.

## Vereisten op de externe host

1. Installeer Node + pnpm en bouw/installeer de OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Zorg dat `openclaw` op PATH staat voor niet-interactieve shells (maak zo nodig een symlink in `/usr/local/bin` of `/opt/homebrew/bin`).
3. Open SSH met sleutelauthenticatie. We raden **Tailscale**-IP’s aan voor stabiele bereikbaarheid buiten het LAN.

## macOS-appinstelling

1. Open _Instellingen → Algemeen_.
2. Kies onder **OpenClaw draait** **Op afstand via SSH** en stel in:
   - **Transport**: **SSH-tunnel** of **Direct (ws/wss)**.
   - **SSH-doel**: `user@host` (optioneel `:port`).
     - Als de gateway op hetzelfde LAN staat en Bonjour adverteert, kies deze uit de ontdekte lijst om dit veld automatisch in te vullen.
   - **Gateway-URL** (alleen Direct): `wss://gateway.example.ts.net` (of `ws://...` voor lokaal/LAN).
   - **Identiteitsbestand** (geavanceerd): pad naar je sleutel.
   - **Projectroot** (geavanceerd): extern checkout-pad dat voor opdrachten wordt gebruikt.
   - **CLI-pad** (geavanceerd): optioneel pad naar een uitvoerbare `openclaw`-entrypoint/binary (automatisch ingevuld wanneer geadverteerd).
3. Klik op **Test remote**. Succes geeft aan dat de externe `openclaw status --json` correct draait. Mislukkingen betekenen meestal PATH/CLI-problemen; exit 127 betekent dat de CLI extern niet wordt gevonden.
4. Health checks en Web Chat draaien nu automatisch via deze SSH-tunnel.

## Web Chat

- **SSH-tunnel**: Web Chat verbindt met de gateway via de doorgestuurde WebSocket-controlepoort (standaard 18789).
- **Direct (ws/wss)**: Web Chat verbindt rechtstreeks met de geconfigureerde gateway-URL.
- Er is geen aparte WebChat HTTP-server meer.

## Permissions

- De externe host heeft dezelfde TCC-goedkeuringen nodig als lokaal (Automatisering, Toegankelijkheid, Schermopname, Microfoon, Spraakherkenning, Meldingen). Voer onboarding op die machine uit om ze eenmalig te verlenen.
- Nodes adverteren hun rechtenstatus via `node.list` / `node.describe` zodat agents weten wat beschikbaar is.

## Beveiligingsnotities

- Geef de voorkeur aan loopback-binds op de externe host en verbind via SSH of Tailscale.
- Als je de Gateway bindt aan een niet-loopbackinterface, vereis token-/wachtwoordauthenticatie.
- Zie [Beveiliging](/gateway/security) en [Tailscale](/gateway/tailscale).

## WhatsApp-inlogstroom (extern)

- Voer `openclaw channels login --verbose` **op de externe host** uit. Scan de QR met WhatsApp op je telefoon.
- Herhaal de login op die host als de authenticatie verloopt. De health check zal koppelingsproblemen zichtbaar maken.

## Problemen oplossen

- **exit 127 / niet gevonden**: `openclaw` staat niet op PATH voor niet-login shells. Voeg het toe aan `/etc/paths`, je shell rc, of maak een symlink in `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: controleer SSH-bereikbaarheid, PATH en dat Baileys is ingelogd (`openclaw status --json`).
- **Web Chat blijft hangen**: bevestig dat de gateway op de externe host draait en dat de doorgestuurde poort overeenkomt met de gateway WS-poort; de UI vereist een gezonde WS-verbinding.
- **Node-IP toont 127.0.0.1**: verwacht bij de SSH-tunnel. Zet **Transport** op **Direct (ws/wss)** als je wilt dat de gateway het echte client-IP ziet.
- **Voice Wake**: triggerzinnen worden in de externe modus automatisch doorgestuurd; er is geen aparte forwarder nodig.

## Notificatie geluiden

Kies per melding geluiden vanuit scripts met `openclaw` en `node.invoke`, bijvoorbeeld:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Er is geen globale schakelaar “standaardgeluid” meer in de app; aanroepers kiezen per verzoek een geluid (of geen).
