#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="${SCRIPT_DIR}/relationship-knowledge-build.sh"

fail() {
  echo "FAIL: $*"
  exit 1
}

pass() {
  echo "PASS: $*"
}

if ! command -v jq >/dev/null 2>&1; then
  echo "skip: jq missing"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

MOCK_BIN_DIR="${TMP_DIR}/bin"
mkdir -p "$MOCK_BIN_DIR"

INFRA_DIR="${TMP_DIR}/morpho-infra"
HELM_DIR="${TMP_DIR}/morpho-infra-helm"
mkdir -p "${INFRA_DIR}/projects/commons" "$HELM_DIR"

cat > "${INFRA_DIR}/projects/commons/variables.auto.tfvars" <<'EOF_TFVARS'
github_repositories = [
  "morpho-org/morpho-infra",
  "morpho-org/morpho-infra-helm",
  "morpho-org/morpho-blue-api"
]

ecr_repository_mapping = {
  "morpho-org/morpho-blue-api" = "morpho-blue-api"
}
EOF_TFVARS

MOCK_AWS_SCRIPT="${TMP_DIR}/aws-resource-signals.sh"
cat > "$MOCK_AWS_SCRIPT" <<'EOF_AWS'
#!/usr/bin/env bash
set -euo pipefail
echo -e "resource_type\tresource_id\tstatus\tutilization_pct\tnotes"
echo -e "ec2-instance\ti-abc123\tok\tn/a\tsystem=ok;instance=ok"
echo -e "ecr-repository\tmorpho-blue-api\twarning\tn/a\tscan_findings=1"
EOF_AWS
chmod +x "$MOCK_AWS_SCRIPT"

cat > "${MOCK_BIN_DIR}/kubectl" <<'EOF_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" == *"config current-context"* ]]; then
  echo "dev-morpho"
  exit 0
fi

if [[ "$*" == *"get pods -A -o json"* ]]; then
  if [[ "${MOCK_KUBECTL_MODE:-ok}" == "fail" ]]; then
    echo "mock kubectl unavailable" >&2
    exit 1
  fi
  cat <<'JSON'
{
  "items": [
    {
      "metadata": { "namespace": "dev", "name": "api-7f9d4" },
      "spec": {
        "containers": [
          { "image": "537124939463.dkr.ecr.eu-west-3.amazonaws.com/morpho-blue-api:2026.3.3" }
        ],
        "initContainers": [
          { "image": "busybox:1.36" }
        ]
      }
    }
  ]
}
JSON
  exit 0
fi

echo '{"items":[]}'
EOF_KUBECTL
chmod +x "${MOCK_BIN_DIR}/kubectl"

cat > "${MOCK_BIN_DIR}/curl" <<'EOF_CURL'
#!/usr/bin/env bash
set -euo pipefail

out_file=""
url=""
auth_token=""

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

if [[ "${MOCK_GITHUB_MODE:-ok}" == "fail" ]]; then
  code="503"
  body='{"message":"service unavailable"}'
elif [[ "$url" == "https://api.github.com/orgs/morpho-org" ]]; then
  if [[ "$auth_token" == "good-token" ]]; then
    code="200"
    body='{"login":"morpho-org"}'
  else
    code="401"
    body='{"message":"Bad credentials"}'
  fi
elif [[ "$url" == "https://api.github.com/orgs/morpho-org/repos?per_page=100&page=1&type=all" ]]; then
  if [[ "$auth_token" == "good-token" ]]; then
    code="200"
    body='[
      {"full_name":"morpho-org/morpho-infra"},
      {"full_name":"morpho-org/morpho-blue-api"},
      {"full_name":"morpho-org/morpho-infra-helm"}
    ]'
  else
    code="401"
    body='{"message":"Bad credentials"}'
  fi
elif [[ "$url" == "https://api.github.com/repos/morpho-org/morpho-infra" ]]; then
  if [[ "$auth_token" == "good-token" ]]; then
    code="200"
    body='{"full_name":"morpho-org/morpho-infra"}'
  else
    code="401"
    body='{"message":"Bad credentials"}'
  fi
fi

if [[ -n "$out_file" ]]; then
  printf '%s' "$body" > "$out_file"
else
  printf '%s' "$body"
fi
printf '%s' "$code"
EOF_CURL
chmod +x "${MOCK_BIN_DIR}/curl"

PATH="${MOCK_BIN_DIR}:$PATH"

OUT_DIR_OK="${TMP_DIR}/out-ok"
GITHUB_TOKEN="good-token" \
MORPHO_INFRA_DIR="$INFRA_DIR" \
MORPHO_INFRA_HELM_DIR="$HELM_DIR" \
AWS_RESOURCE_SIGNALS_SCRIPT="$MOCK_AWS_SCRIPT" \
OUTPUT_DIR="$OUT_DIR_OK" \
"$SCRIPT_PATH" >/dev/null

[[ -f "${OUT_DIR_OK}/initial-knowledge.v1.json" ]] || fail "missing initial-knowledge.v1.json"
[[ -f "${OUT_DIR_OK}/nodes.ndjson" ]] || fail "missing nodes.ndjson"
[[ -f "${OUT_DIR_OK}/edges.ndjson" ]] || fail "missing edges.ndjson"

jq -e . "${OUT_DIR_OK}/initial-knowledge.v1.json" >/dev/null || fail "invalid main JSON"
jq -s -e 'all(type=="object") and length > 0' "${OUT_DIR_OK}/nodes.ndjson" >/dev/null || fail "invalid nodes.ndjson"
jq -s -e 'all(type=="object") and length > 0' "${OUT_DIR_OK}/edges.ndjson" >/dev/null || fail "invalid edges.ndjson"

jq -e '.nodes[] | select(.id=="repo:morpho-org/morpho-infra")' "${OUT_DIR_OK}/initial-knowledge.v1.json" >/dev/null || fail "expected morpho-infra repo node"
jq -e '.nodes[] | select(.id=="image-repo:537124939463.dkr.ecr.eu-west-3.amazonaws.com/morpho-blue-api")' "${OUT_DIR_OK}/initial-knowledge.v1.json" >/dev/null || fail "expected image repo node"
jq -e '.nodes[] | select(.id=="aws-resource:ec2-instance/i-abc123")' "${OUT_DIR_OK}/initial-knowledge.v1.json" >/dev/null || fail "expected aws resource node"
jq -e '.edges[] | select(.type=="runs_image_repo")' "${OUT_DIR_OK}/initial-knowledge.v1.json" >/dev/null || fail "expected runs_image_repo edge"
jq -e '.source_status.github_org_repositories.status=="ok"' "${OUT_DIR_OK}/initial-knowledge.v1.json" >/dev/null || fail "expected github source ok"
pass "happy path graph + status"

OUT_DIR_DEGRADED="${TMP_DIR}/out-degraded"
MOCK_KUBECTL_MODE="fail" \
GITHUB_TOKEN="good-token" \
MORPHO_INFRA_DIR="$INFRA_DIR" \
MORPHO_INFRA_HELM_DIR="$HELM_DIR" \
AWS_RESOURCE_SIGNALS_SCRIPT="$MOCK_AWS_SCRIPT" \
OUTPUT_DIR="$OUT_DIR_DEGRADED" \
"$SCRIPT_PATH" >/dev/null

jq -e . "${OUT_DIR_DEGRADED}/initial-knowledge.v1.json" >/dev/null || fail "invalid degraded main JSON"
jq -e '.source_status.kubernetes_pods.status != "ok"' "${OUT_DIR_DEGRADED}/initial-knowledge.v1.json" >/dev/null || fail "expected kubernetes source degraded/unavailable"
jq -e '.source_status.kubernetes_pods.error | length > 0' "${OUT_DIR_DEGRADED}/initial-knowledge.v1.json" >/dev/null || fail "expected kubernetes source error"
jq -e '.counts.nodes > 0 and .counts.edges > 0' "${OUT_DIR_DEGRADED}/initial-knowledge.v1.json" >/dev/null || fail "expected non-empty graph under degradation"
pass "graceful degradation still emits valid graph"

echo "All relationship-knowledge-build tests passed."
