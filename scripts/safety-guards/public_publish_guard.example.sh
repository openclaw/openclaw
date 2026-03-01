#!/usr/bin/env bash
set -euo pipefail
# Publish redaction (template)
FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Usage: $0 <input_file>" >&2; exit 2; }

STRICT_MODE="${PUBLIC_PUBLISH_STRICT:-0}"
OUTPUT=

tmp=$(python3 - "$FILE" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
s = path.read_text(errors='ignore')
patterns = [
    (r"\bgh[oopu]_[A-Za-z0-9_]{20,}\b", "[TOKEN_REDACTED]"),
    (r"\bsk-[A-Za-z0-9]{20,}\b", "[OPENAI_KEY_REDACTED]"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", "[SLACK_TOKEN_REDACTED]"),
    (r"\bAKIA[0-9A-Z]{16}\b", "[AWS_KEY_REDACTED]"),
]

total = 0
for p, _r in patterns:
    total += len(re.findall(p, s))

for p, r in patterns:
    s = re.sub(p, r, s)

print(total)
print(s)
PY
)
REDACT_COUNT=$(printf '%s' "$tmp" | sed -n '1p')
SANITIZED=$(printf '%s' "$tmp" | sed -n '2p')

if [ -z "$SANITIZED" ]; then
  echo "$tmp"
  printf 'replaced=0\n' >&2
  exit 0
fi

printf '%s\n' "$SANITIZED"
printf 'replaced=%s\n' "$REDACT_COUNT" >&2

if [ "$STRICT_MODE" = "1" ] && [ "$REDACT_COUNT" -gt 0 ]; then
  echo "BLOCK: secrets detected by strict redaction mode" >&2
  exit 2
fi
