#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$1"
}

_rca_prompt_scrub() {
  printf '%s\n' "${1:-}" \
    | sed -E 's/(Bearer[[:space:]]+)[A-Za-z0-9._=-]+/\1<redacted>/Ig'
}

_strip_instruction_tokens() {
  printf '%s\n' "${1:-}" \
    | sed -E 's/(system:|developer:|assistant:|user:|tool:)/[instruction-token]/Ig'
}

# shellcheck source=lib-rca-sink.sh
source "${SCRIPT_DIR}/lib-rca-sink.sh"

payload='{"summary":"Pod OOMKilled","root_cause":"memory leak"}'
result="$(redact_for_sink "$payload" "slack")"
if [[ -n "$result" ]]; then
  pass "clean payload passes"
else
  fail "clean payload blocked"
fi

payload_secret='{"summary":"Token is Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}'
result_secret="$(redact_for_sink "$payload_secret" "slack")"
if [[ "$result_secret" == *"Bearer <redacted>"* ]] && [[ "$result_secret" != *"eyJhbGciOiJIUzI1Ni"* ]]; then
  pass "bearer token scrubbed"
else
  fail "bearer token not scrubbed"
fi

payload_entropy='{"summary":"key=aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZyB0aGF0IHNob3VsZCBiZSBjYXVnaHQ="}'
set +e
result_entropy="$(redact_for_sink "$payload_entropy" "slack" 2>/dev/null)"
status_entropy=$?
set -e
if [[ "$result_entropy" == *"[redacted: suspected secret]"* ]] && [[ "$result_entropy" != *"aGVsbG8gd29ybGQ"* ]]; then
  pass "high-entropy token scrubbed"
else
  fail "high-entropy token not scrubbed"
fi
if [[ "$status_entropy" -eq 0 || "$status_entropy" -eq 1 ]]; then
  pass "entropy path returns controlled status"
else
  fail "unexpected status from entropy path: ${status_entropy}"
fi

_sink_detect_entropy_tokens() {
  printf '%s\n' "UNREDACTABLE_TOKEN_FOR_TEST"
}
set +e
result_quarantine="$(redact_for_sink '{"summary":"safe"}' "webhook" 2>/dev/null)"
status_quarantine=$?
set -e
if [[ "$status_quarantine" -ne 0 ]]; then
  pass "fail-closed quarantine on unresolved token"
else
  fail "quarantine path should return non-zero"
fi
if [[ "$result_quarantine" == *"[redacted: suspected secret]"* || -n "$result_quarantine" ]]; then
  pass "quarantine returns payload for audit"
else
  fail "quarantine payload missing"
fi

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
