#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$ROOT/.openclaw/workspace-state.json"
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PASS=true
issues=()
checked_files=()

check_file() {
  local rel="$1"
  checked_files+=("$rel")
  if [[ ! -f "$ROOT/$rel" ]]; then
    PASS=false
    issues+=("missing_file:$rel")
  fi
}

check_file "SOUL.md"
check_file "MEMORY.md"
check_file "AGENTS.md"
check_file "IDENTITY.md"
check_file "TOOLS.md"
check_file "USER.md"
check_file "nodes/dali/MEMORY.md"
check_file "nodes/dali/bootstrap/IDENTITY.md"
check_file "nodes/dali/bootstrap/USER.md"
check_file "scripts/workspace-integrity.sh"
check_file ".openclaw/workspace-state.json"

LATEST_MEMORY=""
LATEST_MEMORY=$(find "$ROOT/memory" -maxdepth 1 -name "$(date +%Y)-*.md" -type f 2>/dev/null | sort | tail -n 1 || true)
if [[ -z "$LATEST_MEMORY" ]]; then
  PASS=false
  issues+=("missing_memory_file")
fi

normalize() {
  local value="$1"
  printf '%s' "$value" | sed 's/[[:space:]]\+$//' | sed 's/^[[:space:]]\+//'
}

TOP_HEADING=""
NODE_HEADING=""
if [[ -f "$ROOT/MEMORY.md" ]]; then
  TOP_HEADING="$(sed -n '1,1p' "$ROOT/MEMORY.md" | tr -d '\r')"
fi
if [[ -f "$ROOT/nodes/dali/MEMORY.md" ]]; then
  NODE_HEADING="$(sed -n '1,1p' "$ROOT/nodes/dali/MEMORY.md" | tr -d '\r')"
fi

if [[ -n "$TOP_HEADING" || -n "$NODE_HEADING" ]] && [[ "$(normalize "$TOP_HEADING")" != "$(normalize "$NODE_HEADING")" ]]; then
  PASS=false
  issues+=("memory_heading_drift:$TOP_HEADING -> $NODE_HEADING")
fi

if [[ -f "$ROOT/MEMORY.md" && -f "$ROOT/nodes/dali/MEMORY.md" ]] && ! cmp -s "$ROOT/MEMORY.md" "$ROOT/nodes/dali/MEMORY.md"; then
  PASS=false
  issues+=("memory_content_drift")
fi

BOOTSTRAP_FIELD_ISSUES="$(python3 - "$ROOT" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
checks = {
    "IDENTITY.md": ["Name", "Creature", "Vibe", "Emoji", "Avatar"],
    "USER.md": ["Name", "What to call them", "Timezone"],
    "nodes/dali/bootstrap/IDENTITY.md": ["Name", "Creature", "Vibe", "Emoji", "Avatar"],
    "nodes/dali/bootstrap/USER.md": ["Name", "What to call them", "Timezone"],
}
problems = []
for rel, fields in checks.items():
    path = root / rel
    if not path.exists():
        continue
    text = path.read_text(encoding="utf-8")
    for field in fields:
        match = re.search(rf"- \*\*{re.escape(field)}:\*\*\s*(.*)", text)
        value = (match.group(1) if match else "").strip()
        if not value or value.startswith("_(") or value in {"_", "TBD", "TODO"}:
            problems.append(f"{rel}:{field}")
            continue
        if field == "Avatar":
            lowered = value.lower()
            if lowered in {"none", "none yet", "unset", "n/a"}:
                continue
            if value.startswith(("http://", "https://", "data:")):
                continue
            avatar_path = (path.parent / value).resolve()
            if not avatar_path.exists():
                problems.append(f"{rel}:AvatarPathMissing:{value}")
if problems:
    print("\n".join(problems))
PY
)"
if [[ -n "$BOOTSTRAP_FIELD_ISSUES" ]]; then
  PASS=false
  while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    issues+=("bootstrap_field_incomplete:$issue")
  done <<< "$BOOTSTRAP_FIELD_ISSUES"
fi

if [[ -f "$STATE_FILE" ]]; then
  if ! python3 - "$STATE_FILE" <<'PY'
import json,sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
if not isinstance(data, dict):
    raise SystemExit(1)
if "version" not in data:
    raise SystemExit(1)
if not isinstance(data.get("version"), int):
    raise SystemExit(1)
PY
  then
    PASS=false
    issues+=("state_json_invalid")
  fi
else
  PASS=false
  issues+=("state_json_missing")
fi

RESULT="pass"
if [[ "$PASS" = false ]]; then
  RESULT="fail"
fi

python3 - "$ROOT" "$STATE_FILE" "$NOW_UTC" "$LATEST_MEMORY" "$RESULT" "${issues[@]}" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

root_path, state_path, now_utc, latest_memory, initial_result = sys.argv[1:6]
issues = list(sys.argv[6:])
path = Path(state_path)
root = Path(root_path)
if path.exists():
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
else:
    data = {}

expected_dirty = {
    "AGENTS.md",
    "MEMORY.md",
    "nodes/dali/MEMORY.md",
    "scripts/workspace-integrity.sh",
    "skills/",
    "dali-local-v1/README.md",
    "dali-local-v1/scripts/dali_store.py",
    "dali-local-v1/src/memory_store.py",
    "dali-local-v1/tests/test_memory_store.py",
}
if latest_memory:
    expected_dirty.add(Path(latest_memory).relative_to(root).as_posix())

def is_expected_dirty(rel: str) -> bool:
    return any(rel == item or rel.startswith(item) for item in expected_dirty)
git_status = {
    "available": False,
    "stagedCount": 0,
    "modifiedCount": 0,
    "untrackedCount": 0,
    "expectedDirtyCount": 0,
    "unexpectedDirtyCount": 0,
    "samplePaths": [],
    "unexpectedPaths": [],
}
try:
    proc = subprocess.run(
        ["git", "-C", str(root), "status", "--short"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0:
        git_status["available"] = True
        sample = []
        for raw in proc.stdout.splitlines():
            line = raw.rstrip()
            if not line:
                continue
            status = line[:2]
            rel = line[3:] if len(line) > 3 else ""
            dirty = False
            if status == "??":
                git_status["untrackedCount"] += 1
                dirty = True
            else:
                if status[:1] not in {" ", "?"}:
                    git_status["stagedCount"] += 1
                    dirty = True
                if status[1:2] not in {" ", "?"}:
                    git_status["modifiedCount"] += 1
                    dirty = True
            if dirty:
                if is_expected_dirty(rel):
                    git_status["expectedDirtyCount"] += 1
                else:
                    git_status["unexpectedDirtyCount"] += 1
                    if rel and len(git_status["unexpectedPaths"]) < 10:
                        git_status["unexpectedPaths"].append(rel)
            if rel and len(sample) < 10:
                sample.append(rel)
        git_status["samplePaths"] = sample
except Exception:
    pass

result = initial_result
if result != "fail" and git_status["available"]:
    if git_status["stagedCount"]:
        issues.append(f"git_staged_count:{git_status['stagedCount']}")
    if git_status["modifiedCount"]:
        issues.append(f"git_modified_count:{git_status['modifiedCount']}")
    if git_status["untrackedCount"]:
        issues.append(f"git_untracked_count:{git_status['untrackedCount']}")
    if git_status["expectedDirtyCount"]:
        issues.append(f"git_expected_dirty_count:{git_status['expectedDirtyCount']}")
    if git_status["unexpectedDirtyCount"]:
        issues.append(f"git_unexpected_dirty_count:{git_status['unexpectedDirtyCount']}")
        result = "warn"
    elif git_status["stagedCount"] or git_status["modifiedCount"] or git_status["untrackedCount"]:
        result = "warn-expected"

data["lastIntegrityCheck"] = {
    "at": now_utc,
    "result": result,
    "latestMemory": latest_memory,
    "issues": issues,
    "gitStatus": git_status,
}

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

STATE_RESULT="$(python3 - "$STATE_FILE" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
print(((data.get('lastIntegrityCheck') or {}).get('result')) or 'unknown')
PY
)"

if [[ "$PASS" = true ]]; then
  echo "workspace-integrity: ${STATE_RESULT}"
  echo "checked_files=${#checked_files[@]}"
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "git_status=$(git -C "$ROOT" status --short | wc -l | tr -d ' ') entries"
  fi
  echo "state updated: ${STATE_FILE}"
  exit 0
fi

echo "workspace-integrity: fail"
printf '%s\n' "${issues[@]}"
exit 1
