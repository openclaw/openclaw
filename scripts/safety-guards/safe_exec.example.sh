#!/usr/bin/env bash
set -o pipefail

# Safe Exec Example (template)
# - no direct secrets here
# - set SAFE_EXEC_APPROVAL_NOTE before enabling dangerous mode

sanitize() {
  python3 - "$1" <<'PY'
import re, sys
s = sys.argv[1] if len(sys.argv)>1 else ""
patterns = [
    (r"\b(?:gho|ghp|ghu)_[A-Za-z0-9_]{20,}\b", "[GH_TOKEN_REDACTED]"),
    (r"\bsk-[A-Za-zA-Z0-9]{20,}\b", "[OPENAI_KEY_REDACTED]"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", "[SLACK_TOKEN_REDACTED]"),
    (r"\bAKIA[0-9A-Z]{16}\b", "[AWS_KEY_REDACTED]"),
]
for p, r in patterns:
    s = re.sub(p, r, s)
print(s)
PY
}

if [ "$#" -eq 0 ]; then
  echo "No command"; exit 2
fi

if [ "${SAFE_EXEC_ALLOW_DANGEROUS:-0}" != "1" ]; then
  case "$1" in
    rm|mkfs|shutdown|reboot|halt|dd)
      echo "Blocked: destructive command blocked by default"; exit 2 ;;
    "rm"*)
      echo "Blocked: destructive command blocked by default"; exit 2 ;;
  esac
  if printf '%s ' "$1" "$2" "$3" "$4" | grep -Eiq "\\b(rm|mkfs|dd|chmod|chown|kill|launchctl|sudo)\\s"; then
    echo "Blocked: unsafe command pattern matched"; exit 2
  fi
fi

if [ "${SAFE_EXEC_ALLOW_DANGEROUS}" = "1" ] && [ -n "${SAFE_EXEC_APPROVAL_NOTE:-}" ]; then
  echo "[SAFE_EXEC] approved: $(printf '%s' "$SAFE_EXEC_APPROVAL_NOTE" | sanitize 'not-logged')"
fi

set +e
out=$("$@" 2>&1)
code=$?
set -e
if [ "$code" -ne 0 ]; then
  echo "Cause: command failed" >&2
  echo "Impact: result not trusted without review" >&2
  echo "Next: re-check command/path/permissions" >&2
fi
printf '%s\n' "$(sanitize "$out")"
exit "$code"
