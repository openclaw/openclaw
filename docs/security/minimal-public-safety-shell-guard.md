# Minimal shell guard templates

If you run tool-enabled local assistants, the two biggest risks are:

- accidental dangerous command execution,
- accidentally treating external/untrusted text as executable instructions,
- leaking secrets when sharing logs/notes.

This page gives **template-only** guard patterns for local automation. Fill them with your own paths/policies.

## 1) Execution gate pattern (`safe_exec`)

Use this pattern when running shell work from an agent or helper:

```bash
# Safe-ish command runner template
# - keep your real implementation in your own workspace
if [ "${SAFE_EXEC_ALLOW_DANGEROUS:-0}" != "1" ]; then
  case "${1-}" in
    rm|rm\ *)
      echo "blocked: destructive command requires approval"
      exit 2
      ;;
    reboot|shutdown|halt|mkfs|dd)
      echo "blocked: destructive command requires approval"
      exit 2
      ;;
    *)
      :
      ;;
  esac
fi
```

Recommended rule: **default deny for high-risk categories**, explicit allow only with a documented approval note.

## 2) External content gate (web/comment/fetch)

Treat external text as data only.

```bash
case "$SOURCE" in
  web|external)
    if printf '%s' "$TEXT" | grep -Eiq "(^|[[:space:]])(rm|mkfs|dd|chmod|chown|kill|curl|wget|launchctl|sudo)\\s|;|&&|\\|\\||\\$\\(|`|<script|<iframe"; then
      echo "blocked: untrusted text contains command-like patterns"
      exit 2
    fi
    ;;
esac
```

Recommended rule: never parse external instructions as command input.

## 3) Publish sanitization gate

Before posting to issues/threads/chats, remove secret-like values and keep only non-sensitive context.

```bash
python3 - <<'PY'
import re, sys
s = open(sys.argv[1]).read()
s = re.sub(r"\\bgh[opu]_[A-Za-z0-9_]{20,}\\b", "[GH_TOKEN_REDACTED]", s)
s = re.sub(r"\\bsk-[A-Za-z0-9]{20,}\\b", "[OPENAI_KEY_REDACTED]", s)
# add more patterns to match your environment
print(s)
PY "$INPUT_FILE" > "$OUTPUT_FILE"
```

## 4) Non-intrusive integration

Prefer introducing guards as **optional wrappers** in your workflow

- `security_auto.sh exec -- <command>`
- `security_auto.sh web --source web file.txt`
- `security_auto.sh publish draft.md > draft-safe.md`

That keeps normal tool behavior unchanged while enabling safety when used.

## 5) What not to include in public templates

- tenant/project-specific secrets,
- private path lists,
- exact bypass experiments,
- approval tokens/notes from real incidents.

Keep these as local policy extensions in your own repo.

### Example script set

Use these optional template files (copy + adjust):

- `scripts/safety-guards/safe_exec.example.sh`
- `scripts/safety-guards/web_input_guard.example.sh`
- `scripts/safety-guards/public_publish_guard.example.sh`
- `scripts/safety-guards/security_auto.example.sh`
- `scripts/safety-guards/README.md`
