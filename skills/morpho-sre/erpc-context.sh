#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  erpc-context.sh [--print-summary] [--print-dir]

Builds a local eRPC context bundle for Morpho RPC questions:
  - redacted prod config snapshot from Vault
  - upstream eRPC repo/docs/code references
  - extracted metrics catalog from telemetry source
  - Morpho local architecture/ops/deployment references

Env:
  ERPC_CONTEXT_DIR        output dir (default: /tmp/openclaw-erpc-context)
  ERPC_UPSTREAM_REPO_DIR  repo cache dir (default: <context-dir>/upstream-repo)
  ERPC_UPSTREAM_REPO_URL  repo url (default: https://github.com/0x666c6f/erpc)
  ERPC_FULL_CONTEXT_ENABLED  enable Vault-backed full context (default: 0)
  ERPC_VAULT_ADDR         vault addr (default: https://config.morpho.dev)
  ERPC_VAULT_MOUNT        vault kv mount (default: secret)
  ERPC_VAULT_KEY          vault kv key (default: erpc/config)
  ERPC_VAULT_AUTH_PATH    vault auth path (default: auth/kubernetes)
  ERPC_VAULT_ROLE         vault kubernetes role (default: incident-readonly-agent)
  ERPC_VAULT_JWT_FILE     explicit service-account jwt file
  MORPHO_INFRA_DIR        local morpho-infra path
  MORPHO_INFRA_HELM_DIR   local morpho-infra-helm path
EOF
}

PRINT_SUMMARY=0
PRINT_DIR=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-summary) PRINT_SUMMARY=1 ;;
    --print-dir) PRINT_DIR=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

ERPC_CONTEXT_DIR="${ERPC_CONTEXT_DIR:-/tmp/openclaw-erpc-context}"
ERPC_UPSTREAM_REPO_DIR="${ERPC_UPSTREAM_REPO_DIR:-${ERPC_CONTEXT_DIR}/upstream-repo}"
ERPC_UPSTREAM_REPO_URL="${ERPC_UPSTREAM_REPO_URL:-https://github.com/0x666c6f/erpc}"
ERPC_FULL_CONTEXT_ENABLED="${ERPC_FULL_CONTEXT_ENABLED:-0}"
ERPC_VAULT_ADDR="${ERPC_VAULT_ADDR:-https://config.morpho.dev}"
ERPC_VAULT_MOUNT="${ERPC_VAULT_MOUNT:-secret}"
ERPC_VAULT_KEY="${ERPC_VAULT_KEY:-erpc/config}"
ERPC_VAULT_AUTH_PATH="${ERPC_VAULT_AUTH_PATH:-auth/kubernetes}"
ERPC_VAULT_ROLE="${ERPC_VAULT_ROLE:-incident-readonly-agent}"
ERPC_VAULT_JWT_FILE="${ERPC_VAULT_JWT_FILE:-}"
MORPHO_INFRA_DIR="${MORPHO_INFRA_DIR:-/srv/openclaw/repos/morpho-infra}"
MORPHO_INFRA_HELM_DIR="${MORPHO_INFRA_HELM_DIR:-/srv/openclaw/repos/morpho-infra-helm}"

SUMMARY_FILE="${ERPC_CONTEXT_DIR}/summary.md"
STATUS_FILE="${ERPC_CONTEXT_DIR}/status.tsv"
METRICS_FILE="${ERPC_CONTEXT_DIR}/metrics.tsv"
CONFIG_FILE="${ERPC_CONTEXT_DIR}/prod-config.redacted.yaml"
ERRORS_DIR="${ERPC_CONTEXT_DIR}/errors"
REF_DIR="${ERPC_CONTEXT_DIR}/references"
UPSTREAM_DOCS_DIR="${REF_DIR}/upstream"
MORPHO_DOCS_DIR="${REF_DIR}/morpho"

mkdir -p "$ERPC_CONTEXT_DIR" "$ERRORS_DIR" "$UPSTREAM_DOCS_DIR" "$MORPHO_DOCS_DIR"

printf 'source\tstatus\tdetail\n' >"$STATUS_FILE"

status_add() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STATUS_FILE"
}

error_snippet() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf 'unknown error'
    return 0
  fi
  sed -n '1,10p' "$file" \
    | tr '\n' ' ' \
    | tr '\t' ' ' \
    | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

copy_excerpt() {
  local src="$1"
  local dest="$2"
  local end_line="${3:-0}"

  if [[ ! -f "$src" ]]; then
    return 1
  fi

  if [[ "$end_line" =~ ^[0-9]+$ ]] && [[ "$end_line" -gt 0 ]]; then
    sed -n "1,${end_line}p" "$src" >"$dest"
  else
    cat "$src" >"$dest"
  fi
}

redact_config_stream() {
  sed -E \
    -e 's#([?&]secret=)[^&[:space:]]+#\1<redacted>#g' \
    -e 's#([?&](api[-_]?key|token|password|passwd)=)[^&[:space:]]+#\1<redacted>#gI' \
    -e 's#(Bearer )[A-Za-z0-9._~+/-]+=*#\1<redacted>#g' \
    -e '/^[[:space:]]*[^#[:space:]][^:]*([Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt][_-]?[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][_-]?[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn])[^:]*:/ s#^([[:space:]]*[^:]+:[[:space:]]*).*$#\1<redacted>#' \
    -e '/^[[:space:]]*-[[:space:]]*(token|secret|password|passwd|api[-_]?key|client[-_]?secret|private[-_]?key)[[:space:]]*:/I s#^([[:space:]]*-[[:space:]]*[^:]+:[[:space:]]*).*$#\1<redacted>#'
}

detect_vault_jwt_file() {
  local candidate
  for candidate in \
    "$ERPC_VAULT_JWT_FILE" \
    /var/run/secrets/kubernetes.io/serviceaccount/token \
    /var/run/secrets/eks.amazonaws.com/serviceaccount/token
  do
    [[ -n "$candidate" ]] || continue
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

ensure_vault_token() {
  local err_file="${ERRORS_DIR}/vault-auth.err"
  if [[ "$ERPC_FULL_CONTEXT_ENABLED" != "1" ]]; then
    status_add "vault_auth" "skipped" "full_context_disabled"
    return 1
  fi

  if [[ -n "${VAULT_TOKEN:-}" ]]; then
    status_add "vault_auth" "ok" "method=env-token"
    return 0
  fi

  if ! command -v vault >/dev/null 2>&1; then
    status_add "vault_auth" "failed" "vault cli not installed and VAULT_TOKEN unset"
    return 1
  fi

  local jwt_file=""
  if ! jwt_file="$(detect_vault_jwt_file)"; then
    status_add "vault_auth" "failed" "VAULT_TOKEN unset and no service-account jwt file found"
    return 1
  fi

  local token=""
  if token="$(vault write \
    -address="$ERPC_VAULT_ADDR" \
    -field=token \
    "${ERPC_VAULT_AUTH_PATH}/login" \
    role="$ERPC_VAULT_ROLE" \
    jwt=@"$jwt_file" \
    2>"$err_file")" && [[ -n "$token" ]]; then
    export VAULT_TOKEN="$token"
    status_add "vault_auth" "ok" "method=kubernetes role=${ERPC_VAULT_ROLE} jwt_file=${jwt_file}"
    return 0
  fi

  status_add "vault_auth" "failed" "$(error_snippet "$err_file")"
  return 1
}

fetch_vault_config() {
  local err_file="${ERRORS_DIR}/vault-config.err"
  if ! ensure_vault_token; then
    : >"$CONFIG_FILE"
    if [[ "$ERPC_FULL_CONTEXT_ENABLED" != "1" ]]; then
      status_add "vault_config" "skipped" "full_context_disabled"
    fi
    return 0
  fi
  if vault kv get \
    -address="$ERPC_VAULT_ADDR" \
    -mount="$ERPC_VAULT_MOUNT" \
    -field=config \
    "$ERPC_VAULT_KEY" \
    2>"$err_file" \
    | redact_config_stream >"$CONFIG_FILE"; then
    local lines
    lines="$(wc -l <"$CONFIG_FILE" | tr -d ' ')"
    status_add "vault_config" "ok" "config=${ERPC_VAULT_MOUNT}/${ERPC_VAULT_KEY} field=config redacted_lines=${lines}"
  else
    : >"$CONFIG_FILE"
    status_add "vault_config" "failed" "$(error_snippet "$err_file")"
  fi
}

ensure_upstream_repo() {
  local err_file="${ERRORS_DIR}/upstream-repo.err"
  local detail=""

  if [[ -d "${ERPC_UPSTREAM_REPO_DIR}/.git" ]]; then
    if git -C "$ERPC_UPSTREAM_REPO_DIR" fetch --depth=1 origin >"$err_file" 2>&1 \
      && git -C "$ERPC_UPSTREAM_REPO_DIR" checkout --detach FETCH_HEAD >>"$err_file" 2>&1; then
      detail="updated from origin"
    else
      detail="using existing checkout; update failed: $(error_snippet "$err_file")"
    fi
  else
    if [[ -e "$ERPC_UPSTREAM_REPO_DIR" ]] && [[ -n "$(find "$ERPC_UPSTREAM_REPO_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]]; then
      status_add "upstream_repo" "failed" "path exists and is not an empty git repo: ${ERPC_UPSTREAM_REPO_DIR}"
      return 1
    fi
    if git clone --depth=1 "$ERPC_UPSTREAM_REPO_URL" "$ERPC_UPSTREAM_REPO_DIR" >"$err_file" 2>&1; then
      :
    else
      status_add "upstream_repo" "failed" "$(error_snippet "$err_file")"
      return 1
    fi
    detail="cloned fresh repo"
  fi

  local commit
  commit="$(git -C "$ERPC_UPSTREAM_REPO_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')"
  status_add "upstream_repo" "ok" "repo=${ERPC_UPSTREAM_REPO_DIR} commit=${commit} ${detail}"
}

extract_metrics_catalog() {
  local src="${ERPC_UPSTREAM_REPO_DIR}/telemetry/metrics.go"
  if [[ ! -f "$src" ]]; then
    : >"$METRICS_FILE"
    status_add "metrics_catalog" "failed" "missing telemetry source: ${src}"
    return 1
  fi

  awk '
    BEGIN {
      print "metric\ttype\thelp\tlabels"
    }
    function flush_metric() {
      if (name != "") {
        gsub(/"/, "", labels)
        gsub(/[[:space:]]+/, "", labels)
        printf "erpc_%s\t%s\t%s\t%s\n", name, metric_type, help, labels
      }
      metric_type = ""
      name = ""
      help = ""
      labels = ""
    }
    /^[[:space:]]*Metric[A-Za-z0-9_]+[[:space:]]*=/ {
      flush_metric()
    }
    /NewCounterVec\(/ { metric_type = "counter" }
    /NewGaugeVec\(/ { metric_type = "gauge" }
    /NewHistogramVec\(/ { metric_type = "histogram" }
    /Name:[[:space:]]*"/ {
      line = $0
      sub(/.*Name:[[:space:]]*"/, "", line)
      sub(/".*/, "", line)
      name = line
    }
    /Help:[[:space:]]*"/ {
      line = $0
      sub(/.*Help:[[:space:]]*"/, "", line)
      sub(/".*/, "", line)
      help = line
    }
    /\}, \[]string\{/ {
      line = $0
      sub(/.*\}, \[]string\{/, "", line)
      sub(/\}.*/, "", line)
      labels = line
    }
    END {
      flush_metric()
    }
  ' "$src" >"$METRICS_FILE"

  local count
  count="$(( $(wc -l <"$METRICS_FILE") - 1 ))"
  status_add "metrics_catalog" "ok" "file=${METRICS_FILE} count=${count}"
}

write_reference_bundle() {
  local missing=0

  copy_excerpt "${ERPC_UPSTREAM_REPO_DIR}/docs/pages/operation/monitoring.mdx" "${UPSTREAM_DOCS_DIR}/monitoring.mdx" 220 || missing=1
  copy_excerpt "${ERPC_UPSTREAM_REPO_DIR}/docs/pages/config/example.mdx" "${UPSTREAM_DOCS_DIR}/config-example.mdx" 260 || missing=1
  copy_excerpt "${ERPC_UPSTREAM_REPO_DIR}/docs/pages/config/projects/upstreams.mdx" "${UPSTREAM_DOCS_DIR}/config-upstreams.mdx" 260 || missing=1
  copy_excerpt "${ERPC_UPSTREAM_REPO_DIR}/telemetry/metrics.go" "${UPSTREAM_DOCS_DIR}/telemetry-metrics.go" 420 || missing=1
  copy_excerpt "${ERPC_UPSTREAM_REPO_DIR}/common/config.go" "${UPSTREAM_DOCS_DIR}/common-config.go" 260 || missing=1

  copy_excerpt "${MORPHO_INFRA_DIR}/docs/architecture/erpc.md" "${MORPHO_DOCS_DIR}/architecture-erpc.md" 260 || missing=1
  copy_excerpt "${MORPHO_INFRA_DIR}/docs/operations/erpc-operations.md" "${MORPHO_DOCS_DIR}/operations-erpc.md" 320 || missing=1
  copy_excerpt "${MORPHO_INFRA_HELM_DIR}/environments/prd/erpc/values.yaml" "${MORPHO_DOCS_DIR}/prd-values.yaml" 430 || missing=1
  copy_excerpt "${MORPHO_INFRA_HELM_DIR}/charts/erpc/templates/job-vault-config.yaml" "${MORPHO_DOCS_DIR}/vault-config-template.yaml" 120 || missing=1

  if [[ "$missing" -eq 0 ]]; then
    status_add "reference_bundle" "ok" "dir=${REF_DIR}"
  else
    status_add "reference_bundle" "warn" "one or more reference files missing; see ${REF_DIR}"
  fi
}

write_summary() {
  local repo_commit
  repo_commit="$(git -C "$ERPC_UPSTREAM_REPO_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')"
  local metrics_count="0"
  if [[ -f "$METRICS_FILE" ]]; then
    metrics_count="$(( $(wc -l <"$METRICS_FILE") - 1 ))"
  fi

  cat >"$SUMMARY_FILE" <<EOF
# eRPC Context Bundle

- generated_at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- bundle_dir: ${ERPC_CONTEXT_DIR}
- upstream_repo: ${ERPC_UPSTREAM_REPO_DIR}
- upstream_commit: ${repo_commit}
- metrics_count: ${metrics_count}
- full_context_enabled: ${ERPC_FULL_CONTEXT_ENABLED}
- vault_source: ${ERPC_VAULT_ADDR} ${ERPC_VAULT_MOUNT}/${ERPC_VAULT_KEY} field=config
- metrics_endpoint_shape: /metrics on port 4001 (see references/morpho/prd-values.yaml and references/upstream/monitoring.mdx)

## Use This First For Morpho eRPC Questions

1. Read \`status.tsv\`.
2. If \`vault_config\tok\`, inspect \`prod-config.redacted.yaml\` for current prod config.
3. If \`vault_config\tskipped\tfull_context_disabled\`, this bot is policy-limited to non-Vault context. Continue with Helm values + docs + code only.
4. For config semantics and defaults, inspect:
   - \`references/upstream/common-config.go\`
   - \`references/upstream/config-example.mdx\`
   - \`references/upstream/config-upstreams.mdx\`
5. For metrics, inspect:
   - \`metrics.tsv\`
   - \`references/upstream/monitoring.mdx\`
   - \`references/upstream/telemetry-metrics.go\`
6. For Morpho deployment/runtime specifics, inspect:
   - \`references/morpho/architecture-erpc.md\`
   - \`references/morpho/operations-erpc.md\`
   - \`references/morpho/prd-values.yaml\`
   - \`references/morpho/vault-config-template.yaml\`
7. If deeper code behavior matters, search the local repo cache:
   - \`${ERPC_UPSTREAM_REPO_DIR}\`

## Guardrails

- Never print raw secrets or token values.
- Full Vault-backed eRPC context is prod-only. Non-prd bots must stay on docs/code/Helm references.
- Use \`prod-config.redacted.yaml\`; do not quote the raw Vault payload.
- If Vault access fails, say so explicitly and continue with Helm values + upstream docs/code.
- For metrics questions, prefer \`metrics.tsv\` + telemetry source over memory/guessing.
EOF
}

fetch_vault_config || true
ensure_upstream_repo || true
extract_metrics_catalog || true
write_reference_bundle || true
write_summary

if [[ "$PRINT_DIR" -eq 1 ]]; then
  printf '%s\n' "$ERPC_CONTEXT_DIR"
fi

if [[ "$PRINT_SUMMARY" -eq 1 ]]; then
  cat "$SUMMARY_FILE"
else
  printf 'eRPC context bundle ready: %s\n' "$ERPC_CONTEXT_DIR"
  printf 'summary: %s\n' "$SUMMARY_FILE"
  printf 'status: %s\n' "$STATUS_FILE"
fi
