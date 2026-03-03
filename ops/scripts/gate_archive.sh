#!/usr/bin/env bash
set -euo pipefail
# Mission 001: archive gate receipts into ops/ledger ONLY ON FULL PASS

export KEEP_TMP="${KEEP_TMP:-1}"
TS="$(date -u +%Y%m%d_%H%M%SZ)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD)"

tmpdir="$(mktemp -d)"
health_out="$tmpdir/health.txt"
alpha_out="$tmpdir/alpha.txt"

# Always capture outputs, even on failure.
health_rc=0
alpha_rc=0
bash ops/scripts/cyborg-run health > "$health_out" 2>&1 || health_rc=$?
bash ops/scripts/cyborg-run alpha  > "$alpha_out" 2>&1 || alpha_rc=$?

# Echo for operator visibility.
echo "== health =="; cat "$health_out"
echo "== alpha_smoke =="; cat "$alpha_out"

# Strict PASS contract checks.
if [[ "$health_rc" -ne 0 || "$alpha_rc" -ne 0 ]]; then
  echo "[gate_archive][FAIL] gate command rc failed (health_rc=$health_rc alpha_rc=$alpha_rc); refusing archive"
  exit 1
fi

if ! rg -q "\[strike_echo\]\[PASS\]" "$health_out"; then
  echo "[gate_archive][FAIL] missing strike_echo PASS proof; refusing archive"
  exit 1
fi

if ! rg -q "\bPIN_OK\b" "$health_out"; then
  echo "[gate_archive][FAIL] missing PIN_OK proof; refusing archive"
  exit 1
fi

if ! rg -q "\[alpha_smoke\]\[PASS\] 5/5" "$alpha_out"; then
  echo "[gate_archive][FAIL] missing alpha_smoke PASS 5/5; refusing archive"
  exit 1
fi

# Extract run_ids (required for archive naming)
strike_id="$(rg -o "run_id=[0-9]{6}-[0-9]+" "$health_out" | head -n1 | cut -d= -f2 || true)"
alpha_id="$(rg -o "run_id=[0-9]{6}-[0-9]+" "$alpha_out"  | head -n1 | cut -d= -f2 || true)"

if [[ -z "${strike_id}" || -z "${alpha_id}" ]]; then
  echo "[gate_archive][FAIL] missing run_id (strike_id='${strike_id}' alpha_id='${alpha_id}'); refusing archive"
  exit 1
fi

base="ops/ledger/gate_${TS}_${alpha_id}"
md="${base}.md"
js="${base}.json"

python3 - <<PY
import json, pathlib
health = pathlib.Path("${health_out}").read_text(encoding="utf-8", errors="replace")
alpha  = pathlib.Path("${alpha_out}").read_text(encoding="utf-8", errors="replace")
obj = {
  "ts_utc": "${TS}",
  "branch": "${BRANCH}",
  "head": "${HEAD_SHA}",
  "strike_echo_run_id": "${strike_id}",
  "alpha_smoke_run_id": "${alpha_id}",
  "health_output_raw": health,
  "alpha_output_raw": alpha,
  "gate_status": "PASS"
}
path = pathlib.Path("${js}")
path.write_text(json.dumps(obj, indent=2), encoding="utf-8")
print("WROTE_JSON", str(path), "bytes", path.stat().st_size)
PY

cat > "${md}" <<MD
# Gate Receipt — ${TS}

- Branch: ${BRANCH}
- HEAD: ${HEAD_SHA}
- strike_echo run_id: ${strike_id}
- alpha_smoke run_id: ${alpha_id}
- gate_status: PASS

## Files
- ${js}
- /tmp/strike_echo_last.txt
- /tmp/cc-alpha-${alpha_id}-*
MD

echo "[gate_archive][OK] wrote:"
ls -la "${md}" "${js}"
