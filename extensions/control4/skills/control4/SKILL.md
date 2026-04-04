---
name: control4
description: Use Control4 tools to control home automation devices — lights, thermostats, locks, and more — via natural language.
---

When the user asks to control their home (lights, thermostat, locks, scenes, etc.), use the Control4 tools in this order:

1. **control4_find** — Find the device(s) by name, room, or type. Pass the user's description as `query`. Optionally narrow by `roomName` or `deviceType`. Returns device IDs.

2. **control4_command** — Send a command to the device IDs returned by control4_find.
   - Lights on/off: command `ON` or `OFF`
   - Dim a light: command `RAMP_TO_LEVEL` with `params.LEVEL` = "0"–"100"
   - Set brightness: command `SET_SCALE` with `params.SCALE` = "0"–"100"
   - Thermostat mode: command `SET_HVAC_MODE` with `params.MODE` = `"COOL"` | `"HEAT"` | `"AUTO"` | `"OFF"`

3. **control4_status** — Query current state of a device (light level, temperature reading, lock state).

Room IDs and names are injected into system context — use them to pre-filter control4_find when the user mentions a specific room.

Always chain find → command for natural language requests. Do not guess device IDs.
