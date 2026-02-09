---
summary: "Felsökningsverktyg: bevakningsläge, råa modellströmmar och spårning av resonemangsläckage"
read_when:
  - Du behöver inspektera rå modellutdata för resonemangsläckage
  - Du vill köra Gateway i bevakningsläge medan du itererar
  - Du behöver ett repeterbart felsökningsflöde
title: "Felsökning"
---

# Felsökning

Den här sidan beskriver felsökningshjälpmedel för strömmande utdata, särskilt när en
leverantör blandar resonemang i vanlig text.

## Körningsbaserade felsökningsöverskrivningar

Använd `/debug` i chatten för att sätta **körtid** config overrides (minne, inte disk).
`/debug` är inaktiverat som standard; aktivera med `commands.debug: true`.
Detta är praktiskt när du behöver växla oklara inställningar utan att redigera `openclaw.json`.

Exempel:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` rensar alla överskrivningar och återgår till konfigurationen på disk.

## Gateway-bevakningsläge

För snabb iteration, kör gatewayen under filbevakaren:

```bash
pnpm gateway:watch --force
```

Detta mappar till:

```bash
tsx watch src/entry.ts gateway --force
```

Lägg till valfria gateway-CLI-flaggor efter `gateway:watch` så skickas de vidare
vid varje omstart.

## Dev-profil + dev-gateway (--dev)

Använd dev-profilen för att isolera tillståndet och snurra upp en säker, engångsinställning för
felsökning. Det finns **två** `--dev`-flaggor:

- **Global `--dev` (profil):** isolerar tillstånd under `~/.openclaw-dev` och
  sätter gateway-porten som standard till `19001` (härledda portar skiftar med den).
- **`gateway --dev`: säger åt Gateway att automatiskt skapa en standardkonfig +
  arbetsyta** när den saknas (och hoppa över BOOTSTRAP.md).

Rekommenderat flöde (dev-profil + dev-bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Om du inte har en global installation ännu, kör CLI via `pnpm openclaw ...`.

Vad detta gör:

1. **Profilisolering** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (webbläsare/canvas skiftar i enlighet med detta)

2. **Dev-bootstrap** (`gateway --dev`)
   - Skriver en minimal konfig om den saknas (`gateway.mode=local`, bind loopback).
   - Sätter `agent.workspace` till dev-arbetsytan.
   - Sätter `agent.skipBootstrap=true` (ingen BOOTSTRAP.md).
   - Fröar arbetsytefilerna om de saknas:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Standardidentitet: **C3‑PO** (protokolldroid).
   - Hoppar över kanal-leverantörer i dev-läge (`OPENCLAW_SKIP_CHANNELS=1`).

Återställningsflöde (nystart):

```bash
pnpm gateway:dev:reset
```

Obs: `--dev` är en **global** profilflagga och äts av vissa löpare.
Om du behöver stava ut, använd env var form:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` rensar konfig, autentiseringsuppgifter, sessioner och dev-arbetsytan (med
`trash`, inte `rm`), och återskapar därefter standard-setupen för dev.

Tips: om en icke-dev-gateway redan körs (launchd/systemd), stoppa den först:

```bash
openclaw gateway stop
```

## Loggning av rå ström (OpenClaw)

OpenClaw kan logga **rå assistentström** före filtrering/formatering.
Detta är det bästa sättet att se om resonemanget kommer som ren text deltas
(eller som separata tankeblock).

Aktivera via CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Valfri sökvägsöverskrivning:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Motsvarande miljövariabler:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Standardfil:

`~/.openclaw/logs/raw-stream.jsonl`

## Loggning av råa chunkar (pi-mono)

För att fånga **råa OpenAI-kompatibla chunkar** innan de parsas till block,
exponerar pi-mono en separat logger:

```bash
PI_RAW_STREAM=1
```

Valfri sökväg:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Standardfil:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Obs: detta emitteras endast av processer som använder pi-monos
> `openai-completions`-leverantör.

## Säkerhetsnoteringar

- Råa strömloggar kan innehålla fullständiga prompter, verktygsutdata och användardata.
- Behåll loggar lokalt och radera dem efter felsökning.
- Om du delar loggar, rensa hemligheter och personuppgifter (PII) först.
