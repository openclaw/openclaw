#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
GATEWAY_LOG="$STATE_DIR/logs/gateway.log"
NODE22_BIN="${OPENCLAW_SELFTEST_NODE_BIN:-$HOME/.node22/current/bin}"
BUILDER_ID="${OPENCLAW_LOCAL_BUILDER_ID:-oc-builder}"
GITHUB_ID="${OPENCLAW_LOCAL_GITHUB_ID:-oc-github}"
SELFTEST_ROOT="$(mktemp -d "$REPO_ROOT/.local-agent-selftest.XXXXXX")"
EXEC_JSON="$SELFTEST_ROOT/exec.json"
READ_JSON="$SELFTEST_ROOT/read.json"
PATCH_JSON="$SELFTEST_ROOT/patch.json"
GITHUB_JSON="$SELFTEST_ROOT/github.json"
WA_JSON="$SELFTEST_ROOT/whatsapp.json"
READ_PROOF="$SELFTEST_ROOT/read-proof.txt"
PATCH_TARGET="$SELFTEST_ROOT/patch-target.txt"

cleanup() {
  rm -rf "$SELFTEST_ROOT"
}
trap cleanup EXIT

if [[ -d "$NODE22_BIN" ]]; then
  PATH="$NODE22_BIN:$PATH"
  export PATH
fi

json_payload_text() {
  local json_path="$1"
  python3 - <<'PY' "$json_path"
import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    raw = handle.read()
start = raw.find("{")
if start < 0:
    raise SystemExit(f"{path}: missing JSON payload")
payload = json.loads(raw[start:])
print(payload["result"]["payloads"][0]["text"])
PY
}

run_json_assert() {
  local json_path="$1"
  local expected="$2"
  local actual
  actual="$(json_payload_text "$json_path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$json_path: unexpected text '$actual' != '$expected'" >&2
    exit 1
  fi
}

latest_session_jsonl() {
  local agent_id="$1"
  python3 - <<'PY' "$STATE_DIR" "$agent_id"
import pathlib, sys
state_dir, agent_id = sys.argv[1], sys.argv[2]
session_dir = pathlib.Path(state_dir) / "agents" / agent_id / "sessions"
files = sorted(session_dir.glob("*.jsonl"), key=lambda item: item.stat().st_mtime, reverse=True)
print(files[0] if files else "")
PY
}

assert_tool_call() {
  local agent_id="$1"
  local pattern="$2"
  local session_file
  session_file="$(latest_session_jsonl "$agent_id")"
  if [[ -z "$session_file" || ! -f "$session_file" ]]; then
    echo "missing session log for $agent_id" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$session_file"; then
    echo "expected pattern $pattern in $session_file" >&2
    exit 1
  fi
}

echo "== bootstrap local coding agents =="
node "$REPO_ROOT/scripts/dev/bootstrap-local-coding-agents.mjs" >/dev/null

echo "== gateway health =="
openclaw gateway health

echo "== exec proof =="
EXEC_EXPECTED="EXEC_OK:$(cd "$REPO_ROOT" && pwd)"
openclaw agent --agent "$BUILDER_ID" --message "Nutze exec, führe 'pwd' aus und antworte exakt mit $EXEC_EXPECTED." --json >"$EXEC_JSON"
run_json_assert "$EXEC_JSON" "$EXEC_EXPECTED"
assert_tool_call "$BUILDER_ID" '"name":"exec"'

echo "== read proof =="
READ_EXPECTED="READ_OK_$(date +%s)"
printf '%s\n' "$READ_EXPECTED" >"$READ_PROOF"
openclaw agent --agent "$BUILDER_ID" --message "Nutze read, lies $READ_PROOF und antworte exakt mit dem Inhalt." --json >"$READ_JSON"
run_json_assert "$READ_JSON" "$READ_EXPECTED"
assert_tool_call "$BUILDER_ID" '"name":"read"'

echo "== patch proof =="
PATCH_EXPECTED="PATCH_OK_$(date +%s)"
printf 'before\n' >"$PATCH_TARGET"
openclaw agent --agent "$BUILDER_ID" --message "Nutze apply_patch oder edit, ändere $PATCH_TARGET so dass die Datei exakt '$PATCH_EXPECTED' enthält. Antworte exakt mit PATCH_DONE." --json >"$PATCH_JSON"
run_json_assert "$PATCH_JSON" "PATCH_DONE"
ACTUAL_PATCH="$(tr -d '\r' <"$PATCH_TARGET" | tr -d '\n')"
if [[ "$ACTUAL_PATCH" != "$PATCH_EXPECTED" ]]; then
  echo "patch proof failed: $ACTUAL_PATCH != $PATCH_EXPECTED" >&2
  exit 1
fi
assert_tool_call "$BUILDER_ID" '"name":"apply_patch"|"name":"edit"|"name":"write"'

echo "== github proof =="
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  GITHUB_REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
  GITHUB_EXPECTED="GITHUB_OK:$GITHUB_REPO"
  openclaw agent --agent "$GITHUB_ID" --message "Nutze exec und führe 'gh repo view --json nameWithOwner,isFork,url' aus. Antworte exakt mit $GITHUB_EXPECTED." --json >"$GITHUB_JSON"
  run_json_assert "$GITHUB_JSON" "$GITHUB_EXPECTED"
  assert_tool_call "$GITHUB_ID" '"name":"exec"'
else
  echo "SKIP github proof (gh missing or unauthenticated)"
  if [[ "${OPENCLAW_SELFTEST_REQUIRE_GITHUB:-0}" == "1" ]]; then
    echo "github proof required but unavailable" >&2
    exit 1
  fi
fi

echo "== whatsapp reply proof =="
WHATSAPP_STATUS_RAW="$(openclaw channels status --json)"
WHATSAPP_SELF_E164="$(printf '%s' "$WHATSAPP_STATUS_RAW" | python3 -c 'import json, sys; raw=sys.stdin.read(); start=raw.find("{"); assert start >= 0, raw; payload=json.loads(raw[start:]); channel=payload.get("channels", {}).get("whatsapp", {}); print(channel.get("self", {}).get("e164", ""))')"
WHATSAPP_LINKED="$(printf '%s' "$WHATSAPP_STATUS_RAW" | python3 -c 'import json, sys; raw=sys.stdin.read(); start=raw.find("{"); assert start >= 0, raw; payload=json.loads(raw[start:]); print("1" if payload.get("channels", {}).get("whatsapp", {}).get("linked") else "0")')"
if [[ -n "$WHATSAPP_SELF_E164" && "$WHATSAPP_LINKED" == "1" ]]; then
  WA_EXPECTED="WA_SELFTEST_$(date +%s)"
  if [[ ! -f "$GATEWAY_LOG" ]]; then
    echo "missing gateway log at $GATEWAY_LOG" >&2
    exit 1
  fi
  WA_LOG_MARKER="$(wc -c <"$GATEWAY_LOG")"
  openclaw agent --agent main --channel whatsapp --to "$WHATSAPP_SELF_E164" --deliver --message "Antworte exakt: $WA_EXPECTED" --json >"$WA_JSON"
  run_json_assert "$WA_JSON" "$WA_EXPECTED"
  python3 - <<'PY' "$GATEWAY_LOG" "$WA_LOG_MARKER" "$WA_EXPECTED"
import sys
log_path = sys.argv[1]
offset = int(sys.argv[2])
expected = sys.argv[3]
with open(log_path, "rb") as handle:
    handle.seek(offset)
    tail = handle.read().decode("utf-8", errors="replace")
if expected not in tail or "Sent message" not in tail:
    raise SystemExit(f"whatsapp delivery proof missing token or sent marker for {expected!r}")
print(expected)
PY
else
  echo "SKIP whatsapp proof (channel not linked)"
  if [[ "${OPENCLAW_SELFTEST_REQUIRE_WHATSAPP:-0}" == "1" ]]; then
    echo "whatsapp proof required but unavailable" >&2
    exit 1
  fi
fi

echo "== all local coding agent selftests passed =="
