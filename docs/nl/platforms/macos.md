---
summary: "OpenClaw macOS Companion-app (menubalk + gateway-broker)"
read_when:
  - Implementatie van macOS-appfuncties
  - Wijzigingen aan de levenscyclus van de Gateway of node-bridging op macOS
title: "macOS-app"
---

# OpenClaw macOS Companion (menubalk + gateway-broker)

De macOS-app is de **menubalk-companion** voor OpenClaw. De app beheert rechten,
beheert/maakt lokaal verbinding met de Gateway (launchd of handmatig) en stelt macOS‑mogelijkheden beschikbaar aan de agent als een node.

## Wat het doet

- Toont native meldingen en status in de menubalk.
- Beheert TCC-prompts (Meldingen, Toegankelijkheid, Schermopname, Microfoon,
  Spraakherkenning, Automatisering/AppleScript).
- Start of verbindt met de Gateway (lokaal of op afstand).
- Stelt macOS‑specifieke tools beschikbaar (Canvas, Camera, Schermopname, `system.run`).
- Start de lokale node-hostservice in **remote** modus (launchd) en stopt deze in **local** modus.
- Host optioneel **PeekabooBridge** voor UI-automatisering.
- Installeert op verzoek de globale CLI (`openclaw`) via npm/pnpm (bun wordt niet aanbevolen voor de Gateway-runtime).

## Lokale vs. remote modus

- **Local** (standaard): de app maakt verbinding met een draaiende lokale Gateway indien aanwezig;
  anders schakelt deze de launchd-service in via `openclaw gateway install`.
- **Remote**: de app verbindt met een Gateway via SSH/Tailscale en start nooit
  een lokaal proces.
  De app start de lokale **node-hostservice** zodat de remote Gateway deze Mac kan bereiken.
  De app start de Gateway niet als een childprocess.

## Launchd-besturing

De app beheert een per-gebruiker LaunchAgent met label `bot.molt.gateway`
(of `bot.molt.<profile>` bij gebruik van `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` wordt nog steeds ontladen).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Vervang het label door `bot.molt.<profile>` bij het uitvoeren van een benoemd profiel.

Als de LaunchAgent niet is geïnstalleerd, schakel deze in vanuit de app of voer
`openclaw gateway install` uit.

## Node-mogelijkheden (mac)

De macOS-app presenteert zichzelf als een node. Veelgebruikte opdrachten:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Scherm: `screen.record`
- Systeem: `system.run`, `system.notify`

De node rapporteert een `permissions`-map zodat agents kunnen bepalen wat is toegestaan.

Node-service + app IPC:

- Wanneer de headless node-hostservice draait (remote modus), verbindt deze als node met de Gateway WS.
- `system.run` wordt uitgevoerd in de macOS-app (UI/TCC-context) via een lokale Unix-socket; prompts + uitvoer blijven in de app.

Diagram (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Uitvoeringsgoedkeuringen (system.run)

`system.run` wordt beheerd via **Exec approvals** in de macOS-app (Instellingen → Exec approvals).
Beveiliging + bevestiging + toegestane lijst worden lokaal op de Mac opgeslagen in:

```
~/.openclaw/exec-approvals.json
```

Voorbeeld:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Notities:

- `allowlist`-items zijn globpatronen voor opgeloste binaire paden.
- Het kiezen van “Always Allow” in de prompt voegt die opdracht toe aan de toegestane lijst.
- `system.run`-omgevingsoverschrijvingen worden gefilterd (verwijdert `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) en vervolgens samengevoegd met de omgeving van de app.

## Deep links

De app registreert het URL-schema `openclaw://` voor lokale acties.

### `openclaw://agent`

Activeert een Gateway-`agent`-verzoek.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Queryparameters:

- `message` (vereist)
- `sessionKey` (optioneel)
- `thinking` (optioneel)
- `deliver` / `to` / `channel` (optioneel)
- `timeoutSeconds` (optioneel)
- `key` (optionele sleutel voor onbeheerde modus)

Veiligheid:

- Zonder `key` vraagt de app om bevestiging.
- Met een geldige `key` is de uitvoering onbeheerd (bedoeld voor persoonlijke automatiseringen).

## Onboardingflow (typisch)

1. Installeer en start **OpenClaw.app**.
2. Voltooi de rechtenchecklist (TCC-prompts).
3. Zorg dat **Local** modus actief is en dat de Gateway draait.
4. Installeer de CLI als je terminaltoegang wilt.

## Build- & dev-workflow (native)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (of Xcode)
- App verpakken: `scripts/package-mac-app.sh`

## Gateway-connectiviteit debuggen (macOS CLI)

Gebruik de debug-CLI om dezelfde Gateway WebSocket-handshake en discovery‑logica
te testen die de macOS-app gebruikt, zonder de app te starten.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Verbindingsopties:

- `--url <ws://host:port>`: config overschrijven
- `--mode <local|remote>`: oplossen vanuit config (standaard: config of lokaal)
- `--probe`: een nieuwe health-probe afdwingen
- `--timeout <ms>`: time-out voor verzoeken (standaard: `15000`)
- `--json`: gestructureerde uitvoer voor diffing

Discovery-opties:

- `--include-local`: gateways opnemen die als “local” zouden worden gefilterd
- `--timeout <ms>`: totale discovery-venster (standaard: `2000`)
- `--json`: gestructureerde uitvoer voor diffing

Tip: vergelijk met `openclaw gateway discover --json` om te zien of de
discovery-pijplijn van de macOS-app (NWBrowser + tailnet DNS‑SD-fallback) afwijkt van
de `dns-sd`-gebaseerde discovery van de Node CLI.

## Remote verbindingsarchitectuur (SSH-tunnels)

Wanneer de macOS-app in **Remote** modus draait, opent deze een SSH-tunnel zodat lokale UI‑componenten met een remote Gateway kunnen communiceren alsof deze op localhost draait.

### Control-tunnel (Gateway WebSocket-poort)

- **Doel:** healthchecks, status, Web Chat, config en andere control-plane-aanroepen.
- **Lokale poort:** de Gateway-poort (standaard `18789`), altijd stabiel.
- **Remote poort:** dezelfde Gateway-poort op de remote host.
- **Gedrag:** geen willekeurige lokale poort; de app hergebruikt een bestaande gezonde tunnel
  of start deze opnieuw indien nodig.
- **SSH-vorm:** `ssh -N -L <local>:127.0.0.1:<remote>` met BatchMode +
  ExitOnForwardFailure + keepalive-opties.
- **IP-rapportage:** de SSH-tunnel gebruikt loopback, dus de gateway ziet het node‑IP
  als `127.0.0.1`. Gebruik **Direct (ws/wss)** transport als je het echte client‑IP
  wilt laten verschijnen (zie [macOS remote access](/platforms/mac/remote)).

Voor installatiestappen, zie [macOS remote access](/platforms/mac/remote). Voor protocoldetails, zie [Gateway protocol](/gateway/protocol).

## Gerelateerde documentatie

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS-rechten](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
