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

## Thermostat variable decoding
When `control4_status` returns thermostat variables, apply these rules:

**Human-readable (use as-is):**
- `TEMPERATURE_F`, `HEAT_SETPOINT_F`, `COOL_SETPOINT_F`, `OUTDOOR_TEMPERATURE_F` — already in °F
- `DISPLAY_TEMPERATURE` — current temp in °F
- `HVAC_MODE` — mode string (Heat / Cool / Auto / Off)
- `FAN_MODE`, `HOLD_STATE`, `SCHEDULE_MODE` — text values

**Deci-Kelvin (value > 2500 → convert to °F):**
- `HEAT_SETPOINT`, `COOL_SETPOINT`, `OUTDOOR_TEMPERATURE` with values like 2909, 2998
- Formula: `round((value/10 − 273.15) × 9/5 + 32)`
- Example: 2909 → 64°F, 2998 → 80°F, 2864 → 56°F, 3053 → 91°F

**Ignore (internal encodings with no reliable decode):**
- `TEMPERATURE` with value < 300 — opaque internal state, discard
- Any variable not listed above that has a small integer value

**Example thermostat status reply:**
> Main Thermostat: 64°F (current), heat set 64°F, cool set 80°F, mode: Heat

## Audio and music streaming

### Discovery
Use `control4_find` to locate audio devices before using commands:
- `control4_find(query: "audio zone media player")` — finds amplifiers and zone controllers
- `control4_find(query: "pandora airplay shairbridge")` — finds streaming source devices

### Audio commands reference
| Action | command | params |
|---|---|---|
| Play | `PLAY` | — |
| Pause | `PAUSE` | — |
| Stop | `STOP` | — |
| Next track | `SKIP FWD` | — |
| Previous track | `SKIP REV` | — |
| Set volume | `SET_VOLUME_LEVEL` | `{LEVEL: "0"–"100"}` |
| Mute on | `MUTE_ON` | — |
| Mute off | `MUTE_OFF` | — |
| Select input/source | `SELECT_SOURCE` | depends on device |

### AirPlay (ShairBridge)
- ShairBridge is a Control4 AirPlay receiver device — the user streams from their iPhone to it
- WhatsApp controls routing and volume; it does **not** trigger AirPlay streaming itself
- To route AirPlay to a room: find the room's audio zone/amplifier, then send `SELECT_SOURCE` selecting ShairBridge as input
- Example: "Play AirPlay in the living room" → find living room audio zone ID → `control4_command(deviceIds=[...], command="SELECT_SOURCE", params={...})`

### Pandora (Media Service Proxy / MSP driver)
- Find the Pandora or MSP device via `control4_find(query: "pandora")`
- Send `PLAY` to start the current station, `STOP` to stop, `SKIP FWD` to skip track
- Station selection may require inspecting device variables via `control4_status`

## Notes
- "Wireless Dimmer" entries are individual dimmer circuits — send to all in a room to control all lights.
- Thermostat IDs: Lower Floor [306], Main [652], Library [649/650], Upper [650].
- Treehouse locks: Front Door [920], Back Door [921].
