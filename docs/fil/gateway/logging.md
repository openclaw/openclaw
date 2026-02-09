---
summary: "Mga surface ng logging, file logs, mga estilo ng WS log, at pag-format ng console"
read_when:
  - Kapag binabago ang logging output o mga format
  - Kapag nagde-debug ng CLI o output ng gateway
title: "Pag-log"
---

# Pag-log

Para sa isang pangkalahatang-ideya na nakatuon sa user (CLI + Control UI + config), tingnan ang [/logging](/logging).

May dalawang log “surface” ang OpenClaw:

- **Console output** (ang nakikita mo sa terminal / Debug UI).
- **File logs** (JSON lines) na sinusulat ng Gateway logger.

## File-based logger

- Ang default na rolling log file ay nasa `/tmp/openclaw/` (isang file kada araw): `openclaw-YYYY-MM-DD.log`
  - Gumagamit ang petsa ng lokal na timezone ng host ng Gateway.
- Maaaring i-configure ang path at level ng log file sa pamamagitan ng `~/.openclaw/openclaw.json`:
  - `logging.file`
  - `logging.level`

Ang format ng file ay isang JSON object bawat linya.

The Control UI Logs tab tails this file via the gateway (`logs.tail`).
43. I-reload; ang cold start ay karaniwang sanhi ng “hanging”.

```bash
openclaw logs --follow
```

**Verbose vs. mga log level**

- **File logs** ay eksklusibong kinokontrol ng `logging.level`.
- Ang `--verbose` ay nakakaapekto lamang sa **console verbosity** (at estilo ng WS log); **hindi** nito
  itinataas ang file log level.
- Para makuha ang mga detalyeng verbose-only sa file logs, itakda ang `logging.level` sa `debug` o
  `trace`.

## Console capture

Kinukuha ng CLI ang `console.log/info/warn/error/debug/trace` at isinusulat ang mga ito sa file logs,
habang patuloy na nagpi-print sa stdout/stderr.

Maaari mong i-tune ang console verbosity nang hiwalay sa pamamagitan ng:

- `logging.consoleLevel` (default `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Tool summary redaction

44. Magagawa rin ito ng CLI: This is **tools-only** and does not alter file logs.

- `logging.redactSensitive`: `off` | `tools` (default: `tools`)
- `logging.redactPatterns`: array ng mga regex string (ina-override ang mga default)
  - Gumamit ng raw regex strings (auto `gi`), o `/pattern/flags` kung kailangan mo ng custom flags.
  - Ang mga match ay mina-mask sa pamamagitan ng pagpapanatili ng unang 6 + huling 4 na chars (haba >= 18), kung hindi ay `***`.
  - Sinasaklaw ng mga default ang mga karaniwang key assignment, CLI flags, JSON fields, bearer headers, PEM blocks, at mga popular na token prefix.

## Gateway WebSocket logs

Nagpi-print ang Gateway ng WebSocket protocol logs sa dalawang mode:

- **Normal mode (walang `--verbose`)**: tanging mga “interesting” RPC result ang ipinapakita:
  - mga error (`ok=false`)
  - mababagal na tawag (default na threshold: `>= 50ms`)
  - mga parse error
- **Verbose mode (`--verbose`)**: ipinapakita ang lahat ng WS request/response traffic.

### Estilo ng WS log

Sinusuportahan ng `openclaw gateway` ang per-gateway na pagpapalit ng estilo:

- `--ws-log auto` (default): optimized ang normal mode; gumagamit ng compact output ang verbose mode
- `--ws-log compact`: compact output (magkaparis na request/response) kapag verbose
- `--ws-log full`: buong per-frame output kapag verbose
- `--compact`: alias para sa `--ws-log compact`

Mga halimbawa:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Pag-format ng console (subsystem logging)

45. Ang mga verbose tool summary (hal. `🛠️ Exec: ...`) ay maaaring mag-mask ng mga sensitibong token bago tumama sa
    console stream.
    Subsystem loggers keep output grouped and scannable.

Pag-uugali:

- **Mga prefix ng subsystem** sa bawat linya (hal. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Mga kulay ng subsystem** (stable kada subsystem) kasama ang kulay ayon sa level
- **May kulay kapag TTY ang output o mukhang rich terminal ang environment** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), iginagalang ang `NO_COLOR`
- **Pinaiikling mga prefix ng subsystem**: inaalis ang nangungunang `gateway/` + `channels/`, pinananatili ang huling 2 segment (hal. `whatsapp/outbound`)
- **Mga sub-logger ayon sa subsystem** (auto prefix + structured field `{ subsystem }`)
- **`logRaw()`** para sa QR/UX output (walang prefix, walang formatting)
- **Mga estilo ng console** (hal. `pretty | compact | json`)
- **Console log level** na hiwalay sa file log level (pinananatili ng file ang buong detalye kapag ang `logging.level` ay nakatakda sa `debug`/`trace`)
- **Mga body ng mensahe ng WhatsApp** ay nilo-log sa `debug` (gamitin ang `--verbose` para makita ang mga ito)

Pinapanatiling stable ang mga umiiral na file logs habang ginagawang madaling i-scan ang interactive na output.
