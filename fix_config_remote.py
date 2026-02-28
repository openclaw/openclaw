#!/usr/bin/env python3
import json
import sys

f = '/docker/openclaw-sgnl/data/.openclaw/openclaw.json'

# Load config
try:
    c = json.load(open(f))
except Exception as e:
    print(f"ERROR loading config: {e}", file=sys.stderr)
    sys.exit(1)

# Fix 1: Change whatsapp.dmPolicy from "allowlist" to "pairing"
if 'channels' in c and 'whatsapp' in c['channels']:
    if c['channels']['whatsapp'].get('dmPolicy') == 'allowlist':
        c['channels']['whatsapp']['dmPolicy'] = 'pairing'
        print("✓ Fixed channels.whatsapp.dmPolicy: allowlist → pairing")

# Fix 2: Rename telegram.streamMode to telegram.streaming
if 'channels' in c and 'telegram' in c['channels']:
    if 'streamMode' in c['channels']['telegram']:
        c['channels']['telegram']['streaming'] = c['channels']['telegram'].pop('streamMode')
        print("✓ Renamed channels.telegram.streamMode → streaming")

# Write back
try:
    json.dump(c, open(f, 'w'), indent=2)
    print("✓ Config written successfully")
except Exception as e:
    print(f"ERROR writing config: {e}", file=sys.stderr)
    sys.exit(1)
