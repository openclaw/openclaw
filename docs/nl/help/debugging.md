---
summary: "Debuggingtools: watch-modus, ruwe modelstreams en het traceren van redeneringslekken"
read_when:
  - Je moet ruwe modeluitvoer inspecteren op redeneringslekken
  - Je wilt de Gateway in watch-modus draaien tijdens iteraties
  - Je hebt een herhaalbare debugworkflow nodig
title: "Debugging"
---

# Debugging

Deze pagina behandelt hulpmiddelen voor het debuggen van streaming-uitvoer, vooral wanneer een
provider redenering mengt met normale tekst.

## Runtime debug-overschrijvingen

Gebruik `/debug` in chat om **alleen-runtime** config-overschrijvingen in te stellen (geheugen, niet schijf).
`/debug` is standaard uitgeschakeld; schakel in met `commands.debug: true`.
Dit is handig wanneer je obscure instellingen wilt toggelen zonder `openclaw.json` te bewerken.

Voorbeelden:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` wist alle overschrijvingen en keert terug naar de on-disk config.

## Gateway watch-modus

Voor snelle iteratie, draai de Gateway onder de bestandswatcher:

```bash
pnpm gateway:watch --force
```

Deze kaarten naar:

```bash
tsx watch src/entry.ts gateway --force
```

Voeg eventuele Gateway CLI-flags toe na `gateway:watch`; deze worden
bij elke herstart doorgegeven.

## Dev-profiel + dev Gateway (--dev)

Gebruik het dev-profiel om state te isoleren en een veilige, wegwerpbare setup op te starten voor
debugging. Er zijn **twee** `--dev`-flags:

- **Globale `--dev` (profiel):** isoleert state onder `~/.openclaw-dev` en
  zet standaard de Gateway-poort op `19001` (afgeleide poorten verschuiven mee).
- **`gateway --dev`: vertelt de Gateway om automatisch een standaardconfig +
  werkruimte** aan te maken wanneer deze ontbreekt (en BOOTSTRAP.md over te slaan).

Aanbevolen flow (dev-profiel + dev-bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Als je nog geen globale installatie hebt, voer de CLI uit via `pnpm openclaw ...`.

Wat dit doet:

1. **Profielisolatie** (globale `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas verschuift overeenkomstig)

2. **Dev-bootstrap** (`gateway --dev`)
   - Schrijft een minimale config als deze ontbreekt (`gateway.mode=local`, bind loopback).
   - Zet `agent.workspace` naar de dev-werkruimte.
   - Zet `agent.skipBootstrap=true` (geen BOOTSTRAP.md).
   - Seedt de werkruimtebestanden indien ontbrekend:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Standaardidentiteit: **C3‑PO** (protocoldroid).
   - Slaat kanaalproviders over in dev-modus (`OPENCLAW_SKIP_CHANNELS=1`).

Reset-flow (schone start):

```bash
pnpm gateway:dev:reset
```

Let op: `--dev` is een **globale** profiel-flag en wordt door sommige runners opgeslokt.
Als je deze expliciet moet opgeven, gebruik de env-var-vorm:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` wist config, credentials, sessies en de dev-werkruimte (met
`trash`, niet `rm`), en maakt vervolgens de standaard dev-setup opnieuw aan.

Tip: als er al een niet-dev Gateway draait (launchd/systemd), stop die eerst:

```bash
openclaw gateway stop
```

## Ruwe stream-logging (OpenClaw)

OpenClaw kan de **ruwe assistant-stream** loggen vóór enige filtering/formattering.
Dit is de beste manier om te zien of redenering als platte-tekst-delta’s binnenkomt
(of als aparte thinking-blokken).

Inschakelen via de CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Optionele pad-overschrijving:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Gelijkwaardige env-vars:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Standaardbestand:

`~/.openclaw/logs/raw-stream.jsonl`

## Ruwe chunk-logging (pi-mono)

Om **ruwe OpenAI-compat chunks** vast te leggen voordat ze in blokken worden geparseerd,
biedt pi-mono een aparte logger:

```bash
PI_RAW_STREAM=1
```

Optioneel pad:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Standaardbestand:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Let op: dit wordt alleen uitgezonden door processen die pi-mono’s
> `openai-completions`-provider gebruiken.

## Veiligheidsnotities

- Ruwe streamlogs kunnen volledige prompts, tooluitvoer en gebruikersgegevens bevatten.
- Houd logs lokaal en verwijder ze na het debuggen.
- Als je logs deelt, verwijder eerst geheimen en PII.
