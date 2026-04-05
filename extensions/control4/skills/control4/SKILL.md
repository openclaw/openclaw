---
name: control4
description: Use Control4 tools to control home automation devices — lights, thermostats, locks, audio, and more — via natural language.
---

## Key principle
Your system context already lists every room and its device IDs. **Use those IDs directly** in `control4_command` — you do not need to call `control4_find` first for lights, thermostats, locks, or audio in named rooms.

## Room + device inventory
The system prompt includes a full map like:
```
[42] Kitchen
  Lights: Wireless Dimmer[43], Cans dining room side[44], Kitchen Sink[46], ...
  Audio sources: [946] Pandora, [947] AirPlay (send audio commands to room [42])
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

**Play AirPlay in the kitchen** — do this:
1. Read audio sources from context: [947] AirPlay, room ID 42
2. Call `control4_command(deviceIds=[42], command="SELECT_AUDIO_DEVICE", params={deviceid:"947"})`

**Play Pandora in the living room** — do this:
1. Read audio sources from context: [946] Pandora, room ID (e.g. 55)
2. Call `control4_command(deviceIds=[55], command="SELECT_AUDIO_DEVICE", params={deviceid:"946"})`
3. Then `control4_command(deviceIds=[55], command="PLAY")` if needed

**Volume up in kitchen** — do this:
1. Room ID 42
2. Call `control4_command(deviceIds=[42], command="SET_VOLUME_LEVEL", params={LEVEL:"60"})`

**Set thermostat to 72°F heat** — do this:
1. Thermostat ID from context (e.g. 652)
2. Call `control4_command(deviceIds=[652], command="SET_SETPOINT_HEAT", params={FAHRENHEIT:"72"})`

**Only use `control4_find`** when:
- The user mentions a specific device by an ambiguous name not in the context
- You need to search by manufacturer, model, or a non-obvious attribute

## Commands reference

### Lights
| Action | command | params |
|---|---|---|
| Turn on/off | `ON` or `OFF` | — |
| Dim to level | `RAMP_TO_LEVEL` | `{LEVEL: "0"–"100"}` |
| Set brightness | `SET_SCALE` | `{SCALE: "0"–"100"}` |

### Thermostat
| Action | command | params |
|---|---|---|
| Set operating mode | `SET_HVAC_MODE` | `{MODE: "COOL"\|"HEAT"\|"AUTO"\|"OFF"}` |
| Set heat target | `SET_SETPOINT_HEAT` | `{FAHRENHEIT: "72"}` |
| Set cool target | `SET_SETPOINT_COOL` | `{FAHRENHEIT: "78"}` |

### Audio (send all audio commands to the **room ID**, not a device ID)
| Action | command | params |
|---|---|---|
| Select source | `SELECT_AUDIO_DEVICE` | `{deviceid: "<source_id>"}` |
| Play | `PLAY` | — |
| Pause | `PAUSE` | — |
| Stop | `STOP` | — |
| Next track | `SKIP FWD` | — |
| Previous track | `SKIP REV` | — |
| Set volume | `SET_VOLUME_LEVEL` | `{LEVEL: "0"–"100"}` |
| Mute on/off | `MUTE_ON` / `MUTE_OFF` | — |
| Power off | `DISCONNECT` | — |

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

## Audio source notes
- Audio sources are listed per-room in the system prompt under "Audio sources: [id] Name, ..."
- The source IDs (e.g. 946 for Pandora, 947 for AirPlay) are passed to `SELECT_AUDIO_DEVICE`
- All audio commands (`PLAY`, `PAUSE`, `SET_VOLUME_LEVEL`, etc.) go to the **room ID**, not the source ID
- AirPlay: the user streams from their phone to the Control4 ShairBridge — WhatsApp selects the routing
- After `SELECT_AUDIO_DEVICE`, send `PLAY` if playback doesn't start automatically

## Notes
- "Wireless Dimmer" entries are individual dimmer circuits — send to all in a room to control all lights.
- Thermostat IDs: Lower Floor [306], Main [652], Library [649/650], Upper [650].
- Treehouse locks: Front Door [920], Back Door [921].
