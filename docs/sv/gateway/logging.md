---
summary: "Loggningsytor, filloggar, WS-loggstilar och konsolformatering"
read_when:
  - Ändrar loggningsutdata eller format
  - Felsöker CLI- eller gateway-utdata
title: "Loggning"
x-i18n:
  source_path: gateway/logging.md
  source_hash: efb8eda5e77e3809
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:22Z
---

# Loggning

För en användarnära översikt (CLI + Control UI + konfig), se [/logging](/logging).

OpenClaw har två logg-”ytor”:

- **Konsolutdata** (det du ser i terminalen / Debug UI).
- **Filloggar** (JSON-rader) som skrivs av gateway-loggaren.

## Filbaserad logger

- Standard roterande loggfil finns under `/tmp/openclaw/` (en fil per dag): `openclaw-YYYY-MM-DD.log`
  - Datum använder gateway-värdens lokala tidszon.
- Loggfilens sökväg och nivå kan konfigureras via `~/.openclaw/openclaw.json`:
  - `logging.file`
  - `logging.level`

Filformatet är ett JSON-objekt per rad.

Control UI:s flik Logs följer denna fil via gateway (`logs.tail`).
CLI kan göra samma sak:

```bash
openclaw logs --follow
```

**Utförlig kontra loggnivåer**

- **Filloggar** styrs uteslutande av `logging.level`.
- `--verbose` påverkar endast **konsolens utförlighet** (och WS-loggstil); den höjer **inte**
  filloggarnas nivå.
- För att fånga detaljer som bara visas i utförligt läge i filloggar, sätt `logging.level` till `debug` eller
  `trace`.

## Konsolinfångning

CLI fångar `console.log/info/warn/error/debug/trace` och skriver dem till filloggar,
samtidigt som de fortfarande skrivs till stdout/stderr.

Du kan justera konsolens utförlighet oberoende via:

- `logging.consoleLevel` (standard `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Maskning av verktygssammanfattningar

Utförliga verktygssammanfattningar (t.ex. `🛠️ Exec: ...`) kan maskera känsliga token innan de når
konsolströmmen. Detta gäller **endast verktyg** och ändrar inte filloggar.

- `logging.redactSensitive`: `off` | `tools` (standard: `tools`)
- `logging.redactPatterns`: array av regex-strängar (åsidosätter standardvärden)
  - Använd råa regex-strängar (auto `gi`), eller `/pattern/flags` om du behöver egna flaggor.
  - Träffar maskeras genom att behålla de första 6 + sista 4 tecknen (längd >= 18), annars `***`.
  - Standardvärden täcker vanliga nyckeltilldelningar, CLI-flaggor, JSON-fält, bearer-headers, PEM-block och populära tokenprefix.

## Gateway WebSocket-loggar

Gateway skriver WebSocket-protokollloggar i två lägen:

- **Normalt läge (utan `--verbose`)**: endast ”intressanta” RPC-resultat skrivs:
  - fel (`ok=false`)
  - långsamma anrop (standardtröskel: `>= 50ms`)
  - tolkningsfel
- **Utförligt läge (`--verbose`)**: skriver all WS-begäran-/svarstrafik.

### WS-loggstil

`openclaw gateway` stödjer ett stilbyte per gateway:

- `--ws-log auto` (standard): normalt läge är optimerat; utförligt läge använder kompakt utdata
- `--ws-log compact`: kompakt utdata (parad begäran/svar) vid utförligt
- `--ws-log full`: fullständig per-ram-utdata vid utförligt
- `--compact`: alias för `--ws-log compact`

Exempel:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Konsolformatering (delsystemloggning)

Konsolformateraren är **TTY-medveten** och skriver konsekventa rader med prefix.
Delsystemloggare håller utdata grupperad och lätt att skanna.

Beteende:

- **Delsystemprefix** på varje rad (t.ex. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Delsystemfärger** (stabila per delsystem) plus nivåfärgning
- **Färg när utdata är en TTY eller miljön ser ut som en rik terminal** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), respekterar `NO_COLOR`
- **Förkortade delsystemprefix**: tar bort inledande `gateway/` + `channels/`, behåller de sista 2 segmenten (t.ex. `whatsapp/outbound`)
- **Underloggare per delsystem** (auto-prefix + strukturerat fält `{ subsystem }`)
- **`logRaw()`** för QR/UX-utdata (inget prefix, ingen formatering)
- **Konsolstilar** (t.ex. `pretty | compact | json`)
- **Konsollognivå** separat från fillognivå (filen behåller full detalj när `logging.level` är satt till `debug`/`trace`)
- **WhatsApp-meddelandekroppar** loggas på `debug` (använd `--verbose` för att se dem)

Detta håller befintliga filloggar stabila samtidigt som interaktiv utdata blir lätt att skanna.
