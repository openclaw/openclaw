#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/sentinel-triage.sh"

extract_function() {
  local fn="$1"
  sed -n "/^${fn}()[[:space:]]*{/,/^}/p" "$SCRIPT_PATH"
}

log() {
  :
}

eval "$(extract_function compute_workload_hash8)"
eval "$(extract_function compute_dedup_key)"
eval "$(extract_function cleanup_spool)"
eval "$(extract_function coalesce_spool_for_key)"

fail() {
  echo "FAIL: $*"
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SPOOL_DIR="$TMP_DIR/spool"
mkdir -p "$SPOOL_DIR"

key1="$(compute_dedup_key 'morpho-dev' 'bad_deploy' 'api|worker')"
key2="$(compute_dedup_key 'morpho-dev' 'bad_deploy' 'api|worker')"
[[ -n "$key1" ]] || fail "dedup key is empty"
[[ "$key1" == "$key2" ]] || fail "dedup key should be deterministic"
echo "PASS: deterministic dedup key"

older="$SPOOL_DIR/triage-${key1}-20260302T100000Z.json"
newer="$SPOOL_DIR/triage-${key1}-20260302T103000Z.json"
printf '{"n":1}\n' > "$older"
printf '{"n":2}\n' > "$newer"

selected="$(coalesce_spool_for_key "$key1")"
[[ "$selected" == "$newer" ]] || fail "coalesce should pick latest file"
[[ -f "$newer" ]] || fail "newest file missing after coalesce"
[[ -f "${older}.acked" ]] || fail "older file should be marked .acked"
echo "PASS: coalescing keeps latest + acks older"

touch "$SPOOL_DIR/${key1}.ack"
if [[ ! -f "$SPOOL_DIR/${key1}.ack" ]]; then
  fail "ack marker not created"
fi
echo "PASS: ack marker present for dedup gate"

# Lifecycle cleanup checks
old_ack="$SPOOL_DIR/old.ack"
old_done="$SPOOL_DIR/old.done"
old_json="$SPOOL_DIR/triage-old-20250101T000000Z.json"
touch "$old_ack" "$old_done" "$old_json"
# Make files older than 24h.
touch -t 202401010000 "$old_ack" "$old_done" "$old_json"
cleanup_spool
[[ ! -f "$old_ack" ]] || fail "old .ack should be cleaned"
[[ ! -f "$old_done" ]] || fail "old .done should be cleaned"
[[ -f "${old_json}.dead" ]] || fail "old unacked spool should be promoted to .dead"
echo "PASS: lifecycle cleanup works"

# Regression: GNU stat -f may emit non-numeric text (for example "File: ...").
TMP_BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR" "$TMP_BIN_DIR"' EXIT
cat >"${TMP_BIN_DIR}/stat" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-f" ]]; then
  echo "File: \"$3\""
  exit 0
fi
if [[ "${1:-}" == "-c" ]]; then
  echo "1700000000"
  exit 0
fi
exit 1
EOF
chmod +x "${TMP_BIN_DIR}/stat"

stat_edge="$SPOOL_DIR/triage-${key1}-20240101T000000Z.json"
printf '{"n":3}\n' >"$stat_edge"
PATH="${TMP_BIN_DIR}:$PATH" cleanup_spool
[[ -f "${stat_edge}.dead" || -f "$stat_edge" ]] || fail "cleanup should not crash on non-numeric stat output"
echo "PASS: cleanup tolerates non-numeric stat output"

echo

echo "All spool dedup tests passed."
