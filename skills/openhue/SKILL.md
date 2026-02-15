---
name: openhue
description: Control Philips Hue lights and scenes via the OpenHue CLI.
---

# OpenHue - Philips Hue Control

Control Blake's Philips Hue lights via the OpenHue CLI.

## When to Use

✅ **USE this skill when:**
- "Turn on/off the lights"
- "Dim the bedroom lights"
- "Set a scene" or "movie mode"
- Controlling specific rooms: Bedroom, KJS Office, Kitchen/Living
- Adjusting brightness, color, or color temperature

## When NOT to Use

❌ **DON'T use this skill when:**
- Non-Hue smart devices (other brands) → not supported
- HomeKit scenes or Shortcuts → use Apple's ecosystem
- TV or entertainment system control
- Thermostat or HVAC
- Smart plugs (unless Hue smart plugs)

## Blake's Hue Setup (8 lights, 3 rooms)

### Bedroom
- Behind bed (lightstrip)
- Bedroom lamp (floor shade)
- Katie Bed Side
- Blake Bed Side

### KJS Office
- KJS Desk Lamp (flexible)
- Book like strip first shelf (lightstrip)

### Kitchen/Living
- Mushroom Lamp (table shade)
- Downstairs big lamp (sultan bulb)

## Common Commands

### List Resources
```bash
openhue lights          # List all lights
openhue rooms           # List all rooms
openhue scenes          # List all scenes
```

### Control Lights
```bash
# Turn on/off
openhue light "Bedroom lamp" on
openhue light "Bedroom lamp" off

# Brightness (0-100)
openhue light "Bedroom lamp" --brightness 50

# Color temperature (warm to cool: 153-500 mirek)
openhue light "Bedroom lamp" --ct 300

# Color (by name or hex)
openhue light "Behind bed" --color red
openhue light "Behind bed" --color "#FF5500"
```

### Control Rooms
```bash
# Turn off entire room
openhue room "Bedroom" off

# Set room brightness
openhue room "Bedroom" --brightness 30
```

### Scenes
```bash
# Activate scene
openhue scene "Relax" --room "Bedroom"
openhue scene "Concentrate" --room "KJS Office"
```

## Quick Presets

```bash
# Bedtime (dim warm)
openhue room "Bedroom" --brightness 20 --ct 450

# Work mode (bright cool)
openhue room "KJS Office" --brightness 100 --ct 250

# Movie mode (dim)
openhue room "Kitchen/Living" --brightness 10
```

## Notes

- Bridge must be on local network
- First run requires button press on Hue bridge to pair
- Colors only work on color-capable bulbs (not white-only)
