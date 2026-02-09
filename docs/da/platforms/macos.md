---
summary: "OpenClaw macOS-ledsagerapp (menulinje + gateway-broker)"
read_when:
  - Implementering af macOS-appfunktioner
  - Ændring af gateway-livscyklus eller node-bridging på macOS
title: "macOS-app"
---

# OpenClaw macOS-ledsager (menulinje + gateway-broker)

MacOS-appen er **menulinjens følgesvend** for OpenClaw. Det ejer tilladelser,
administrerer/tillægger Gateway lokalt (launchd eller manual), og udsætter macOS
-kapaciteter for agenten som et knudepunkt.

## Hvad den gør

- Viser indbyggede notifikationer og status i menulinjen.
- Ejer TCC-prompter (Notifikationer, Tilgængelighed, Skærmoptagelse, Mikrofon,
  Talegenkendelse, Automatisering/AppleScript).
- Kører eller forbinder til Gateway (lokal eller fjern).
- Eksponerer macOS‑specifikke værktøjer (Canvas, Kamera, Skærmoptagelse, `system.run`).
- Starter den lokale node-værtstjeneste i **fjern** tilstand (launchd) og stopper den i **lokal** tilstand.
- Kan valgfrit hoste **PeekabooBridge** til UI-automatisering.
- Installerer den globale CLI (`openclaw`) via npm/pnpm efter anmodning (bun anbefales ikke til Gateway-runtime).

## Lokal vs. fjern tilstand

- **Lokal** (standard): appen tilkobler sig en kørende lokal Gateway, hvis den findes;
  ellers aktiverer den launchd-tjenesten via `openclaw gateway install`.
- **Fjern**: Appen forbinder til en Gateway over SSH/Tailscale og starter aldrig
  en lokal proces.
  Appen starter den lokale **node host service**, så den eksterne Gateway kan nå denne Mac.
  Appen spawner ikke porten som et barn proces.

## Launchd-styring

Appen styrer en per-bruger LaunchAgent mærket `bot.molt.gateway`
(eller `bot.molt.<profile>` ved brug af `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` aflæsning).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Erstat etiketten med bot.molt.<profile>\` når du kører en navngiven profil.

Hvis LaunchAgent ikke er installeret, kan du aktivere den fra appen eller køre
`openclaw gateway install`.

## Node-funktioner (mac)

MacOS app præsenterer sig selv som et knudepunkt. Almindelige kommandoer:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Kamera: `camera.snap`, `camera.clip`
- Skærm: `screen.record`
- System: `system.run`, `system.notify`

Noden rapporterer et `permissions`-kort, så agenter kan afgøre, hvad der er tilladt.

Node-tjeneste + app IPC:

- Når den headless node-værtstjeneste kører (fjern tilstand), forbinder den til Gateway WS som en node.
- `system.run` udføres i macOS-appen (UI/TCC-kontekst) over en lokal Unix-socket; prompter + output forbliver i appen.

Diagram (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec-godkendelser (system.run)

`system.run` styres af **Exec godkendelser** i macOS appen (Settings → Exec godkendelser).
Sikkerhed + ask + tilladt liste gemmes lokalt på Mac i:

```
~/.openclaw/exec-approvals.json
```

Eksempel:

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

Noter:

- `allowlist`-poster er glob-mønstre for opløste binære stier.
- Valg af “Always Allow” i prompten tilføjer den kommando til tilladelseslisten.
- `system.run` miljøoverstyringer filtreres (fjerner `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) og flettes derefter med appens miljø.

## Deep links

Appen registrerer URL-skemaet `openclaw://` til lokale handlinger.

### `openclaw://agent`

Udløser en Gateway `agent`-anmodning.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Forespørgselsparametre:

- `message` (påkrævet)
- `sessionKey` (valgfri)
- `thinking` (valgfri)
- `deliver` / `to` / `channel` (valgfri)
- `timeoutSeconds` (valgfri)
- `key` (valgfri unattended-tilstandsnøgle)

Sikkerhed:

- Uden `key` beder appen om bekræftelse.
- Med en gyldig `key` er kørslen unattended (beregnet til personlige automatiseringer).

## Introduktionsflow (typisk)

1. Installér og start **OpenClaw.app**.
2. Gennemfør tilladelsestjeklisten (TCC-prompter).
3. Sørg for, at **Lokal** tilstand er aktiv, og at Gateway kører.
4. Installér CLI’en, hvis du ønsker terminaladgang.

## Build- og udviklingsworkflow (native)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (eller Xcode)
- Pak appen: `scripts/package-mac-app.sh`

## Fejlfinding af gateway-forbindelse (macOS CLI)

Brug debug-CLI’en til at afprøve den samme Gateway WebSocket-handshake og discovery-
logik, som macOS-appen bruger, uden at starte appen.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Forbindelsesindstillinger:

- `--url <ws://host:port>`: tilsidesæt konfiguration
- `--mode <local|remote>`: løs fra konfiguration (standard: konfiguration eller lokal)
- `--probe`: gennemtving en ny health-probe
- `--timeout <ms>`: anmodningstimeout (standard: `15000`)
- `--json`: struktureret output til diffing

Discovery-indstillinger:

- `--include-local`: medtag gateways, der ellers ville blive filtreret som “lokale”
- `--timeout <ms>`: samlet discovery-vindue (standard: `2000`)
- `--json`: struktureret output til diffing

Tip: sammenlign med `openclaw gateway discover --json` for at se, om macOS-appens discovery-pipeline
(NWBrowser + tailnet DNS‑SD fallback) adskiller sig fra Node CLI’ens
`dns-sd`-baserede discovery.

## Fjernforbindelsens plumbing (SSH-tunneler)

Når macOS-appen kører i **Fjern** tilstand, åbner den en SSH-tunnel, så lokale UI-
komponenter kan tale med en fjern Gateway, som om den var på localhost.

### Kontroltunnel (Gateway WebSocket-port)

- **Formål:** health checks, status, Web Chat, konfiguration og andre control-plane-kald.
- **Lokal port:** Gateway-porten (standard `18789`), altid stabil.
- **Fjernport:** den samme Gateway-port på den fjerne vært.
- **Adfærd:** ingen tilfældig lokal port; appen genbruger en eksisterende sund tunnel
  eller genstarter den efter behov.
- **SSH-form:** `ssh -N -L <local>:127.0.0.1:<remote>` med BatchMode +
  ExitOnForwardFailure + keepalive-indstillinger.
- **IP-rapportering:** SSH-tunnelen bruger loopback, så gatewayen vil se noden
  IP som `127.0.0.1`. Brug **Direkte (ws/wss)** transport, hvis du ønsker, at den rigtige klient
  IP skal vises (se [macOS fjernadgang](/platforms/mac/remote)).

For opsætningstrin, se [macOS fjernadgang](/platforms/mac/remote). For detaljer vedrørende protokol
, se [Gatewayprotokol] (/gateway/protocol).

## Relaterede dokumenter

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS-tilladelser](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
