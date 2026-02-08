---
name: home-assistant
description: Control Home Assistant smart home devices, run automations, and receive webhook events. Use when controlling lights, switches, climate, scenes, scripts, or any HA entity. Supports bidirectional communication via REST API (outbound) and webhooks (inbound triggers from HA automations).
metadata: {"clawdbot":{"emoji":"🏠","requires":{"bins":["jq","curl"]}}}
---

# Home Assistant

Control your smart home via Home Assistant's REST API and webhooks.

## Setup

### Option 1: Config File (Recommended)

Create `~/.config/home-assistant/config.json`:
```json
{
  "url": "https://your-ha-instance.duckdns.org",
  "token": "your-long-lived-access-token"
}
```

### Option 2: Environment Variables

```bash
export HA_URL="http://homeassistant.local:8123"
export HA_TOKEN="your-long-lived-access-token"
```

### Getting a Long-Lived Access Token

1. Open Home Assistant → Profile (bottom left)
2. Scroll to "Long-Lived Access Tokens"
3. Click "Create Token", name it (e.g., "Clawdbot")
4. Copy the token immediately (shown only once)

## Quick Reference

### List Entities

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states" | jq '.[].entity_id'
```

### Get Entity State

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states/light.living_room"
```

### Control Devices

```bash
# Turn on
curl -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  "$HA_URL/api/services/light/turn_on" -d '{"entity_id": "light.living_room"}'

# Turn off
curl -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  "$HA_URL/api/services/light/turn_off" -d '{"entity_id": "light.living_room"}'

# Set brightness (0-255)
curl -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  "$HA_URL/api/services/light/turn_on" -d '{"entity_id": "light.living_room", "brightness": 128}'
```

### Run Scripts & Automations

```bash
# Trigger script
curl -X POST -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/services/script/turn_on" \
  -H "Content-Type: application/json" -d '{"entity_id": "script.goodnight"}'

# Trigger automation
curl -X POST -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/services/automation/trigger" \
  -H "Content-Type: application/json" -d '{"entity_id": "automation.motion_lights"}'
```

### Activate Scenes

```bash
curl -X POST -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/services/scene/turn_on" \
  -H "Content-Type: application/json" -d '{"entity_id": "scene.movie_night"}'
```

## Common Services

| Domain | Service | Example entity_id |
|--------|---------|-------------------|
| `light` | `turn_on`, `turn_off`, `toggle` | `light.kitchen` |
| `switch` | `turn_on`, `turn_off`, `toggle` | `switch.fan` |
| `climate` | `set_temperature`, `set_hvac_mode` | `climate.thermostat` |
| `cover` | `open_cover`, `close_cover`, `stop_cover` | `cover.garage` |
| `media_player` | `play_media`, `media_pause`, `volume_set` | `media_player.tv` |
| `scene` | `turn_on` | `scene.relax` |
| `script` | `turn_on` | `script.welcome_home` |
| `automation` | `trigger`, `turn_on`, `turn_off` | `automation.sunrise` |

## Inbound Webhooks (HA → Clawdbot)

To receive events from Home Assistant automations:

### 1. Create HA Automation with Webhook Action

```yaml
# In HA automation
action:
  - service: rest_command.notify_clawdbot
    data:
      event: motion_detected
      area: living_room
```

### 2. Define REST Command in HA

```yaml
# configuration.yaml
rest_command:
  notify_clawdbot:
    url: "https://your-clawdbot-url/webhook/home-assistant"
    method: POST
    headers:
      Authorization: "Bearer {{ webhook_secret }}"
      Content-Type: "application/json"
    payload: '{"event": "{{ event }}", "area": "{{ area }}"}'
```

### 3. Handle in Clawdbot

Clawdbot receives the webhook and can notify you or take action based on the event.

## CLI Wrapper

The `scripts/ha.sh` CLI provides easy access to all HA functions:

```bash
# Test connection
ha.sh info

# List entities
ha.sh list all          # all entities
ha.sh list lights       # just lights
ha.sh list switch       # just switches

# Search entities
ha.sh search kitchen    # find entities by name

# Get/set state
ha.sh state light.living_room
ha.sh states light.living_room   # full details with attributes
ha.sh on light.living_room
ha.sh on light.living_room 200   # with brightness (0-255)
ha.sh off light.living_room
ha.sh toggle switch.fan

# Scenes & scripts
ha.sh scene movie_night
ha.sh script goodnight

# Climate
ha.sh climate climate.thermostat 22

# Call any service
ha.sh call light turn_on '{"entity_id":"light.room","brightness":200}'
```

## Troubleshooting

- **401 Unauthorized**: Token expired or invalid. Generate a new one.
- **Connection refused**: Check HA_URL, ensure HA is running and accessible.
- **Entity not found**: List entities to find the correct entity_id.

## API Reference

For advanced usage, see [references/api.md](references/api.md).
