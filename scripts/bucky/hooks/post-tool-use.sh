#!/bin/bash
# Claude Code PostToolUse hook
# Writes /tmp/bucky-tool-state.json with latest tool call info.
# On Bash errors: sends immediate WhatsApp alert to Dirgh via Bucky.

BUCKY_URL="http://136.116.235.101:18789/tools/invoke"
BUCKY_TOKEN="2e68882441704870478964ba85aa3b4b9e1d3af502465cdc"
WHATSAPP_TO="+918200557253"
STATE_FILE="/tmp/bucky-tool-state.json"

INPUT=$(cat)

# Single Python invocation: extract all fields, write state file atomically,
# and build curl payload (only on detected Bash error). All JSON built in Python
# so no user-controlled content is interpolated in shell strings.
CURL_PAYLOAD=$(echo "$INPUT" | python3 -c "
import sys, json, time, os

state_file = sys.argv[1]
wa_to      = sys.argv[2]

raw = sys.stdin.read(4 * 1024 * 1024)  # cap at 4 MB
try:
    d = json.loads(raw)
except Exception:
    sys.exit(0)

tool_name  = d.get('tool_name', '')
tool_input = d.get('tool_input', {})
resp       = d.get('tool_response', {})
if isinstance(resp, dict):
    output = resp.get('output', '')[:4096]
elif isinstance(resp, str):
    output = resp[:4096]
else:
    output = ''

# Atomic state file write
state = {'tool_name': tool_name, 'tool_input': tool_input, 'ts': time.time()}
try:
    tmp = state_file + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, state_file)
except Exception:
    pass

# Only alert on Bash errors
if tool_name != 'Bash':
    sys.exit(0)

error_signals = [
    'error:', 'exit code', 'command not found', 'enoent',
    'permission denied', 'failed', 'traceback', 'exception',
    'npm err!', 'syntax error', 'typeerror', 'referenceerror',
]
lower = output.lower()
if not any(sig in lower for sig in error_signals):
    sys.exit(0)

cmd = tool_input.get('command', '')[:100]
lines = output.strip().split('\n')
error_line = next(
    (l for l in lines if any(x in l.lower() for x in ['error', 'failed', 'exception', 'traceback'])),
    lines[-1] if lines else 'unknown error',
)[:150]

msg = f'[Claude Code error]\nCommand: {cmd}\n{error_line}'
payload = {
    'tool': 'message',
    'action': 'send',
    'args': {'action': 'send', 'target': wa_to, 'message': msg},
}
print(json.dumps(payload))
" "$STATE_FILE" "$WHATSAPP_TO" 2>/dev/null)

# Fire curl only when Python produced a payload (detected error)
if [ -n "$CURL_PAYLOAD" ]; then
  curl -s -X POST "$BUCKY_URL" \
    -H "Authorization: Bearer $BUCKY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$CURL_PAYLOAD" \
    --connect-timeout 5 --silent &
fi

exit 0
