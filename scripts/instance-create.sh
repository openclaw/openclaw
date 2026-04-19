#!/usr/bin/env bash
# Create a new OpenClaw Docker instance for a Discord user.
#
# Usage: ./scripts/instance-create.sh <discord-user-id>
#
# Creates the instance directory, generates a config, and prints
# the docker-compose service block to add to docker-compose.instances.yml.
set -euo pipefail

DISCORD_USER_ID="${1:-}"
if [[ ! "$DISCORD_USER_ID" =~ ^[0-9]{17,20}$ ]]; then
  echo "Usage: $0 <discord-user-id>"
  echo "  Discord user ID must be a 17-20 digit number."
  exit 1
fi

INSTANCES_DIR="${OPENCLAW_INSTANCES_DIR:-$HOME/.openclaw-instances}"
INSTANCE_DIR="$INSTANCES_DIR/$DISCORD_USER_ID"

if [ -d "$INSTANCE_DIR" ]; then
  echo "Instance directory already exists: $INSTANCE_DIR"
  exit 1
fi

# Generate gateway token
GATEWAY_TOKEN=$(openssl rand -hex 24 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(24))")

# Copy shared auth profiles
SHARED_AUTH="$INSTANCES_DIR/shared/auth/auth-profiles.json"
if [ ! -f "$SHARED_AUTH" ]; then
  echo "Error: shared auth not found at $SHARED_AUTH"
  echo "Create it first from an existing instance."
  exit 1
fi

# Read Discord bot token from any existing instance
DISCORD_TOKEN=""
for dir in "$INSTANCES_DIR"/[0-9]*; do
  [ -d "$dir" ] || continue
  if [ -f "$dir/openclaw.json" ]; then
    DISCORD_TOKEN=$(python3 -c "import json; d=json.load(open('$dir/openclaw.json')); print(d.get('channels',{}).get('discord',{}).get('token',''))" 2>/dev/null || true)
    if [ -n "$DISCORD_TOKEN" ]; then
      break
    fi
  fi
done

if [ -z "$DISCORD_TOKEN" ]; then
  echo "Error: could not find Discord bot token from existing instances"
  exit 1
fi

# Create instance directory structure
mkdir -p "$INSTANCE_DIR/workspace"
mkdir -p "$INSTANCE_DIR/agents/main/agent"
mkdir -p "$INSTANCE_DIR/agents/main/sessions"
mkdir -p "$INSTANCE_DIR/memory/models"

# Write config
python3 -c "
import json

cfg = {
    'meta': {
        'lastTouchedVersion': '2026.2.4',
    },
    'auth': {
        'profiles': {
            'anthropic:default': {
                'provider': 'anthropic',
                'mode': 'api_key'
            }
        }
    },
    'agents': {
        'defaults': {
            'model': {
                'primary': 'anthropic-subscription/claude-sonnet-4-6'
            },
            'workspace': '/home/node/.openclaw/workspace',
            'compaction': {
                'mode': 'safeguard',
                'maxHistoryShare': 0.3
            },
            'heartbeat': {
                'every': '30m',
                'activeHours': {
                    'start': '06:00',
                    'end': '23:00',
                    'timezone': 'local'
                },
                'target': 'last'
            },
            'timeoutSeconds': 1800,
            'maxConcurrent': 4,
            'memorySearch': {
                'provider': 'local',
                'local': {
                    'modelCacheDir': '/home/node/.openclaw/memory/models'
                }
            }
        }
    },
    'tools': {
        'exec': {
            'security': 'full',
            'ask': 'off'
        }
    },
    'messages': {
        'queue': {'mode': 'steer'},
    },
    'commands': {
        'native': False,
        'nativeSkills': 'auto',
        'restart': True
    },
    'hooks': {
        'internal': {
            'enabled': True,
            'entries': {
                'boot-md': {'enabled': True},
                'session-memory': {'enabled': True}
            }
        }
    },
    'channels': {
        'discord': {
            'enabled': True,
            'token': '$DISCORD_TOKEN',
            'proxyUrl': 'http://host.docker.internal:18800',
            'dm': {
                'policy': 'allowlist',
                'allowFrom': ['$DISCORD_USER_ID']
            },
            'groupPolicy': 'allowlist'
        }
    },
    'gateway': {
        'port': 18789,
        'mode': 'local',
        'bind': 'loopback',
        'auth': {
            'mode': 'token',
            'token': '$GATEWAY_TOKEN'
        }
    },
    'models': {
        'providers': {
            'anthropic-subscription': {
                'baseUrl': 'https://api.anthropic.com',
                'api': 'anthropic-messages',
                'auth': 'api-key',
                'headers': {
                    'anthropic-beta': 'oauth-2025-04-20'
                },
                'models': [
                    {
                        'id': 'claude-sonnet-4-6',
                        'name': 'Claude Sonnet 4.6',
                        'reasoning': False,
                        'input': ['text', 'image'],
                        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
                        'contextWindow': 200000,
                        'maxTokens': 64000
                    }
                ]
            }
        }
    }
}

with open('$INSTANCE_DIR/openclaw.json', 'w') as f:
    json.dump(cfg, f, indent=2)
"

# Count existing instances to compute port offset
EXISTING=$(ls -d "$INSTANCES_DIR"/[0-9]* 2>/dev/null | wc -l)
HOST_PORT=$((18789 + (EXISTING - 1) * 2))

echo ""
echo "Instance created: $INSTANCE_DIR"
echo "  Discord user ID: $DISCORD_USER_ID"
echo "  Gateway token:   $GATEWAY_TOKEN"
echo "  Host port:       $HOST_PORT"
echo ""
echo "Run 'scripts/instance-compose.sh' to regenerate the compose file."
echo "Then 'scripts/instance-compose.sh --up $DISCORD_USER_ID' to start the container."
