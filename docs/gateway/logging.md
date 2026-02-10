---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Logging surfaces, file logs, WS log styles, and console formatting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing logging output or formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging CLI or gateway output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Logging"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Logging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For a user-facing overview (CLI + Control UI + config), see [/logging](/logging).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw has two log “surfaces”:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Console output** (what you see in the terminal / Debug UI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **File logs** (JSON lines) written by the gateway logger.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## File-based logger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default rolling log file is under `/tmp/openclaw/` (one file per day): `openclaw-YYYY-MM-DD.log`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Date uses the gateway host's local timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The log file path and level can be configured via `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `logging.file`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `logging.level`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The file format is one JSON object per line.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI Logs tab tails this file via the gateway (`logs.tail`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI can do the same:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Verbose vs. log levels**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **File logs** are controlled exclusively by `logging.level`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose` only affects **console verbosity** (and WS log style); it does **not**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  raise the file log level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To capture verbose-only details in file logs, set `logging.level` to `debug` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `trace`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Console capture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The CLI captures `console.log/info/warn/error/debug/trace` and writes them to file logs,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
while still printing to stdout/stderr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can tune console verbosity independently via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logging.consoleLevel` (default `info`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logging.consoleStyle` (`pretty` | `compact` | `json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool summary redaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verbose tool summaries (e.g. `🛠️ Exec: ...`) can mask sensitive tokens before they hit the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
console stream. This is **tools-only** and does not alter file logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logging.redactSensitive`: `off` | `tools` (default: `tools`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logging.redactPatterns`: array of regex strings (overrides defaults)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Use raw regex strings (auto `gi`), or `/pattern/flags` if you need custom flags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Matches are masked by keeping the first 6 + last 4 chars (length >= 18), otherwise `***`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Defaults cover common key assignments, CLI flags, JSON fields, bearer headers, PEM blocks, and popular token prefixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway WebSocket logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The gateway prints WebSocket protocol logs in two modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Normal mode (no `--verbose`)**: only “interesting” RPC results are printed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - errors (`ok=false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - slow calls (default threshold: `>= 50ms`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - parse errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Verbose mode (`--verbose`)**: prints all WS request/response traffic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### WS log style（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw gateway` supports a per-gateway style switch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ws-log auto` (default): normal mode is optimized; verbose mode uses compact output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ws-log compact`: compact output (paired request/response) when verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ws-log full`: full per-frame output when verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--compact`: alias for `--ws-log compact`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# optimized (only errors/slow)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# show all WS traffic (paired)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --verbose --ws-log compact（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# show all WS traffic (full meta)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --verbose --ws-log full（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Console formatting (subsystem logging)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The console formatter is **TTY-aware** and prints consistent, prefixed lines.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subsystem loggers keep output grouped and scannable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Subsystem prefixes** on every line (e.g. `[gateway]`, `[canvas]`, `[tailscale]`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Subsystem colors** (stable per subsystem) plus level coloring（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Color when output is a TTY or the environment looks like a rich terminal** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), respects `NO_COLOR`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Shortened subsystem prefixes**: drops leading `gateway/` + `channels/`, keeps last 2 segments (e.g. `whatsapp/outbound`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sub-loggers by subsystem** (auto prefix + structured field `{ subsystem }`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`logRaw()`** for QR/UX output (no prefix, no formatting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Console styles** (e.g. `pretty | compact | json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Console log level** separate from file log level (file keeps full detail when `logging.level` is set to `debug`/`trace`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **WhatsApp message bodies** are logged at `debug` (use `--verbose` to see them)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This keeps existing file logs stable while making interactive output scannable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
