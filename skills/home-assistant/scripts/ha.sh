#!/usr/bin/env bash
# Home Assistant CLI wrapper
# Usage: ha.sh <command> [args...]

set -euo pipefail

CONFIG_FILE="${HA_CONFIG:-$HOME/.config/home-assistant/config.json}"

# Load config
if [[ -f "$CONFIG_FILE" ]]; then
  HA_URL="${HA_URL:-$(jq -r '.url // empty' "$CONFIG_FILE")}"
  HA_TOKEN="${HA_TOKEN:-$(jq -r '.token // empty' "$CONFIG_FILE")}"
fi

: "${HA_URL:?Set HA_URL or configure $CONFIG_FILE}"
: "${HA_TOKEN:?Set HA_TOKEN or configure $CONFIG_FILE}"

cmd="${1:-help}"
shift || true

api() {
  curl -s -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" "$@"
}

case "$cmd" in
  state|get)
    # Get entity state: ha.sh state light.living_room
    entity="${1:?Usage: ha.sh state <entity_id>}"
    api "$HA_URL/api/states/$entity" | jq -r '.state // "unknown"'
    ;;
    
  states)
    # Get full entity state with attributes
    entity="${1:?Usage: ha.sh states <entity_id>}"
    api "$HA_URL/api/states/$entity" | jq
    ;;

  on|turn_on)
    # Turn on entity: ha.sh on light.living_room [brightness]
    entity="${1:?Usage: ha.sh on <entity_id> [brightness]}"
    domain="${entity%%.*}"
    brightness="${2:-}"
    if [[ -n "$brightness" ]]; then
      api -X POST "$HA_URL/api/services/$domain/turn_on" \
        -d "{\"entity_id\": \"$entity\", \"brightness\": $brightness}"
    else
      api -X POST "$HA_URL/api/services/$domain/turn_on" \
        -d "{\"entity_id\": \"$entity\"}"
    fi
    echo "✓ $entity turned on"
    ;;

  off|turn_off)
    # Turn off entity: ha.sh off light.living_room
    entity="${1:?Usage: ha.sh off <entity_id>}"
    domain="${entity%%.*}"
    api -X POST "$HA_URL/api/services/$domain/turn_off" \
      -d "{\"entity_id\": \"$entity\"}" >/dev/null
    echo "✓ $entity turned off"
    ;;

  toggle)
    # Toggle entity: ha.sh toggle switch.fan
    entity="${1:?Usage: ha.sh toggle <entity_id>}"
    domain="${entity%%.*}"
    api -X POST "$HA_URL/api/services/$domain/toggle" \
      -d "{\"entity_id\": \"$entity\"}" >/dev/null
    echo "✓ $entity toggled"
    ;;

  scene)
    # Activate scene: ha.sh scene movie_night
    scene="${1:?Usage: ha.sh scene <scene_name>}"
    [[ "$scene" == scene.* ]] || scene="scene.$scene"
    api -X POST "$HA_URL/api/services/scene/turn_on" \
      -d "{\"entity_id\": \"$scene\"}" >/dev/null
    echo "✓ Scene $scene activated"
    ;;

  script)
    # Run script: ha.sh script goodnight
    script="${1:?Usage: ha.sh script <script_name>}"
    [[ "$script" == script.* ]] || script="script.$script"
    api -X POST "$HA_URL/api/services/script/turn_on" \
      -d "{\"entity_id\": \"$script\"}" >/dev/null
    echo "✓ Script $script executed"
    ;;

  automation|trigger)
    # Trigger automation: ha.sh automation motion_lights
    auto="${1:?Usage: ha.sh automation <automation_name>}"
    [[ "$auto" == automation.* ]] || auto="automation.$auto"
    api -X POST "$HA_URL/api/services/automation/trigger" \
      -d "{\"entity_id\": \"$auto\"}" >/dev/null
    echo "✓ Automation $auto triggered"
    ;;

  climate|temp)
    # Set temperature: ha.sh climate climate.thermostat 22
    entity="${1:?Usage: ha.sh climate <entity_id> <temperature>}"
    temp="${2:?Usage: ha.sh climate <entity_id> <temperature>}"
    api -X POST "$HA_URL/api/services/climate/set_temperature" \
      -d "{\"entity_id\": \"$entity\", \"temperature\": $temp}" >/dev/null
    echo "✓ $entity set to ${temp}°"
    ;;

  list)
    # List entities by domain: ha.sh list lights / ha.sh list all
    filter="${1:-all}"
    if [[ "$filter" == "all" ]]; then
      api "$HA_URL/api/states" | jq -r '.[].entity_id' | sort
    else
      # Normalize: "lights" -> "light", "switches" -> "switch"
      filter="${filter%s}"
      api "$HA_URL/api/states" | jq -r --arg d "$filter" \
        '.[] | select(.entity_id | startswith($d + ".")) | .entity_id' | sort
    fi
    ;;

  search)
    # Search entities: ha.sh search kitchen
    pattern="${1:?Usage: ha.sh search <pattern>}"
    api "$HA_URL/api/states" | jq -r --arg p "$pattern" \
      '.[] | select(.entity_id | test($p; "i")) | "\(.entity_id): \(.state)"'
    ;;

  call)
    # Call any service: ha.sh call light turn_on '{"entity_id":"light.room","brightness":200}'
    domain="${1:?Usage: ha.sh call <domain> <service> [json_data]}"
    service="${2:?Usage: ha.sh call <domain> <service> [json_data]}"
    data="${3:-{}}"
    api -X POST "$HA_URL/api/services/$domain/$service" -d "$data"
    ;;

  info)
    # Get HA instance info
    api "$HA_URL/api/" | jq
    ;;

  help|*)
    cat <<EOF
Home Assistant CLI

Usage: ha.sh <command> [args...]

Commands:
  state <entity>              Get entity state
  states <entity>             Get full entity state with attributes
  on <entity> [brightness]    Turn on (optional brightness 0-255)
  off <entity>                Turn off
  toggle <entity>             Toggle on/off
  scene <name>                Activate scene
  script <name>               Run script
  automation <name>           Trigger automation
  climate <entity> <temp>     Set temperature
  list [domain]               List entities (lights, switches, all)
  search <pattern>            Search entities by name
  call <domain> <svc> [json]  Call any service
  info                        Get HA instance info

Environment:
  HA_URL    Home Assistant URL (required)
  HA_TOKEN  Long-lived access token (required)

Examples:
  ha.sh on light.living_room 200
  ha.sh scene movie_night
  ha.sh list lights
  ha.sh search kitchen
EOF
    ;;
esac
