#!/bin/bash
# Claude Code PostToolUse hook
# Writes /tmp/bucky-tool-state.json with latest tool call info.
# On Bash errors: sends immediate WhatsApp alert to Dirgh via Bucky.

BUCKY_URL="http://136.116.235.101:18789/tools/invoke"
BUCKY_TOKEN="2e68882441704870478964ba85aa3b4b9e1d3af502465cdc"
WHATSAPP_TO="+918200557253"
STATE_FILE="/tmp/bucky-tool-state.json"

INPUT=$(cat)

# Extract fields
TOOL_NAME=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('tool_name', ''))
" 2>/dev/null)

TOOL_OUTPUT=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
resp = d.get('tool_response', {})
if isinstance(resp, dict):
    print(resp.get('output', ''))
elif isinstance(resp, str):
    print(resp[:500])
" 2>/dev/null)

TOOL_INPUT_CMD=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
cmd = d.get('tool_input', {}).get('command', '')
print(cmd[:100])
" 2>/dev/null)

# Write state file (bucky-bridge reads this on next tick)
echo "$INPUT" | python3 -c "
import sys, json, time, os
d = json.load(sys.stdin)
state = {
  'tool_name': d.get('tool_name', ''),
  'tool_input': d.get('tool_input', {}),
  'ts': time.time(),
}
with open('$STATE_FILE', 'w') as f:
    json.dump(state, f)
" 2>/dev/null

# Only alert for Bash errors — check for error patterns in output
if [ "$TOOL_NAME" = "Bash" ]; then
  IS_ERROR=$(echo "$TOOL_OUTPUT" | python3 -c "
import sys
output = sys.stdin.read().lower()
error_signals = ['error:', 'exit code', 'command not found', 'enoent',
                 'permission denied', 'failed', 'traceback', 'exception',
                 'npm err!', 'syntax error', 'typeerror', 'referenceerror']
for sig in error_signals:
    if sig in output:
        print('yes')
        break
else:
    print('no')
" 2>/dev/null)

  if [ "$IS_ERROR" = "yes" ]; then
    ERROR_SUMMARY=$(echo "$TOOL_OUTPUT" | python3 -c "
import sys
lines = sys.stdin.read().strip().split('\n')
# Find first error line
for line in lines:
    if any(x in line.lower() for x in ['error', 'failed', 'exception', 'traceback']):
        print(line[:150])
        break
else:
    print(lines[-1][:150] if lines else 'unknown error')
" 2>/dev/null)

    MSG="[Claude Code error]
Command: ${TOOL_INPUT_CMD}
${ERROR_SUMMARY}"

    MSG_ESCAPED=$(echo "$MSG" | python3 -c "
import sys, json
print(json.dumps(sys.stdin.read())[1:-1])
" 2>/dev/null)

    curl -s -X POST "$BUCKY_URL" \
      -H "Authorization: Bearer $BUCKY_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"tool\":\"message\",\"action\":\"send\",\"args\":{\"action\":\"send\",\"target\":\"$WHATSAPP_TO\",\"message\":\"$MSG_ESCAPED\"}}" \
      --connect-timeout 5 --silent &
  fi
fi

exit 0
