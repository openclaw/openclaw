#!/usr/bin/env bash
# Generate docker-compose.generated.yml from instance directories.
#
# Scans ~/.openclaw-instances/ for Discord user ID directories and generates
# a compose file with one service per instance. The base template comes from
# docker-compose.instances.yml (anchors, healthcheck, shared env).
#
# Usage:
#   scripts/instance-compose.sh                         # generate + print path
#   scripts/instance-compose.sh --up                    # generate + docker compose up -d
#   scripts/instance-compose.sh --up <discord-user-id>  # generate + start single instance
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTANCES_DIR="${OPENCLAW_INSTANCES_DIR:-$HOME/.openclaw-instances}"
OUTPUT="$REPO_DIR/docker-compose.generated.yml"
BASE_PORT=18789
DISCORD_ID_RE='^[0-9]{17,20}$'

if [ ! -d "$INSTANCES_DIR" ]; then
  echo "Error: instances directory not found: $INSTANCES_DIR" >&2
  exit 1
fi

# Start with the base template (anchors + shared config)
cat "$REPO_DIR/docker-compose.instances.yml" > "$OUTPUT"

# Remove the empty services block — we'll write our own
# The base file ends with "services: {}"
sed -i 's/^services: {}$/services:/' "$OUTPUT"

# Scan for instance directories
PORT_OFFSET=0
for dir in "$INSTANCES_DIR"/*/; do
  [ -d "$dir" ] || continue
  DISCORD_USER_ID="$(basename "$dir")"
  # Skip non-Discord-ID directories (shared, etc.)
  if [[ ! "$DISCORD_USER_ID" =~ $DISCORD_ID_RE ]]; then
    continue
  fi

  HOST_PORT=$((BASE_PORT + PORT_OFFSET * 2))

  # Check for per-instance TZ override
  TZ_LINE=""
  if [ -f "$dir/tz" ]; then
    TZ_VAL="$(cat "$dir/tz" | tr -d '[:space:]')"
    if [ -n "$TZ_VAL" ]; then
      TZ_LINE="      TZ: $TZ_VAL"
    fi
  fi

  cat >> "$OUTPUT" <<EOF
  openclaw-${DISCORD_USER_ID}:
    <<: *openclaw-base
    container_name: openclaw-${DISCORD_USER_ID}
    environment:
      <<: *openclaw-env
${TZ_LINE:+$TZ_LINE
}      OPENCLAW_GATEWAY_PORT: "18789"
      GOG_KEYRING_PASSWORD: \${OPENCLAW_${DISCORD_USER_ID}_GOG_PASSWORD:-openclaw}
    volumes:
      - \${OPENCLAW_INSTANCES_DIR:-~/.openclaw-instances}/${DISCORD_USER_ID}:/home/node/.openclaw
      - \${OPENCLAW_INSTANCES_DIR:-~/.openclaw-instances}/${DISCORD_USER_ID}/workspace:/home/node/.openclaw/workspace
      - \${OPENCLAW_INSTANCES_DIR:-~/.openclaw-instances}/${DISCORD_USER_ID}/gogcli:/home/node/.config/gogcli
      - \${OPENCLAW_INSTANCES_DIR:-~/.openclaw-instances}/shared/auth/auth-profiles.json:/home/node/.openclaw/agents/main/agent/auth-profiles.json
    ports:
      - "\${OPENCLAW_${DISCORD_USER_ID}_PORT:-${HOST_PORT}}:18789"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "\${OPENCLAW_GATEWAY_BIND:-lan}",
        "--port",
        "18789",
      ]

EOF

  PORT_OFFSET=$((PORT_OFFSET + 1))
done

echo "Generated $OUTPUT with $PORT_OFFSET instance(s)"

# Optional: run docker compose up
if [ "${1:-}" = "--up" ]; then
  shift
  if [ $# -gt 0 ]; then
    echo "Starting openclaw-$1..."
    docker compose -f "$OUTPUT" up -d "openclaw-$1"
  else
    echo "Starting all instances..."
    docker compose -f "$OUTPUT" up -d
  fi
fi
