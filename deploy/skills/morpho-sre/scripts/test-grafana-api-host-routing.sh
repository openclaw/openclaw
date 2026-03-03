#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/grafana-api.sh"

fail() {
  echo "FAIL: $*"
  exit 1
}

assert_contains() {
  local haystack="${1:-}"
  local needle="${2:-}"
  local msg="${3:-expected substring missing}"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "$msg (needle='$needle')"
  fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BIN_DIR="${TMP_DIR}/bin"
mkdir -p "$TMP_BIN_DIR"

cat > "${TMP_BIN_DIR}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${@: -1}"
printf '{"ok":true,"url":"%s"}\n' "$url"
EOF

cat > "${TMP_BIN_DIR}/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "config" && "${2:-}" == "current-context" ]]; then
  printf '%s\n' "${MOCK_CONTEXT:-unknown}"
  exit 0
fi
exit 1
EOF

chmod +x "${TMP_BIN_DIR}/curl" "${TMP_BIN_DIR}/kubectl"

run_case() {
  local name="$1"
  local ctx="$2"
  local base="$3"
  local allowed="$4"
  local expected_code="$5"
  local expected_substr="$6"
  local out code

  if [[ "$allowed" == "__unset__" ]]; then
    set +e
    out="$(
      PATH="${TMP_BIN_DIR}:$PATH" \
      K8S_CONTEXT="$ctx" \
      GRAFANA_BASE_URL="$base" \
      GRAFANA_TOKEN="token" \
      bash "$SCRIPT_PATH" GET /api/health 2>&1
    )"
    code=$?
    set -e
  else
    set +e
    out="$(
      PATH="${TMP_BIN_DIR}:$PATH" \
      K8S_CONTEXT="$ctx" \
      GRAFANA_BASE_URL="$base" \
      GRAFANA_TOKEN="token" \
      GRAFANA_ALLOWED_HOST="$allowed" \
      bash "$SCRIPT_PATH" GET /api/health 2>&1
    )"
    code=$?
    set -e
  fi

  if [[ "$code" -ne "$expected_code" ]]; then
    echo "$out"
    fail "${name}: expected exit ${expected_code}, got ${code}"
  fi
  if [[ -n "$expected_substr" ]]; then
    assert_contains "$out" "$expected_substr" "${name}: unexpected output"
  fi
  echo "PASS: ${name}"
}

run_case \
  "dev context allows dev host" \
  "arn:aws:eks:eu-west-3:123456789012:cluster/dev-morpho" \
  "https://monitoring-dev.morpho.dev" \
  "__unset__" \
  0 \
  "\"ok\":true"

run_case \
  "prd context allows prd host" \
  "arn:aws:eks:eu-west-3:123456789012:cluster/prd-morpho" \
  "https://monitoring.morpho.dev" \
  "__unset__" \
  0 \
  "\"ok\":true"

run_case \
  "dev context blocks prd host" \
  "arn:aws:eks:eu-west-3:123456789012:cluster/dev-morpho" \
  "https://monitoring.morpho.dev" \
  "__unset__" \
  1 \
  "context expects: monitoring-dev.morpho.dev"

run_case \
  "prd context blocks dev host" \
  "arn:aws:eks:eu-west-3:123456789012:cluster/prd-morpho" \
  "https://monitoring-dev.morpho.dev" \
  "__unset__" \
  1 \
  "context expects: monitoring.morpho.dev"

run_case \
  "unknown context with explicit host works" \
  "unknown-context" \
  "https://monitoring.morpho.dev" \
  "monitoring.morpho.dev" \
  0 \
  "\"ok\":true"

run_case \
  "unknown context defaults to dev host" \
  "unknown-context" \
  "https://monitoring-dev.morpho.dev" \
  "__unset__" \
  0 \
  "\"ok\":true"

run_case \
  "unknown context default blocks prd host without explicit allow" \
  "unknown-context" \
  "https://monitoring.morpho.dev" \
  "__unset__" \
  1 \
  "allowed: monitoring-dev.morpho.dev"

echo "All grafana-api host routing tests passed."
