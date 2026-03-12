#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

OUTPUT_DIR="${OUTPUT_DIR:-${RELATIONSHIP_KNOWLEDGE_OUTPUT_DIR:-/tmp/openclaw-relationship-knowledge}}"
MAIN_OUTPUT_FILE="${OUTPUT_DIR}/initial-knowledge.v1.json"
NODES_OUTPUT_FILE="${OUTPUT_DIR}/nodes.ndjson"
EDGES_OUTPUT_FILE="${OUTPUT_DIR}/edges.ndjson"

MORPHO_INFRA_DIR="${MORPHO_INFRA_DIR:-/srv/openclaw/repos/morpho-infra}"
MORPHO_INFRA_HELM_DIR="${MORPHO_INFRA_HELM_DIR:-/srv/openclaw/repos/morpho-infra-helm}"
COMMONS_TFVARS="${COMMONS_TFVARS:-${MORPHO_INFRA_DIR}/projects/commons/variables.auto.tfvars}"
ECR_REGISTRY="${ECR_REGISTRY:-537124939463.dkr.ecr.eu-west-3.amazonaws.com}"
HELM_LINEAGE_TRACKER_ENABLED="${HELM_LINEAGE_TRACKER_ENABLED:-0}"
HELM_LINEAGE_TRACKER_SCRIPT="${HELM_LINEAGE_TRACKER_SCRIPT:-${SCRIPT_DIR}/helm-lineage-tracker.sh}"
HELM_LINEAGE_RENDERED_FILE="${HELM_LINEAGE_RENDERED_FILE:-}"
HELM_LINEAGE_LIVE_FILE="${HELM_LINEAGE_LIVE_FILE:-}"
HELM_LINEAGE_VALUES_FILE="${HELM_LINEAGE_VALUES_FILE:-}"

GITHUB_ORG="${GITHUB_ORG:-morpho-org}"
AWS_RESOURCE_SIGNALS_SCRIPT="${AWS_RESOURCE_SIGNALS_SCRIPT:-${SCRIPT_DIR}/aws-resource-signals.sh}"

SRC_INFRA="infra_tfvars"
SRC_K8S="kubernetes_pods"
SRC_AWS="aws_resource_signals"
SRC_GH="github_org_repositories"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

NODE_KEYS_FILE="${TMP_DIR}/node-keys.txt"
EDGE_KEYS_FILE="${TMP_DIR}/edge-keys.txt"
NODES_RAW_FILE="${TMP_DIR}/nodes-raw.ndjson"
EDGES_RAW_FILE="${TMP_DIR}/edges-raw.ndjson"
REPO_SIGNAL_FILE="${TMP_DIR}/repo-signals.txt"
GH_REPO_FILE="${TMP_DIR}/gh-repos.txt"
ECR_MAP_FILE="${TMP_DIR}/ecr-map.tsv"

: >"$NODE_KEYS_FILE"
: >"$EDGE_KEYS_FILE"
: >"$NODES_RAW_FILE"
: >"$EDGES_RAW_FILE"
: >"$REPO_SIGNAL_FILE"
: >"$GH_REPO_FILE"
: >"$ECR_MAP_FILE"

S_INFRA_STATUS="unknown"; S_INFRA_ERROR=""; S_INFRA_DETAIL=""; S_INFRA_NODES=0; S_INFRA_EDGES=0
S_K8S_STATUS="unknown"; S_K8S_ERROR=""; S_K8S_DETAIL=""; S_K8S_NODES=0; S_K8S_EDGES=0
S_AWS_STATUS="unknown"; S_AWS_ERROR=""; S_AWS_DETAIL=""; S_AWS_NODES=0; S_AWS_EDGES=0
S_GH_STATUS="unknown"; S_GH_ERROR=""; S_GH_DETAIL=""; S_GH_NODES=0; S_GH_EDGES=0

usage() {
  cat <<'EOF_USAGE'
Usage:
  relationship-knowledge-build.sh [--output-dir <path>]

Outputs:
  <output-dir>/initial-knowledge.v1.json
  <output-dir>/nodes.ndjson
  <output-dir>/edges.ndjson
EOF_USAGE
}

esc() {
  local v="${1-}"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//$'\n'/\\n}"
  v="${v//$'\r'/\\r}"
  v="${v//$'\t'/\\t}"
  printf '%s' "$v"
}

lower() { printf '%s' "${1-}" | tr '[:upper:]' '[:lower:]'; }

sid() {
  printf '%s' "${1-}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's#[^a-z0-9._:@/-]+#-#g; s#-+#-#g; s#^[-/]+##; s#[-/]+$##'
}

repo_slug() {
  local v="${1-}"
  v="$(printf '%s' "$v" | sed -E 's#^https?://github\.com/##; s#\.git$##; s#^/+##; s#/+$##')"
  v="$(lower "$v")"
  if [[ "$v" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
    printf '%s\n' "$v"
  fi
}

image_repo() {
  local image="${1-}"
  image="${image%@sha256:*}"
  if [[ "${image##*/}" == *:* ]]; then
    image="${image%:*}"
  fi
  printf '%s\n' "$image"
}

id_org() { printf 'github-org:%s\n' "$(sid "$1")"; }
id_repo() { printf 'repo:%s\n' "$(sid "$1")"; }
id_cluster() { printf 'k8s-cluster:%s\n' "$(sid "$1")"; }
id_workload() { printf 'k8s-pod:%s/%s\n' "$(sid "$1")" "$(sid "$2")"; }
id_imgrepo() { printf 'image-repo:%s\n' "$(sid "$1")"; }
id_aws_resource() { printf 'aws-resource:%s/%s\n' "$(sid "$1")" "$(sid "$2")"; }
id_aws_signal() {
  local d
  d="$(printf '%s' "${3}|${4}" | cksum | awk '{print $1}')"
  printf 'aws-signal:%s/%s/%s\n' "$(sid "$1")" "$(sid "$2")" "$(sid "$d")"
}

src_prefix() {
  case "$1" in
    "$SRC_INFRA") printf 'S_INFRA' ;;
    "$SRC_K8S") printf 'S_K8S' ;;
    "$SRC_AWS") printf 'S_AWS' ;;
    "$SRC_GH") printf 'S_GH' ;;
    *) printf '' ;;
  esac
}

src_set() {
  local p
  p="$(src_prefix "$1")"
  [[ -n "$p" ]] || return 0
  eval "${p}_STATUS=\"\$2\""
  eval "${p}_ERROR=\"\$3\""
  eval "${p}_DETAIL=\"\$4\""
}

src_inc_nodes() { local p; p="$(src_prefix "$1")"; [[ -n "$p" ]] || return 0; eval "${p}_NODES=\$(( ${p}_NODES + 1 ))"; }
src_inc_edges() { local p; p="$(src_prefix "$1")"; [[ -n "$p" ]] || return 0; eval "${p}_EDGES=\$(( ${p}_EDGES + 1 ))"; }

line_has() { grep -F -x -q -- "$2" "$1" 2>/dev/null; }

line_add_unique() {
  [[ -n "${2-}" ]] || return 0
  if ! line_has "$1" "$2"; then
    printf '%s\n' "$2" >>"$1"
  fi
}

node_add_raw() {
  if ! line_has "$NODE_KEYS_FILE" "$1"; then
    printf '%s\n' "$1" >>"$NODE_KEYS_FILE"
    printf '%s\n' "$2" >>"$NODES_RAW_FILE"
    src_inc_nodes "$3"
  fi
}

edge_add_raw() {
  if ! line_has "$EDGE_KEYS_FILE" "$1"; then
    printf '%s\n' "$1" >>"$EDGE_KEYS_FILE"
    printf '%s\n' "$2" >>"$EDGES_RAW_FILE"
    src_inc_edges "$3"
  fi
}

jpair() { printf '"%s":"%s"' "$(esc "$1")" "$(esc "$2")"; }

node_add() {
  local id="$1" type="$2" name="$3" source_kind="$4" extra_json="$5" source="$6"
  local json
  json="{\"id\":\"$(esc "$id")\",\"type\":\"$(esc "$type")\",\"name\":\"$(esc "$name")\",\"source\":\"$(esc "$source_kind")\""
  if [[ -n "$extra_json" ]]; then
    json="${json},${extra_json}"
  fi
  json="${json}}"
  node_add_raw "$id" "$json" "$source"
}

edge_add() {
  local source_id="$1" edge_type="$2" target_id="$3" source="$4" source_kind="$5" notes="${6-}"
  local key edge_id json
  [[ -n "$source_id" && -n "$target_id" ]] || return 0
  case "$edge_type" in
    owns_repository)
      edge_type="owned_by"
      local original_source="$source_id"
      source_id="$target_id"
      target_id="$original_source"
      ;;
    related_repository)
      edge_type="references"
      ;;
    builds_image_repo)
      edge_type="emits"
      ;;
    contains_workload)
      edge_type="belongs_to"
      local original_source="$source_id"
      source_id="$target_id"
      target_id="$original_source"
      ;;
    runs_image_repo)
      edge_type="deploys"
      ;;
    implemented_by_repository|backed_by_repository)
      edge_type="defined_in"
      ;;
    has_signal)
      edge_type="emits"
      ;;
    represents_image_repo)
      edge_type="references"
      ;;
  esac
  key="${source_id}|${edge_type}|${target_id}"
  edge_id="edge:$(sid "$key")"
  json="{\"id\":\"$(esc "$edge_id")\",\"source\":\"$(esc "$source_id")\",\"type\":\"$(esc "$edge_type")\",\"target\":\"$(esc "$target_id")\",\"source_kind\":\"$(esc "$source_kind")\",\"notes\":\"$(esc "$notes")\"}"
  edge_add_raw "$key" "$json" "$source"
}

add_repo_signal() { line_add_unique "$REPO_SIGNAL_FILE" "$1"; }
add_gh_repo() { line_add_unique "$GH_REPO_FILE" "$1"; }

gh_repo_has() { line_has "$GH_REPO_FILE" "$1"; }

ecr_map_add() {
  if ! awk -F'\t' -v k="$1" '$1==k{f=1} END{exit f?0:1}' "$ECR_MAP_FILE" >/dev/null 2>&1; then
    printf '%s\t%s\n' "$1" "$2" >>"$ECR_MAP_FILE"
  fi
}

ecr_map_get() { awk -F'\t' -v k="$1" '$1==k{print $2; exit}' "$ECR_MAP_FILE"; }

map_image_to_repo() {
  local img_repo="$1" repo="" src="" ecr="" name=""

  if [[ "$img_repo" == "${ECR_REGISTRY}/"* ]]; then
    ecr="${img_repo#${ECR_REGISTRY}/}"; ecr="${ecr%%/*}"
    repo="$(ecr_map_get "$ecr" || true)"
    if [[ -n "$repo" ]]; then
      src="commons-ecr-mapping"
    elif gh_repo_has "${GITHUB_ORG}/${ecr}"; then
      repo="${GITHUB_ORG}/${ecr}"
      src="commons-github-list-heuristic"
    else
      repo="${GITHUB_ORG}/${ecr}"
      src="ecr-name-heuristic"
    fi
  elif [[ "$img_repo" == morphoorg/* ]]; then
    name="${img_repo#morphoorg/}"
    repo="${GITHUB_ORG}/${name}"
    src="dockerhub-morpho-heuristic"
  elif [[ "$img_repo" == ghcr.io/"${GITHUB_ORG}"/* ]]; then
    name="${img_repo#ghcr.io/${GITHUB_ORG}/}"; name="${name%%/*}"
    repo="${GITHUB_ORG}/${name}"
    src="ghcr-morpho-heuristic"
  else
    repo="${GITHUB_ORG}/morpho-infra"
    src="infra-source-of-truth"
  fi

  repo="$(repo_slug "$repo" || true)"
  if [[ -z "$repo" ]]; then
    repo="${GITHUB_ORG}/morpho-infra"
    src="infra-source-of-truth"
  fi
  printf '%s\t%s\n' "$repo" "$src"
}

extract_github_repositories() {
  awk '
    /github_repositories[[:space:]]*=[[:space:]]*\[/ {in_list=1; next}
    in_list && /\]/ {in_list=0}
    in_list && match($0, /"([^"]+)"/) {
      print substr($0, RSTART+1, RLENGTH-2)
    }
  ' "$1" 2>/dev/null || true
}

extract_ecr_repository_mapping() {
  awk '
    /ecr_repository_mapping[[:space:]]*=[[:space:]]*\{/ {in_map=1; next}
    in_map && /\}/ {in_map=0}
    in_map && match($0, /"[^"]+"[[:space:]]*=[[:space:]]*"[^"]+"/) {
      pair=substr($0, RSTART, RLENGTH)
      split(pair, p, "=")
      gsub(/^[[:space:]]*"/, "", p[1]); gsub(/"[[:space:]]*$/, "", p[1])
      gsub(/^[[:space:]]*"/, "", p[2]); gsub(/"[[:space:]]*$/, "", p[2])
      print p[1] "\t" p[2]
    }
  ' "$1" 2>/dev/null || true
}

collect_infra() {
  local src="$SRC_INFRA" infra_repo="${GITHUB_ORG}/morpho-infra" helm_repo="${GITHUB_ORG}/morpho-infra-helm"
  local org_id infra_id helm_id rcount=0 mcount=0 repo ecr

  org_id="$(id_org "$GITHUB_ORG")"
  infra_id="$(id_repo "$infra_repo")"
  helm_id="$(id_repo "$helm_repo")"

  node_add "$org_id" "github_organization" "$(sid "$GITHUB_ORG")" "infra-bootstrap" "$(jpair org_slug "$(sid "$GITHUB_ORG")")" "$src"

  add_repo_signal "$(repo_slug "$infra_repo" || true)"
  add_repo_signal "$(repo_slug "$helm_repo" || true)"

  node_add "$infra_id" "github_repository" "$infra_repo" "infra-bootstrap" "$(jpair repo_slug "$infra_repo"),$(jpair local_path "$MORPHO_INFRA_DIR")" "$src"
  node_add "$helm_id" "github_repository" "$helm_repo" "infra-bootstrap" "$(jpair repo_slug "$helm_repo"),$(jpair local_path "$MORPHO_INFRA_HELM_DIR")" "$src"

  edge_add "$org_id" "owns_repository" "$infra_id" "$src" "infra-bootstrap" ""
  edge_add "$org_id" "owns_repository" "$helm_id" "$src" "infra-bootstrap" ""
  edge_add "$infra_id" "related_repository" "$helm_id" "$src" "infra-bootstrap" ""

  if [[ ! -f "$COMMONS_TFVARS" ]]; then
    src_set "$src" "degraded" "missing_commons_tfvars:${COMMONS_TFVARS}" "bootstrap_only"
    return 0
  fi

  while IFS= read -r repo; do
    repo="$(repo_slug "$repo" || true)"
    [[ -n "$repo" ]] || continue
    rcount=$((rcount + 1))
    add_repo_signal "$repo"
    add_gh_repo "$repo"
    node_add "$(id_repo "$repo")" "github_repository" "$repo" "commons-github_repositories" "$(jpair repo_slug "$repo"),$(jpair local_path "")" "$src"
    edge_add "$infra_id" "declares_repository" "$(id_repo "$repo")" "$src" "commons-tfvars" "github_repositories"
  done < <(extract_github_repositories "$COMMONS_TFVARS")

  while IFS=$'\t' read -r repo ecr; do
    repo="$(repo_slug "$repo" || true)"
    ecr="$(lower "$ecr" | sed -E 's#^[[:space:]]+##; s#[[:space:]]+$##')"
    [[ -n "$repo" && -n "$ecr" ]] || continue
    mcount=$((mcount + 1))
    add_repo_signal "$repo"
    ecr_map_add "$ecr" "$repo"
    node_add "$(id_repo "$repo")" "github_repository" "$repo" "commons-ecr_repository_mapping" "$(jpair repo_slug "$repo"),$(jpair local_path "")" "$src"
    node_add "$(id_imgrepo "${ECR_REGISTRY}/${ecr}")" "container_image_repository" "${ECR_REGISTRY}/${ecr}" "commons-ecr_repository_mapping" "$(jpair image_repo "${ECR_REGISTRY}/${ecr}")" "$src"
    edge_add "$(id_repo "$repo")" "builds_image_repo" "$(id_imgrepo "${ECR_REGISTRY}/${ecr}")" "$src" "commons-ecr_repository_mapping" "ecr_repository_mapping"
  done < <(extract_ecr_repository_mapping "$COMMONS_TFVARS")

  local lineage_detail=""
  if [[ "$HELM_LINEAGE_TRACKER_ENABLED" == "1" && -x "$HELM_LINEAGE_TRACKER_SCRIPT" ]] && command -v jq >/dev/null 2>&1; then
    local lineage_output lineage_reports
    local -a lineage_args=()
    [[ -n "$HELM_LINEAGE_RENDERED_FILE" ]] && lineage_args+=(--rendered-file "$HELM_LINEAGE_RENDERED_FILE")
    [[ -n "$HELM_LINEAGE_LIVE_FILE" ]] && lineage_args+=(--live-file "$HELM_LINEAGE_LIVE_FILE")
    [[ -n "$MORPHO_INFRA_HELM_DIR" ]] && lineage_args+=(--repo "$MORPHO_INFRA_HELM_DIR")
    [[ -n "$HELM_LINEAGE_VALUES_FILE" ]] && lineage_args+=(--values-file "$HELM_LINEAGE_VALUES_FILE")
    lineage_output="$("$HELM_LINEAGE_TRACKER_SCRIPT" "${lineage_args[@]}" 2>/dev/null || true)"
    lineage_reports="$(printf '%s\n' "$lineage_output" | jq -r '(.reports // []) | length' 2>/dev/null || printf '0')"
    lineage_detail=";lineage_reports=${lineage_reports}"
  fi

  if [[ "$rcount" -eq 0 && "$mcount" -eq 0 ]]; then
    src_set "$src" "degraded" "commons_tfvars_empty_or_unparsed" "file=${COMMONS_TFVARS}"
  else
    src_set "$src" "ok" "" "file=${COMMONS_TFVARS};github_repositories=${rcount};ecr_repository_mapping=${mcount}${lineage_detail}"
  fi
}

collect_k8s() {
  local src="$SRC_K8S" context="unknown" errf pods row_count=0 ns pod image wrk_id img map repo ms

  if ! command -v kubectl >/dev/null 2>&1; then src_set "$src" "unavailable" "missing_kubectl" "source_skipped"; return 0; fi
  if ! command -v jq >/dev/null 2>&1; then src_set "$src" "unavailable" "missing_jq_for_kubectl_json_parse" "source_skipped"; return 0; fi

  context="$(kubectl config current-context 2>/dev/null || true)"; [[ -n "$context" ]] || context="unknown"
  node_add "$(id_cluster "$context")" "k8s_cluster" "$context" "kubectl" "$(jpair context "$context")" "$src"

  errf="$(mktemp)"
  if ! pods="$(kubectl get pods -A -o json 2>"$errf")"; then
    src_set "$src" "unavailable" "kubectl_get_pods_failed:$(head -n1 "$errf" | tr '\t' ' ')" "context=${context}"
    rm -f "$errf"
    return 0
  fi
  rm -f "$errf"

  if ! printf '%s\n' "$pods" | jq -e . >/dev/null 2>&1; then
    src_set "$src" "degraded" "kubectl_output_not_json" "context=${context}"
    return 0
  fi

  while IFS=$'\t' read -r ns pod image; do
    [[ -n "${ns:-}" && -n "${pod:-}" && -n "${image:-}" ]] || continue
    row_count=$((row_count + 1))

    wrk_id="$(id_workload "$ns" "$pod")"
    node_add "$wrk_id" "k8s_pod" "${ns}/${pod}" "kubectl" "$(jpair namespace "$ns"),$(jpair pod "$pod"),$(jpair cluster_context "$context")" "$src"
    edge_add "$(id_cluster "$context")" "contains_workload" "$wrk_id" "$src" "kubectl" ""

    img="$(image_repo "$image")"
    [[ -n "$img" ]] || continue
    node_add "$(id_imgrepo "$img")" "container_image_repository" "$img" "kubectl" "$(jpair image_repo "$img")" "$src"
    edge_add "$wrk_id" "runs_image_repo" "$(id_imgrepo "$img")" "$src" "kubectl" "image=${image}"

    map="$(map_image_to_repo "$img")"
    repo="${map%%$'\t'*}"; ms="${map#*$'\t'}"
    add_repo_signal "$repo"
    node_add "$(id_repo "$repo")" "github_repository" "$repo" "$ms" "$(jpair repo_slug "$repo"),$(jpair local_path "")" "$src"
    edge_add "$(id_imgrepo "$img")" "implemented_by_repository" "$(id_repo "$repo")" "$src" "$ms" ""
    edge_add "$wrk_id" "backed_by_repository" "$(id_repo "$repo")" "$src" "$ms" ""
  done < <(
    printf '%s\n' "$pods" | jq -r '
      .items[]?
      | .metadata.namespace as $ns
      | .metadata.name as $pod
      | ([.spec.containers[]?.image, .spec.initContainers[]?.image] | .[]) as $image
      | [$ns, $pod, $image]
      | @tsv
    ' 2>/dev/null | sort -u
  )

  if [[ "$row_count" -eq 0 ]]; then
    src_set "$src" "degraded" "no_pod_images_found" "context=${context}"
  else
    src_set "$src" "ok" "" "context=${context};workload_images=${row_count}"
  fi
}

collect_aws() {
  local src="$SRC_AWS" out="" errf rc=0 rows=0 actionable_rows=0 rt rid st util notes rnode snode img map repo ms

  if [[ ! -f "$AWS_RESOURCE_SIGNALS_SCRIPT" ]]; then
    src_set "$src" "unavailable" "missing_aws_resource_signals_script:${AWS_RESOURCE_SIGNALS_SCRIPT}" "source_skipped"
    return 0
  fi

  errf="$(mktemp)"
  if ! out="$(bash "$AWS_RESOURCE_SIGNALS_SCRIPT" 2>"$errf")"; then rc=$?; fi

  while IFS=$'\t' read -r rt rid st util notes; do
    [[ -n "${rt:-}" && -n "${rid:-}" ]] || continue
    rows=$((rows + 1))
    if [[ "$rt" != "collector" && "$rt" != "aws_auth" ]]; then
      actionable_rows=$((actionable_rows + 1))
    fi

    rnode="$(id_aws_resource "$rt" "$rid")"
    snode="$(id_aws_signal "$rt" "$rid" "${st:-unknown}" "${notes:-}")"

    node_add "$rnode" "aws_resource" "${rt}/${rid}" "aws-resource-signals" "$(jpair resource_type "$rt"),$(jpair resource_id "$rid")" "$src"
    node_add "$snode" "aws_signal" "${rt}/${rid}" "aws-resource-signals" "$(jpair resource_type "$rt"),$(jpair resource_id "$rid"),$(jpair status "${st:-unknown}"),$(jpair notes "${notes:-}")" "$src"
    edge_add "$rnode" "has_signal" "$snode" "$src" "aws-resource-signals" "status=${st:-unknown}"

    if [[ "$(lower "$rt")" == *"ecr"* ]]; then
      img="${ECR_REGISTRY}/${rid}"
      node_add "$(id_imgrepo "$img")" "container_image_repository" "$img" "aws-resource-signals-ecr" "$(jpair image_repo "$img")" "$src"
      edge_add "$rnode" "represents_image_repo" "$(id_imgrepo "$img")" "$src" "aws-resource-signals-ecr" ""
      map="$(map_image_to_repo "$img")"
      repo="${map%%$'\t'*}"; ms="${map#*$'\t'}"
      add_repo_signal "$repo"
      node_add "$(id_repo "$repo")" "github_repository" "$repo" "$ms" "$(jpair repo_slug "$repo"),$(jpair local_path "")" "$src"
      edge_add "$(id_imgrepo "$img")" "implemented_by_repository" "$(id_repo "$repo")" "$src" "$ms" ""
    fi
  done < <(printf '%s\n' "$out" | awk 'NR>1 && NF>0 { print }')

  if [[ "$rows" -eq 0 ]]; then
    src_set "$src" "degraded" "no_aws_signal_rows:$(head -n1 "$errf" | tr '\t' ' ')" "script=${AWS_RESOURCE_SIGNALS_SCRIPT}"
    rm -f "$errf"
    return 0
  fi

  if [[ "$actionable_rows" -eq 0 ]]; then
    src_set "$src" "degraded" "no_actionable_aws_resources" "rows=${rows};script=${AWS_RESOURCE_SIGNALS_SCRIPT}"
    rm -f "$errf"
    return 0
  fi

  if [[ "$rc" -ne 0 ]]; then
    src_set "$src" "degraded" "aws_resource_signals_exit_${rc}:$(head -n1 "$errf" | tr '\t' ' ')" "rows=${rows};script=${AWS_RESOURCE_SIGNALS_SCRIPT}"
  else
    src_set "$src" "ok" "" "rows=${rows};script=${AWS_RESOURCE_SIGNALS_SCRIPT}"
  fi
  rm -f "$errf"
}

mint_github_app_token() {
  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then return 1; fi

  local app_id="${GITHUB_APP_ID:-}" private_key="${GITHUB_APP_PRIVATE_KEY:-}" install_id="${GITHUB_APP_INSTALLATION_ID:-}" install_owner="${GITHUB_APP_OWNER:-${GITHUB_ORG}}"
  local app_jwt install_json install_code token_json token_code token

  [[ -n "$app_id" && -n "$private_key" ]] || return 1

  app_jwt="$(GITHUB_APP_ID="$app_id" GITHUB_APP_PRIVATE_KEY="$private_key" node - <<'NODE'
const crypto = require('crypto');
const appId = process.env.GITHUB_APP_ID;
const keyRaw = process.env.GITHUB_APP_PRIVATE_KEY || '';
const key = keyRaw.replace(/\\n/g, '\n');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'RS256', typ: 'JWT' };
const payload = { iat: now - 60, exp: now + 540, iss: appId };
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const input = `${b64(header)}.${b64(payload)}`;
const signature = crypto.createSign('RSA-SHA256').update(input).sign(key, 'base64url');
process.stdout.write(`${input}.${signature}`);
NODE
  )" || return 1

  if [[ -z "$install_id" ]]; then
    install_json="$(mktemp)"
    install_code="$(curl -sS -o "$install_json" -w '%{http_code}' -H "Authorization: Bearer ${app_jwt}" -H "Accept: application/vnd.github+json" "https://api.github.com/app/installations" || true)"
    if [[ "$install_code" != "200" ]]; then rm -f "$install_json"; return 1; fi
    install_id="$(jq -r --arg owner "$install_owner" '.[] | select(.account.login==$owner) | .id' "$install_json" | head -n1)"
    rm -f "$install_json"
  fi

  [[ -n "$install_id" ]] || return 1

  token_json="$(mktemp)"
  token_code="$(curl -sS -o "$token_json" -w '%{http_code}' -X POST -H "Authorization: Bearer ${app_jwt}" -H "Accept: application/vnd.github+json" "https://api.github.com/app/installations/${install_id}/access_tokens" || true)"
  if [[ "$token_code" != "200" && "$token_code" != "201" ]]; then rm -f "$token_json"; return 1; fi
  token="$(jq -r '.token // empty' "$token_json")"
  rm -f "$token_json"
  [[ -n "$token" ]] || return 1
  printf '%s\n' "$token"
}

github_org_access_ok() {
  local token="$1" org="$2" probe_json probe_code
  GITHUB_ORG_ACCESS_LAST_CODE=""
  [[ -n "$token" && -n "$org" ]] || return 1
  probe_json="$(mktemp)"
  probe_code="$(curl -sS -o "$probe_json" -w '%{http_code}' -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" "https://api.github.com/orgs/${org}" || true)"
  rm -f "$probe_json"
  GITHUB_ORG_ACCESS_LAST_CODE="$probe_code"
  [[ "$probe_code" == "200" ]]
}

resolve_auth_token_for_org() {
  local org="$1" env_token app_token env_code="" app_code=""

  env_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [[ -n "$env_token" ]] && github_org_access_ok "$env_token" "$org"; then printf '%s\n' "$env_token"; return 0; fi
  env_code="${GITHUB_ORG_ACCESS_LAST_CODE:-}"

  app_token="$(mint_github_app_token || true)"
  if [[ -n "$app_token" ]] && github_org_access_ok "$app_token" "$org"; then printf '%s\n' "$app_token"; return 0; fi
  app_code="${GITHUB_ORG_ACCESS_LAST_CODE:-}"

  if [[ -n "$env_token" && "$env_code" != "401" && "$env_code" != "403" && "$env_code" != "404" ]]; then printf '%s\n' "$env_token"; return 0; fi
  if [[ -n "$app_token" && "$app_code" != "401" && "$app_code" != "403" && "$app_code" != "404" ]]; then printf '%s\n' "$app_token"; return 0; fi
  return 1
}

github_org_repos_http() {
  curl -sS -o "$4" -w '%{http_code}' \
    -H "Authorization: Bearer ${3}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/orgs/${1}/repos?per_page=100&page=${2}&type=all"
}

fallback_add_local_repos() {
  local source="$1" source_kind="$2" org_id count=0 slug
  org_id="$(id_org "$GITHUB_ORG")"
  while IFS= read -r slug; do
    [[ -n "$slug" ]] || continue
    node_add "$(id_repo "$slug")" "github_repository" "$slug" "$source_kind" "$(jpair repo_slug "$slug"),$(jpair local_path "")" "$source"
    edge_add "$org_id" "owns_repository" "$(id_repo "$slug")" "$source" "$source_kind" "local_fallback"
    count=$((count + 1))
  done <"$REPO_SIGNAL_FILE"
  printf '%s\n' "$count"
}

collect_github() {
  local source="$SRC_GH" token="" repos=0 pages=0 page=1 retries=0 code="" err="" detail="" token_source="none" org_id fallback=0

  org_id="$(id_org "$GITHUB_ORG")"
  node_add "$org_id" "github_organization" "$(sid "$GITHUB_ORG")" "github-api" "$(jpair org_slug "$(sid "$GITHUB_ORG")")" "$source"

  if ! command -v curl >/dev/null 2>&1; then fallback="$(fallback_add_local_repos "$source" "github-api-fallback-no-curl")"; src_set "$source" "degraded" "missing_curl" "org=${GITHUB_ORG};fallback_repos=${fallback}"; return 0; fi
  if ! command -v jq >/dev/null 2>&1; then fallback="$(fallback_add_local_repos "$source" "github-api-fallback-no-jq")"; src_set "$source" "degraded" "missing_jq_for_github_pagination_parse" "org=${GITHUB_ORG};fallback_repos=${fallback}"; return 0; fi

  token="$(resolve_auth_token_for_org "$GITHUB_ORG" || true)"
  if [[ -n "$token" ]]; then
    if [[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]]; then token_source="env"; else token_source="github_app"; fi
  fi

  if [[ -z "$token" ]]; then
    fallback="$(fallback_add_local_repos "$source" "github-api-fallback-no-token")"
    src_set "$source" "degraded" "missing_or_invalid_github_token" "org=${GITHUB_ORG};fallback_repos=${fallback}"
    return 0
  fi

  while :; do
    local tmpj n slug
    tmpj="$(mktemp)"
    code="$(github_org_repos_http "$GITHUB_ORG" "$page" "$token" "$tmpj" || true)"

    if [[ "$code" == "401" || "$code" == "403" ]]; then
      if [[ "$retries" -eq 0 ]]; then
        local refresh
        refresh="$(resolve_auth_token_for_org "$GITHUB_ORG" || true)"
        if [[ -n "$refresh" ]]; then token="$refresh"; retries=1; rm -f "$tmpj"; continue; fi
      fi
      err="github_api_auth_failed_http_${code}"
      rm -f "$tmpj"
      break
    fi

    if [[ "$code" != "200" ]]; then
      err="github_api_http_${code}"
      rm -f "$tmpj"
      break
    fi

    n="$(jq -r 'length' "$tmpj" 2>/dev/null || true)"
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then
      err="github_api_parse_error"
      rm -f "$tmpj"
      break
    fi

    pages=$((pages + 1))
    while IFS= read -r slug; do
      slug="$(repo_slug "$slug" || true)"
      [[ -n "$slug" ]] || continue
      repos=$((repos + 1))
      add_repo_signal "$slug"
      node_add "$(id_repo "$slug")" "github_repository" "$slug" "github-api" "$(jpair repo_slug "$slug"),$(jpair local_path "")" "$source"
      edge_add "$org_id" "owns_repository" "$(id_repo "$slug")" "$source" "github-api" ""
    done < <(jq -r '.[]?.full_name // empty' "$tmpj")
    rm -f "$tmpj"

    if [[ "$n" -lt 100 ]]; then break; fi
    page=$((page + 1))
  done

  if [[ "$repos" -gt 0 && -z "$err" ]]; then
    src_set "$source" "ok" "" "org=${GITHUB_ORG};token_source=${token_source};pages=${pages};repos=${repos}"
    return 0
  fi

  fallback="$(fallback_add_local_repos "$source" "github-api-fallback-local-signals")"
  detail="org=${GITHUB_ORG};token_source=${token_source};pages=${pages};repos=${repos};fallback_repos=${fallback}"
  if [[ -z "$err" ]]; then err="github_api_no_repos_returned"; fi
  src_set "$source" "degraded" "$err" "$detail"
}

ndjson_to_array() {
  local f="$1" first=1
  printf '['
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ "$first" -eq 1 ]]; then first=0; else printf ','; fi
    printf '\n%s' "$line"
  done <"$f"
  if [[ "$first" -eq 0 ]]; then printf '\n'; fi
  printf ']'
}

src_status_entry() {
  printf '"%s":{"status":"%s","error":"%s","detail":"%s","nodes_added":%d,"edges_added":%d}' \
    "$(esc "$1")" "$(esc "$2")" "$(esc "$3")" "$(esc "$4")" "$5" "$6"
}

source_status_json() {
  printf '{\n    '
  src_status_entry "$SRC_INFRA" "$S_INFRA_STATUS" "$S_INFRA_ERROR" "$S_INFRA_DETAIL" "$S_INFRA_NODES" "$S_INFRA_EDGES"
  printf ',\n    '
  src_status_entry "$SRC_K8S" "$S_K8S_STATUS" "$S_K8S_ERROR" "$S_K8S_DETAIL" "$S_K8S_NODES" "$S_K8S_EDGES"
  printf ',\n    '
  src_status_entry "$SRC_AWS" "$S_AWS_STATUS" "$S_AWS_ERROR" "$S_AWS_DETAIL" "$S_AWS_NODES" "$S_AWS_EDGES"
  printf ',\n    '
  src_status_entry "$SRC_GH" "$S_GH_STATUS" "$S_GH_ERROR" "$S_GH_DETAIL" "$S_GH_NODES" "$S_GH_EDGES"
  printf '\n  }'
}

write_main() {
  local generated node_count edge_count nodes_json edges_json status_json
  generated="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node_count="$(wc -l <"$NODE_KEYS_FILE" | tr -d '[:space:]')"
  edge_count="$(wc -l <"$EDGE_KEYS_FILE" | tr -d '[:space:]')"
  nodes_json="$(ndjson_to_array "$NODES_OUTPUT_FILE")"
  edges_json="$(ndjson_to_array "$EDGES_OUTPUT_FILE")"
  status_json="$(source_status_json)"

  cat >"$MAIN_OUTPUT_FILE" <<EOF_JSON
{
  "metadata": {
    "schema": "initial-knowledge.v1",
    "edge_schema": "normalized-runtime-compat.v1",
    "generator": "relationship-knowledge-build.sh",
    "generated_at": "$(esc "$generated")",
    "output_dir": "$(esc "$OUTPUT_DIR")",
    "edge_schema_note": "legacy shell edge verbs are normalized toward runtime-compatible edge types"
  },
  "counts": {
    "nodes": ${node_count},
    "edges": ${edge_count}
  },
  "source_status": ${status_json},
  "nodes": ${nodes_json},
  "edges": ${edges_json}
}
EOF_JSON
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

MAIN_OUTPUT_FILE="${OUTPUT_DIR}/initial-knowledge.v1.json"
NODES_OUTPUT_FILE="${OUTPUT_DIR}/nodes.ndjson"
EDGES_OUTPUT_FILE="${OUTPUT_DIR}/edges.ndjson"

mkdir -p "$OUTPUT_DIR"

collect_infra
collect_k8s
collect_aws
collect_github

LC_ALL=C sort "$NODES_RAW_FILE" >"$NODES_OUTPUT_FILE"
LC_ALL=C sort "$EDGES_RAW_FILE" >"$EDGES_OUTPUT_FILE"
write_main

printf 'Wrote: %s\n' "$MAIN_OUTPUT_FILE"
printf 'Wrote: %s\n' "$NODES_OUTPUT_FILE"
printf 'Wrote: %s\n' "$EDGES_OUTPUT_FILE"
