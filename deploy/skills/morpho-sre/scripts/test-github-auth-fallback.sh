#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/repo-clone.sh"

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
    -X)
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

code="404"
body='{"message":"not found"}'
if [[ "$url" == "https://api.github.com/repos/morpho-org/test-repo" ]]; then
  if [[ "$auth_token" == "env-good" || "$auth_token" == "app-good" ]]; then
    code="200"
    body='{"id":1}'
  else
    code="401"
    body='{"message":"Bad credentials"}'
  fi
elif [[ "$url" == "https://api.github.com/app/installations" ]]; then
  code="200"
  body='[{"account":{"login":"morpho-org"},"id":42}]'
elif [[ "$url" == "https://api.github.com/app/installations/42/access_tokens" ]]; then
  code="201"
  body='{"token":"app-good"}'
fi

if [[ -n "$out_file" ]]; then
  printf '%s' "$body" >"$out_file"
else
  printf '%s' "$body"
fi
printf '%s' "$code"
EOF

cat > "${TMP_BIN_DIR}/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf 'mock.jwt.token'
EOF

chmod +x "${TMP_BIN_DIR}/curl" "${TMP_BIN_DIR}/node"
PATH="${TMP_BIN_DIR}:$PATH"

require_cmd() {
  :
}

eval "$(extract_function mint_github_app_token)"
eval "$(extract_function github_repo_access_ok)"
eval "$(extract_function resolve_auth_token_for_repo)"

unset GH_TOKEN
unset GITHUB_APP_ID
unset GITHUB_APP_PRIVATE_KEY
unset GITHUB_APP_INSTALLATION_ID
export GITHUB_TOKEN="env-good"
token="$(resolve_auth_token_for_repo morpho-org/test-repo || true)"
[[ "$token" == "env-good" ]] || fail "expected env token when valid, got '$token'"
echo "PASS: keeps valid env token"

export GITHUB_TOKEN="env-bad"
export GITHUB_APP_ID="12345"
export GITHUB_APP_PRIVATE_KEY="FAKE_GITHUB_APP_PEM_LINE_1\\nFAKE_GITHUB_APP_PEM_LINE_2"
unset GITHUB_APP_INSTALLATION_ID
token="$(resolve_auth_token_for_repo morpho-org/test-repo || true)"
[[ "$token" == "app-good" ]] || fail "expected app token fallback when env token invalid, got '$token'"
echo "PASS: falls back to GitHub App token when env token is invalid"

export GITHUB_TOKEN="env-bad"
unset GH_TOKEN
unset GITHUB_APP_ID
unset GITHUB_APP_PRIVATE_KEY
unset GITHUB_APP_INSTALLATION_ID
if resolve_auth_token_for_repo morpho-org/test-repo >/dev/null 2>&1; then
  fail "expected invalid env token to be rejected without app fallback"
fi
echo "PASS: rejects invalid env token when no app fallback exists"

unset GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_APP_ID
unset GITHUB_APP_PRIVATE_KEY
unset GITHUB_APP_INSTALLATION_ID
if resolve_auth_token_for_repo morpho-org/test-repo >/dev/null 2>&1; then
  fail "expected auth resolution to fail when no token sources exist"
fi
echo "PASS: fails cleanly when no auth source exists"

echo "All github auth fallback tests passed."
