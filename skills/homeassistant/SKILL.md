---
name: homeassistant
description: Control Home Assistant - smart plugs, lights, scenes, automations.
---

# Home Assistant

Control smart home devices via Home Assistant API.

## Setup
- **HA_URL**: `http://192.168.4.84:8123`
- **HA_TOKEN**: Long-lived access token (saved in clawdis.json)

## Quick Commands

### List entities by domain
```bash
curl -s "$HA_URL/api/states" -H "Authorization: Bearer $HA_TOKEN" | \
  python3 -c "import sys,json; [print(s['entity_id']) for s in json.load(sys.stdin) if s['entity_id'].startswith('switch.')]"
```

### Turn on/off
```bash
# Turn on
curl -s -X POST "$HA_URL/api/services/switch/turn_on" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "switch.office_lamp"}'

# Turn off
curl -s -X POST "$HA_URL/api/services/switch/turn_off" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "switch.office_lamp"}'
```

### Trigger scene
```bash
curl -s -X POST "$HA_URL/api/services/scene/turn_on" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "scene.movie_time"}'
```

### Call any service
```bash
curl -s -X POST "$HA_URL/api/services/{domain}/{service}" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "...", ...}'
```

### Get entity state
```bash
curl -s "$HA_URL/api/states/{entity_id}" -H "Authorization: Bearer $HA_TOKEN"
```

## Entity Counts
- switches: 161 (smart plugs)
- lights: 47
- scenes: 71
- media_player: 62
- automations: 12
- sensors: 538

## Notes
- Use `switch.*` for smart plugs
- Use `light.*` for lights (Hue, etc.)
- Use `scene.*` for pre-configured scenes
- Use `automation.*` to trigger automations
