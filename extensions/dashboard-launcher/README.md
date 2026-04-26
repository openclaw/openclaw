# @openclaw/dashboard-launcher

Supervises the Mission Control Next.js dashboard via top-level `openclaw dashboard` verbs. The extension is purely a process supervisor — Mission Control's source stays in its own repo; this extension reads its env-driven contract.

## Verbs

| Verb     | Description                                                             |
| -------- | ----------------------------------------------------------------------- |
| `start`  | Spawn `node server.js` (or `npm run dev` with `--dev`) and watch it     |
| `stop`   | Flip the intent flag and SIGTERM the supervised pid (SIGKILL after 10s) |
| `status` | Print PID, intent, port, public-mode flag, health probe, log tail       |
| `logs`   | Tail the combined dashboard log                                         |

## Required environment

| Variable                  | Purpose                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `OPENCLAW_DASHBOARD_PATH` | Absolute path to the Mission Control checkout (must contain `server.js`) |
| `OPENCLAW_DASHBOARD_PORT` | Optional port override (default `3001`)                                  |
| `MISSION_CONTROL_PUBLIC`  | `1` to launch in public mode; requires `MC_AUTH_TOKEN`                   |
| `MC_AUTH_TOKEN`           | ≥32 hex chars when `MISSION_CONTROL_PUBLIC=1`                            |

## Quick start

```sh
export OPENCLAW_DASHBOARD_PATH=/path/to/MissionControl
openclaw dashboard start          # foreground supervisor; Ctrl-C to leave
openclaw dashboard status         # in another shell
openclaw dashboard logs --follow  # tail the combined log
openclaw dashboard stop           # signal the supervisor to stop and exit
```

## Logs and state

| Path                                 | Contents                         |
| ------------------------------------ | -------------------------------- |
| `~/.openclaw/logs/dashboard.out.log` | Mission Control stdout           |
| `~/.openclaw/logs/dashboard.err.log` | Mission Control stderr           |
| `~/.openclaw/dashboard.intent`       | `running` or `stopped`           |
| `~/.openclaw/dashboard.pid`          | PID of the live supervised child |

## Adoption guard

`start` refuses if `:3001` is already bound by another process. Pass `--adopt` to record that PID as the supervised process (no spawn — pure status/log adoption). Useful when migrating from the standalone `com.missioncontrol.nextjs` launchd plist.

## Migration from the launchd plist

```sh
launchctl bootout gui/$UID/com.missioncontrol.nextjs
openclaw dashboard start
```

Operators who prefer launchd-only management can keep doing exactly what they did — this extension is additive.

## Boot guard

When `MISSION_CONTROL_PUBLIC=1`, the extension refuses to spawn unless `MC_AUTH_TOKEN` is at least 32 hex characters. The intent is to fail fast with a clear message instead of letting the child boot-loop on Mission Control's own guard.

## Restart policy

- Backoff ladder: 1s, 2s, 4s, 8s, 60s ceiling.
- Reset to 1s after 5 minutes of clean uptime.
- Stop intent (`~/.openclaw/dashboard.intent` = `stopped`) breaks the loop on the next iteration.

## Limitations

- Logs are not rotated automatically; clear them with `: > ~/.openclaw/logs/dashboard.out.log` if they grow.
- The supervisor itself is foreground — when the operator's shell exits, supervision ends. For boot persistence either keep using the launchd plist or wrap `openclaw dashboard start` in your own service manager.
