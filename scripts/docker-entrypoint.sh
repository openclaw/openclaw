#!/bin/sh
set -e

# Config lives in OPENCLAW_STATE_DIR/openclaw.json or $HOME/.openclaw/openclaw.json
CONFIG_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
DEFAULT_CONFIG="/app/openclaw.json"

mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_FILE" ] && [ -f "$DEFAULT_CONFIG" ]; then
  cp "$DEFAULT_CONFIG" "$CONFIG_FILE"
  echo "Seeded config from $DEFAULT_CONFIG to $CONFIG_FILE"
fi

# Workspace seeding: copy defaults on first boot, update client context every boot
WORKSPACE="$HOME/.openclaw/workspace"
mkdir -p "$WORKSPACE"

# First boot: copy defaults to persistent volume
if [ ! -f "$WORKSPACE/SOUL.md" ]; then
  echo "First boot: seeding workspace from defaults..."
  cp -r /opt/openbea/workspace-defaults/* "$WORKSPACE/"
fi

# Always update USER.md client context (safe substitution via Python to handle
# special characters in company names like "Acme A/S" or "Foo & Bar")
python3 -c "
import os, re
user_md = os.path.join('$WORKSPACE', 'USER.md')
if not os.path.exists(user_md):
    exit(0)
text = open(user_md).read()
name = os.environ.get('CLIENT_NAME', '')
desc = os.environ.get('CLIENT_DESCRIPTION', '')
# First boot: replace template placeholders
text = text.replace('\${CLIENT_NAME}', name)
text = text.replace('\${CLIENT_DESCRIPTION}', desc)
# Subsequent boots: update existing values
text = re.sub(r'^- \*\*Company:\*\*.*$', f'- **Company:** {name}', text, flags=re.MULTILINE)
text = re.sub(r'^- \*\*Description:\*\*.*$', f'- **Description:** {desc}', text, flags=re.MULTILINE)
open(user_md, 'w').write(text)
"

# Apply pending config changes (e.g. enable Slack channel) before starting
node /app/openclaw.mjs doctor --fix 2>&1 || true

exec "$@"
