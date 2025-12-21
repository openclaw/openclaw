---
summary: "Logging surfaces, file logs, WS log styles, and console formatting"
read_when:
  - Changing logging output or formats
  - Debugging CLI or gateway output
---

# Logging

Clawdis has two log “surfaces”:

- **Console output** (what you see in the terminal / Debug UI).
- **File logs** (JSON lines) written by the internal logger.

## File-based logger

Clawdis uses a file logger backed by `tslog` (`src/logging.ts`).

- Default rolling log file is under `/tmp/clawdis/` (one file per day): `clawdis-YYYY-MM-DD.log`
- The log file path and level can be configured via `~/.clawdis/clawdis.json`:
  - `logging.file`
  - `logging.level`

The file format is one JSON object per line.

## Console capture

The CLI entrypoint enables console capture (`src/index.ts` calls `enableConsoleCapture()`).
That means every `console.log/info/warn/error/debug/trace` is also written into the file logs,
while still behaving normally on stdout/stderr.

## Gateway WebSocket logs

The gateway prints WebSocket protocol logs in two modes:

- **Normal mode (no `--verbose`)**: only “interesting” RPC results are printed:
  - errors (`ok=false`)
  - slow calls (default threshold: `>= 50ms`)
  - parse errors
- **Verbose mode (`--verbose`)**: prints all WS request/response traffic.

### WS log style

`clawdis gateway` supports a per-gateway style switch:

- `--ws-log auto` (default): normal mode is optimized; verbose mode uses compact output
- `--ws-log compact`: compact output (paired request/response) when verbose
- `--ws-log full`: full per-frame output when verbose
- `--compact`: alias for `--ws-log compact`

Examples:

```bash
# optimized (only errors/slow)
clawdis gateway

# show all WS traffic (paired)
clawdis gateway --verbose --ws-log compact

# show all WS traffic (full meta)
clawdis gateway --verbose --ws-log full
```

## Console formatting (subsystem logging)

Clawdis formats console logs via a small wrapper on top of the existing stack:

- **tslog** for structured file logs (`src/logging.ts`)
- **chalk** for colors (`src/globals.ts`)

The console formatter is **TTY-aware** and prints consistent, prefixed lines.
Subsystem loggers are created via `createSubsystemLogger("gateway")`.

Behavior:

- **Subsystem prefixes** on every line (e.g. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Color only when TTY** (`process.stdout.isTTY` + `NO_COLOR` respected)
- **Sub-loggers by subsystem** (auto prefix + structured field `{ subsystem }`)
- **`logRaw()`** for QR/UX output (no prefix, no formatting)
- **Console styles** (e.g. `pretty | compact | json`)
- **Console log level** separate from file log level (file keeps full detail)

This keeps existing file logs stable while making interactive output scannable.
