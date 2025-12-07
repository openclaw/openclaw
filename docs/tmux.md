# tmux helpers (relay backgrounding)

## Why we ship tmux helpers
- Run the relay detached so your shell can close, while keeping an interactive pane you can reattach to.
- Provide a consistent start/attach workflow without adding a daemon mode or external process manager.
- Keep the relay code itself tmux-agnostic; tmux is only a launcher concern.

## Commands
- `clawdis relay:tmux` — restarts the `clawdis-relay` session running `pnpm clawdis relay --verbose`, then attaches (skips attach when stdout isn’t a TTY).
- `clawdis relay:tmux:attach` — attach to the existing session without restarting it.
- `clawdis relay:heartbeat:tmux` — same as `relay:tmux` but adds `--heartbeat-now` so Pi is pinged immediately on startup.

All helpers use the fixed session name `clawdis-relay`.

## Logs
- The relay always writes to the configured file logger (defaults to `/tmp/clawdis/clawdis.log`); on start it prints the active log path and level.
- tmux is just for interactive viewing; you can also tail the log file or use another supervisor if you prefer.
