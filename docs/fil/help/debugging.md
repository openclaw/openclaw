---
summary: "Mga tool sa pag-debug: watch mode, raw model streams, at pag-trace ng pagtagas ng reasoning"
read_when:
  - Kailangan mong inspeksyunin ang raw model output para sa pagtagas ng reasoning
  - Gusto mong patakbuhin ang Gateway sa watch mode habang nag-i-iterate
  - Kailangan mo ng paulit-ulit na workflow sa pag-debug
title: "Pag-debug"
---

# Pag-debug

Sinasaklaw ng pahinang ito ang mga helper sa pag-debug para sa streaming output, lalo na kapag
hinahalo ng provider ang reasoning sa normal na teksto.

## Mga runtime debug override

Gamitin ang `/debug` sa chat para magtakda ng **runtime-only** na config overrides (sa memorya, hindi sa disk).
Naka-disable ang `/debug` bilang default; i-enable gamit ang `commands.debug: true`.
Maginhawa ito kapag kailangan mong i-toggle ang mga bihirang setting nang hindi ine-edit ang `openclaw.json`.

Mga halimbawa:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

Nililinis ng `/debug reset` ang lahat ng override at ibinabalik sa on-disk config.

## Gateway watch mode

Para sa mabilis na iteration, patakbuhin ang gateway sa ilalim ng file watcher:

```bash
pnpm gateway:watch --force
```

Ito ay tumutugma sa:

```bash
tsx watch src/entry.ts gateway --force
```

Idagdag ang anumang gateway CLI flags pagkatapos ng `gateway:watch` at ipapasa ang mga ito
sa bawat restart.

## Dev profile + dev gateway (--dev)

Gamitin ang dev profile para ihiwalay ang estado at magpaikot ng ligtas, disposable na setup para sa
debugging. May **dalawang** `--dev` flags:

- **Global `--dev` (profile):** ini-isolate ang state sa ilalim ng `~/.openclaw-dev` at
  itinatakda bilang default ang gateway port sa `19001` (sumasabay ang mga derived port).
- **`gateway --dev`: sinasabi sa Gateway na awtomatikong gumawa ng default config +
  workspace** kapag wala pa (at laktawan ang BOOTSTRAP.md).

Inirerekomendang daloy (dev profile + dev bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Kung wala ka pang global install, patakbuhin ang CLI sa pamamagitan ng `pnpm openclaw ...`.

Ano ang ginagawa nito:

1. **Profile isolation** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (umaayon ang browser/canvas)

2. **Dev bootstrap** (`gateway --dev`)
   - Nagsusulat ng minimal na config kapag wala pa (`gateway.mode=local`, bind loopback).
   - Itinatakda ang `agent.workspace` sa dev workspace.
   - Itinatakda ang `agent.skipBootstrap=true` (walang BOOTSTRAP.md).
   - Nagtatanim ng mga workspace file kapag wala pa:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Default na identidad: **C3‑PO** (protocol droid).
   - Nilalaktawan ang mga channel provider sa dev mode (`OPENCLAW_SKIP_CHANNELS=1`).

Daloy ng reset (fresh start):

```bash
pnpm gateway:dev:reset
```

Tandaan: ang `--dev` ay isang **global** na profile flag at kinakain ng ilang runners.
Kung kailangan mong isulat ito nang buo, gamitin ang anyong env var:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

Binubura ng `--reset` ang config, credentials, sessions, at ang dev workspace (gamit ang
`trash`, hindi `rm`), pagkatapos ay muling nililikha ang default na dev setup.

Tip: kung may non‑dev gateway na tumatakbo na (launchd/systemd), ihinto muna ito:

```bash
openclaw gateway stop
```

## Raw stream logging (OpenClaw)

Maaaring mag-log ang OpenClaw ng **raw assistant stream** bago ang anumang pag-filter/pag-format.
Ito ang pinakamahusay na paraan para makita kung dumarating ang reasoning bilang plain text deltas
(o bilang hiwalay na thinking blocks).

I-enable sa pamamagitan ng CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Opsyonal na path override:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Katumbas na env vars:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Default na file:

`~/.openclaw/logs/raw-stream.jsonl`

## Raw chunk logging (pi-mono)

Para makuha ang **raw OpenAI-compat chunks** bago sila i-parse sa mga block,
naglalantad ang pi-mono ng hiwalay na logger:

```bash
PI_RAW_STREAM=1
```

Opsyonal na path:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Default na file:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Tandaan: ito ay inilalabas lamang ng mga prosesong gumagamit ng
> provider ng pi-mono na `openai-completions`.

## Mga tala sa kaligtasan

- Maaaring maglaman ang mga raw stream log ng buong prompt, tool output, at data ng user.
- Panatilihing lokal ang mga log at burahin ang mga ito pagkatapos ng pag-debug.
- Kung magbabahagi ka ng mga log, i-scrub muna ang mga lihim at PII.
