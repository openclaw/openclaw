---
name: control4
description: Use Control4 tools to control home automation devices — lights, thermostats, locks, and more — via natural language.
---

## Key principle
Your system context already lists every room and its device IDs. **Use those IDs directly** in `control4_command` — you do not need to call `control4_find` first for lights, thermostats, or locks in named rooms.

## Room + device inventory
The system prompt includes a full map like:
```
[42] Kitchen
  Lights: Wireless Dimmer[43], Cans dining room side[44], Kitchen Sink[46], ...
```

When the user asks to control a named room, extract the device IDs from the map and call `control4_command` immediately.

## Workflow

**Turning off kitchen lights** — do this:
1. Read IDs from context: 43, 44, 45, 46, 47, 48, 49, 50, 53, 54, 61, 62
2. Call `control4_command(deviceIds=[43,44,45,...], command="OFF")`
— Do NOT call `control4_find` when you already have the IDs.

**Dimming living room** — do this:
1. Read IDs: 508, 509
2. Call `control4_command(deviceIds=[508,509], command="RAMP_TO_LEVEL", params={LEVEL:"50"})`

**Only use `control4_find`** when:
- The user mentions a specific device by an ambiguous name not in the context
- You need to search by manufacturer, model, or a non-obvious attribute

## Commands reference
| Action | command | params |
|---|---|---|
| Turn on/off | `ON` or `OFF` | — |
| Dim to level | `RAMP_TO_LEVEL` | `{LEVEL: "0"–"100"}` |
| Set brightness | `SET_SCALE` | `{SCALE: "0"–"100"}` |
| Thermostat mode | `SET_HVAC_MODE` | `{MODE: "COOL"\|"HEAT"\|"AUTO"\|"OFF"}` |

## Querying state
Use `control4_status(deviceIds=[...])` to read current light level, temperature, or lock state.

## Notes
- "Wireless Dimmer" entries are individual dimmer circuits — send to all in a room to control all lights.
- Thermostat IDs: Lower Floor [306], Main [652], Library [649/650], Upper [650].
- Treehouse locks: Front Door [920], Back Door [921].
