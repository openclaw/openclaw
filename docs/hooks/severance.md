---
summary: "Severance hook (split your agent into innie and outie personas)"
read_when:
  - You want to enable or configure Severance mode
  - You want separate work and personal personas
  - You want location-based or schedule-based persona switching
title: "Severance Hook"
---

# Severance Hook

The Severance hook splits your agent into two isolated personas — **innie** (work) and
**outie** (personal) — each with their own `SOUL.md` and `MEMORY.md`. Inspired by the
TV show _Severance_, where employees have their consciousness split between work and
personal life with total memory isolation.

## How It Works

When `agent:bootstrap` runs, the hook determines which persona is active based on the
configured activation mode. It then replaces `SOUL.md` and `MEMORY.md` content with the
persona-specific files (`SOUL.innie.md` / `SOUL.outie.md`, `MEMORY.innie.md` /
`MEMORY.outie.md`). No files are modified on disk.

Sub-agent runs are **not** affected — only the primary agent gets persona switching.

## Enable

```bash
openclaw hooks enable severance
```

Then set the activation mode in your config:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "severance": {
          "enabled": true,
          "activation": {
            "mode": "schedule",
            "schedule": {
              "workHours": { "start": "09:00", "end": "17:00" },
              "workDays": [1, 2, 3, 4, 5]
            }
          }
        }
      }
    }
  }
}
```

Create the persona files in your agent workspace root (next to `SOUL.md`):

- `SOUL.innie.md` — work persona instructions
- `SOUL.outie.md` — personal persona instructions
- `MEMORY.innie.md` — work-context memory
- `MEMORY.outie.md` — personal-context memory

## Activation Modes

### Schedule

Switches based on time of day and day of week in the user's timezone.

```json
{
  "activation": {
    "mode": "schedule",
    "schedule": {
      "workHours": { "start": "09:00", "end": "17:00" },
      "workDays": [1, 2, 3, 4, 5]
    }
  }
}
```

- `workHours.start` / `workHours.end` — 24-hour format (`HH:mm`)
- `workDays` — array of day numbers (0=Sun, 1=Mon, ..., 6=Sat); defaults to Mon–Fri
- Uses `agents.defaults.userTimezone` when set; otherwise host timezone

### Channel

Switches based on which messaging channel the message arrives from.

```json
{
  "activation": {
    "mode": "channel",
    "channels": {
      "innie": ["slack", "msteams"]
    }
  }
}
```

Messages from listed channels activate the innie; all others get the outie.

### Environment Variable

Switches based on the value of an environment variable.

```json
{
  "activation": {
    "mode": "env",
    "env": {
      "var": "OPENCLAW_PERSONA",
      "innieValue": "work"
    }
  }
}
```

If `$OPENCLAW_PERSONA` equals `"work"`, innie activates. Any other value → outie.
`innieValue` defaults to `"innie"` if not set.

### Manual

Explicitly sets the persona.

```json
{
  "activation": {
    "mode": "manual",
    "persona": "innie"
  }
}
```

### Location

Switches based on physical proximity to a configured location (geofence). Requires an
iOS or Android node app to push location updates.

```json
{
  "activation": {
    "mode": "location",
    "location": {
      "lat": 40.7128,
      "lon": -74.006,
      "radiusKm": 0.5
    }
  }
}
```

- `lat` / `lon` — work location coordinates
- `radiusKm` — geofence radius in kilometers
- The node app pushes `location.update` events via significant location change monitoring
- Falls back to outie when no location data is available

## Custom File Names

Override the default persona file names:

```json
{
  "activation": { "mode": "schedule", "schedule": { ... } },
  "files": {
    "soulInnie": "SOUL.work.md",
    "soulOutie": "SOUL.personal.md",
    "memoryInnie": "MEMORY.work.md",
    "memoryOutie": "MEMORY.personal.md"
  }
}
```

## Notes

- No files are written or modified on disk.
- If `SOUL.md` is not in the bootstrap list, the hook does nothing.
- If a persona file is missing or empty, the original `SOUL.md` / `MEMORY.md` is kept.
- For full memory isolation, use separate memory directories (`memory-innie/`,
  `memory-outie/`) and instruct each persona's SOUL file to only reference its own.

## See Also

- [Hooks](/automation/hooks)
- [SOUL Evil Hook](/hooks/soul-evil)
