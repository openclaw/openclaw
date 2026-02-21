#!/usr/bin/env bash
set -euo pipefail
# Publish redaction (template)
FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Usage: $0 <input_file>" >&2; exit 2; }

python3 - "$FILE" <<'PY'
import re, sys
from pathlib import Path
s = Path(sys.argv[1]).read_text(errors='ignore')
patterns = [
    (r"\bgh[oopu]_[A-Za-z0-9_]{20,}\b", "[TOKEN_REDACTED]"),
    (r"\bsk-[A-Za-z0-9]{20,}\b", "[OPENAI_KEY_REDACTED]"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", "[SLACK_TOKEN_REDACTED]"),
    (r"\bAKIA[0-9A-Z]{16}\b", "[AWS_KEY_REDACTED]"),
]
for p,r in patterns:
    s = re.sub(p,r,s)
print(s)
PY
