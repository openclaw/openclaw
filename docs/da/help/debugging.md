---
summary: "Fejlsøgningsværktøjer: watch-tilstand, rå modelstreams og sporing af lækage af ræsonnement"
read_when:
  - Du skal inspicere rå modeloutput for lækage af ræsonnement
  - Du vil køre Gateway i watch-tilstand under iteration
  - Du har brug for en gentagelig fejlsøgningsworkflow
title: "Fejlsøgning"
---

# Fejlsøgning

Denne side dækker fejlsøgningshjælpere til streaming-output, især når en
udbyder blander ræsonnement ind i normal tekst.

## Runtime debug overrides

Brug `/debug` i chat for at angive **runtime-only** config overrides (hukommelse, ikke disk).
`/debug` er deaktiveret som standard; aktiver med `commands.debug: true`.
Dette er praktisk, når du skal skifte obskure indstillinger uden at redigere `openclaw.json`.

Eksempler:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` rydder alle overrides og vender tilbage til konfigurationen på disk.

## Gateway watch mode

For hurtig iteration kan du køre gatewayen under fil-watcher:

```bash
pnpm gateway:watch --force
```

Dette svarer til:

```bash
tsx watch src/entry.ts gateway --force
```

Tilføj eventuelle gateway CLI-flag efter `gateway:watch`, og de bliver sendt videre
ved hver genstart.

## Dev-profil + dev gateway (--dev)

Brug dev profil til at isolere tilstand og spin op en sikker, engangs opsætning for
fejlretning. Der er **to** `--dev` flag:

- **Global `--dev` (profil):** isolerer tilstand under `~/.openclaw-dev` og
  sætter som standard gateway-porten til `19001` (afledte porte flytter sig med den).
- **`gateway --dev`: fortæller Gateway at auto-oprette en standardkonfiguration +
  workspace**, hvis de mangler (og springe BOOTSTRAP.md over).

Anbefalet flow (dev-profil + dev bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Hvis du endnu ikke har en global installation, kan du køre CLI’en via `pnpm openclaw ...`.

Hvad dette gør:

1. **Profilisolering** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas flytter sig tilsvarende)

2. **Dev bootstrap** (`gateway --dev`)
   - Skriver en minimal konfiguration, hvis den mangler (`gateway.mode=local`, bind loopback).
   - Sætter `agent.workspace` til dev-workspacet.
   - Sætter `agent.skipBootstrap=true` (ingen BOOTSTRAP.md).
   - Seeder workspace-filerne, hvis de mangler:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Standardidentitet: **C3‑PO** (protokoldroide).
   - Springer kanaludbydere over i dev-tilstand (`OPENCLAW_SKIP_CHANNELS=1`).

Reset-flow (frisk start):

```bash
pnpm gateway:dev:reset
```

Bemærk: `--dev` er et **global** profilflag og bliver spist af nogle løbere.
Hvis du har brug for at stave det ud, skal du bruge env var formularen:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` sletter konfiguration, legitimationsoplysninger, sessioner og dev-workspacet (ved brug af
`trash`, ikke `rm`), og genskaber derefter standard dev-opsætningen.

Tip: Hvis en ikke-dev gateway allerede kører (launchd/systemd), så stop den først:

```bash
openclaw gateway stop
```

## Rå stream-logning (OpenClaw)

OpenClaw kan logge **rå assistent stream** før nogen filtrering/formatering.
Dette er den bedste måde at se, om ræsonnement ankommer som almindelig tekst deltas
(eller som separate tænkning blokke).

Aktivér via CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Valgfri sti-override:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Tilsvarende miljøvariabler:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Standardfil:

`~/.openclaw/logs/raw-stream.jsonl`

## Rå chunk-logning (pi-mono)

For at indfange **rå OpenAI-kompatible chunks** før de parses til blokke,
eksponerer pi-mono en separat logger:

```bash
PI_RAW_STREAM=1
```

Valgfri sti:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Standardfil:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Bemærk: dette udsendes kun af processer, der bruger pi-mono’s
> `openai-completions`-udbyder.

## Sikkerhedsnoter

- Rå stream-logs kan indeholde fulde prompts, værktøjsoutput og brugerdata.
- Bevar logs lokalt, og slet dem efter fejlsøgning.
- Hvis du deler logs, så fjern først hemmeligheder og PII.
