#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/github-ci-status.sh"

extract_function() {
  local fn="$1"
  sed -n "/^${fn}()[[:space:]]*{/,/^}/p" "$SCRIPT_PATH"
}

fail() {
  echo "FAIL: $*"
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BIN_DIR="${TMP_DIR}/bin"
AUTH_CALLS_FILE="${TMP_DIR}/auth-calls.log"
mkdir -p "$TMP_BIN_DIR"

cat > "${TMP_BIN_DIR}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out_file=""
auth_token=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      out_file="${2:-}"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    -H)
      header="${2:-}"
      if [[ "$header" == Authorization:\ Bearer* ]]; then
        auth_token="${header#Authorization: Bearer }"
      fi
      shift 2
      ;;
    http*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

code="401"
body='{"message":"Bad credentials"}'
if [[ "$url" == "https://api.github.com/repos/morpho-org/test-repo/actions/runs?per_page=5" ]]; then
  if [[ "$auth_token" == "fresh-token" || "$auth_token" == "good-token" ]]; then
    code="200"
    body='{"workflow_runs":[]}'
  fi
fi

if [[ -n "$out_file" ]]; then
  printf '%s' "$body" >"$out_file"
else
  printf '%s' "$body"
fi
printf '%s' "$code"
EOF
chmod +x "${TMP_BIN_DIR}/curl"
PATH="${TMP_BIN_DIR}:$PATH"

eval "$(extract_function github_actions_runs_http)"
eval "$(extract_function fetch_actions_runs_for_repo)"

resolve_auth_token_for_repo() {
  printf '%s\n' "${1:-}" >>"${AUTH_CALLS_FILE:?}"
  printf '%s\n' "fresh-token"
}

tmp_json="$(mktemp)"
result="$(fetch_actions_runs_for_repo "morpho-org/test-repo" 5 "$tmp_json" "stale-token")"
rm -f "$tmp_json"
code="${result%%$'\t'*}"
token="${result#*$'\t'}"
[[ "$code" == "200" ]] || fail "expected refresh retry success from stale preferred token, got code=$code"
[[ "$token" == "fresh-token" ]] || fail "expected refreshed token capture"
[[ "$(wc -l <"${AUTH_CALLS_FILE}")" -eq 1 ]] || fail "expected one token refresh call"
echo "PASS: refreshes token and retries on auth failure"

: >"${AUTH_CALLS_FILE}"
resolve_auth_token_for_repo() {
  printf '%s\n' "${1:-}" >>"${AUTH_CALLS_FILE:?}"
  printf '%s\n' "good-token"
}

tmp_json="$(mktemp)"
result="$(fetch_actions_runs_for_repo "morpho-org/test-repo" 5 "$tmp_json" "")"
rm -f "$tmp_json"
code="${result%%$'\t'*}"
token="${result#*$'\t'}"
[[ "$code" == "200" ]] || fail "expected success with resolved token when preferred token missing, got code=$code"
[[ "$token" == "good-token" ]] || fail "expected resolved token capture"
[[ "$(wc -l <"${AUTH_CALLS_FILE}")" -eq 1 ]] || fail "expected one token resolve call"
echo "PASS: resolves repo token when preferred token missing"

resolve_auth_token_for_repo() {
  return 1
}

tmp_json="$(mktemp)"
result="$(fetch_actions_runs_for_repo "morpho-org/test-repo" 5 "$tmp_json" "stale-token")"
rm -f "$tmp_json"
code="${result%%$'\t'*}"
[[ "$code" == "401" ]] || fail "expected auth failure when refresh token is unavailable, got code=$code"
echo "PASS: returns auth failure when refresh source unavailable"

echo "All github-ci-status auth refresh tests passed."
