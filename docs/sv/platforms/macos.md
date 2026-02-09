---
summary: "OpenClaw macOS-kompanjonapp (menyrad + gateway-broker)"
read_when:
  - Implementering av macOS-appfunktioner
  - Ändring av gateway-livscykel eller nodbryggning på macOS
title: "macOS-app"
---

# OpenClaw macOS Companion (menyrad + gateway-broker)

MacOS-appen är **menu‐bar följeslagare** för OpenClaw. Det äger behörigheter,
hanterar/bifogar till Gateway lokalt (launchd eller manual), och exponerar macOS
funktioner för agenten som en nod.

## Vad den gör

- Visar inbyggda notiser och status i menyraden.
- Äger TCC‑prompter (Notiser, Hjälpmedel, Skärminspelning, Mikrofon,
  Taligenkänning, Automation/AppleScript).
- Kör eller ansluter till Gateway (lokal eller fjärr).
- Exponerar macOS‑specifika verktyg (Canvas, Kamera, Skärminspelning, `system.run`).
- Startar den lokala nodvärdtjänsten i **fjärr**‑läge (launchd) och stoppar den i **lokalt** läge.
- Kan valfritt vara värd för **PeekabooBridge** för UI‑automation.
- Installerar den globala CLI:n (`openclaw`) via npm/pnpm på begäran (bun rekommenderas inte för Gateway‑körtiden).

## Lokalt vs fjärrläge

- **Lokalt** (standard): appen ansluter till en körande lokal Gateway om den finns;
  annars aktiverar den launchd‑tjänsten via `openclaw gateway install`.
- **Fjärr**: appen ansluter till en Gateway över SSH/Tailscale och startar aldrig
  en lokal process.
  Appen startar den lokala **node-värdtjänsten** så att fjärrporten kan nå denna Mac.
  Appen spawnar inte Gateway som en barnprocess.

## Launchd‑styrning

Appen hanterar en LaunchAgent märkt `bot.molt.gateway`
(eller `bot.molt.<profile>` vid användning av `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` lastar fortfarande).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Ersätt etiketten med `bot.molt.<profile>` när du kör en namngiven profil.

Om LaunchAgent inte är installerad, aktivera den från appen eller kör
`openclaw gateway install`.

## Nodfunktioner (mac)

MacOS-appen presenterar sig som en nod. Vanliga kommandon:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Kamera: `camera.snap`, `camera.clip`
- Skärm: `screen.record`
- System: `system.run`, `system.notify`

Noden rapporterar en `permissions`‑karta så att agenter kan avgöra vad som är tillåtet.

Nodtjänst + app‑IPC:

- När den huvudlösa nodvärdtjänsten kör (fjärrläge) ansluter den till Gateway WS som en nod.
- `system.run` körs i macOS‑appen (UI/TCC‑kontext) över en lokal Unix‑socket; prompter och utdata stannar i appen.

Diagram (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec‑godkännanden (system.run)

`system.run` styrs av **Exec-godkännanden** i macOS-appen (inställningar → Exec-godkännanden).
Säkerhet + fråga + tillåten lista lagras lokalt på Mac i:

```
~/.openclaw/exec-approvals.json
```

Exempel:

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

Noteringar:

- `allowlist`‑poster är globmönster för upplösta binärsökvägar.
- Att välja ”Always Allow” i prompten lägger till kommandot i tillåtelselistan.
- `system.run`‑miljööverskrivningar filtreras (tar bort `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) och slås sedan samman med appens miljö.

## Djupa länkar

Appen registrerar URL‑schemat `openclaw://` för lokala åtgärder.

### `openclaw://agent`

Utlöser en Gateway‑`agent`‑förfrågan.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Frågeparametrar:

- `message` (krävs)
- `sessionKey` (valfritt)
- `thinking` (valfritt)
- `deliver` / `to` / `channel` (valfritt)
- `timeoutSeconds` (valfritt)
- `key` (valfri nyckel för obevakat läge)

Säkerhet:

- Utan `key` ber appen om bekräftelse.
- Med en giltig `key` är körningen obevakad (avsedd för personliga automatiseringar).

## Introduktionsflöde (typiskt)

1. Installera och starta **OpenClaw.app**.
2. Slutför behörighetschecklistan (TCC‑prompter).
3. Säkerställ att **Lokalt** läge är aktivt och att Gateway körs.
4. Installera CLI:n om du vill ha terminalåtkomst.

## Build‑ och dev‑arbetsflöde (native)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (eller Xcode)
- Paketera appen: `scripts/package-mac-app.sh`

## Felsök gateway‑anslutning (macOS CLI)

Använd debug‑CLI:n för att köra samma Gateway WebSocket‑handskakning och Discovery‑logik
som macOS‑appen använder, utan att starta appen.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Anslutningsalternativ:

- `--url <ws://host:port>`: åsidosätt konfig
- `--mode <local|remote>`: lös från konfig (standard: konfig eller lokal)
- `--probe`: tvinga en ny hälsokontroll
- `--timeout <ms>`: timeout för begäran (standard: `15000`)
- `--json`: strukturerad utdata för diffning

Discovery‑alternativ:

- `--include-local`: inkludera gateways som annars skulle filtreras som ”lokala”
- `--timeout <ms>`: övergripande discovery‑fönster (standard: `2000`)
- `--json`: strukturerad utdata för diffning

Tips: jämför mot `openclaw gateway discover --json` för att se om
macOS‑appens discovery‑pipeline (NWBrowser + tailnet DNS‑SD‑fallback) skiljer sig från
Node‑CLI:ns `dns-sd`‑baserade discovery.

## Fjärranslutningsrördragning (SSH‑tunnlar)

När macOS‑appen körs i **Fjärr**‑läge öppnar den en SSH‑tunnel så att lokala UI‑komponenter
kan prata med en fjärransluten Gateway som om den vore på localhost.

### Kontrolltunnel (Gateway WebSocket‑port)

- **Syfte:** hälsokontroller, status, Web Chat, konfig och andra kontrollplansanrop.
- **Lokal port:** Gateway‑porten (standard `18789`), alltid stabil.
- **Fjärrport:** samma Gateway‑port på fjärrvärden.
- **Beteende:** ingen slumpmässig lokal port; appen återanvänder en befintlig frisk tunnel
  eller startar om den vid behov.
- **SSH‑form:** `ssh -N -L <local>:127.0.0.1:<remote>` med BatchMode +
  ExitOnForwardFailure + keepalive‑alternativ.
- **IP-rapportering:** SSH-tunneln använder loopback, så gateway kommer att se noden
  IP som `127.0.0.1`. Använd **Direkt (ws/wss)** transport om du vill att den verkliga klienten
  IP ska visas (se [macOS fjärråtkomst](/platforms/mac/remote)).

För inställningssteg, se [macOS remote access](/platforms/mac/remote). För protokollets
detaljer, se [Gateway protocol](/gateway/protocol).

## Relaterad dokumentation

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS‑behörigheter](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
