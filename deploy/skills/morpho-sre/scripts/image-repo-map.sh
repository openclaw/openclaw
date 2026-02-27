#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  image-repo-map.sh [--image <substring>]

Reads source-of-truth from:
  /Users/florian/morpho/morpho-infra/projects/commons/variables.auto.tfvars

Outputs:
  /tmp/openclaw-image-repo/image-repo-map.tsv
  /tmp/openclaw-image-repo/workload-image-repo.tsv
EOF
}

IMAGE_FILTER=""
if [[ "${1:-}" == "--image" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "missing value for --image" >&2
    usage
    exit 1
  fi
  IMAGE_FILTER="$2"
fi

for cmd in awk bash grep jq kubectl sed sort; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
done

MORPHO_INFRA_DIR="${MORPHO_INFRA_DIR:-/Users/florian/morpho/morpho-infra}"
MORPHO_INFRA_HELM_DIR="${MORPHO_INFRA_HELM_DIR:-/Users/florian/morpho/morpho-infra-helm}"
COMMONS_TFVARS="${MORPHO_INFRA_DIR}/projects/commons/variables.auto.tfvars"
ECR_REGISTRY="${ECR_REGISTRY:-537124939463.dkr.ecr.eu-west-3.amazonaws.com}"

for path in "$MORPHO_INFRA_DIR" "$MORPHO_INFRA_HELM_DIR" "$COMMONS_TFVARS"; do
  if [[ ! -e "$path" ]]; then
    echo "missing required path: $path" >&2
    exit 1
  fi
done

normalize_image_repo() {
  local image="$1"
  image="${image%@sha256:*}"
  if [[ "${image##*/}" == *:* ]]; then
    image="${image%:*}"
  fi
  printf '%s' "$image"
}

find_first_hit() {
  local needle="$1"
  if command -v rg >/dev/null 2>&1; then
    rg -n --no-heading -m 1 --fixed-strings "$needle" "$MORPHO_INFRA_DIR" "$MORPHO_INFRA_HELM_DIR" 2>/dev/null || true
  else
    grep -R -n -F -m 1 -- "$needle" "$MORPHO_INFRA_DIR" "$MORPHO_INFRA_HELM_DIR" 2>/dev/null || true
  fi
}

OUT_DIR="/tmp/openclaw-image-repo"
mkdir -p "$OUT_DIR"

WORKLOAD_IMAGES_TSV="$OUT_DIR/workload-images.tsv"
UNIQUE_REPOS_TXT="$OUT_DIR/image-repos.txt"
IMAGE_MAP_TSV="$OUT_DIR/image-repo-map.tsv"
WORKLOAD_MAP_TSV="$OUT_DIR/workload-image-repo.tsv"

kubectl get pods -A -o json | jq -r '
  .items[]
  | .metadata.namespace as $ns
  | .metadata.name as $pod
  | ([.spec.containers[]?.image, .spec.initContainers[]?.image] | .[]) as $image
  | [$ns, $pod, $image]
  | @tsv
' | sort -u > "$WORKLOAD_IMAGES_TSV"

cut -f3 "$WORKLOAD_IMAGES_TSV" | while IFS= read -r image; do
  normalize_image_repo "$image"
  printf '\n'
done | sort -u > "$UNIQUE_REPOS_TXT"

declare -A ECR_TO_GITHUB=()
declare -A GITHUB_TO_ECR=()

while IFS= read -r github_repo; do
  [[ -z "$github_repo" ]] && continue
  ecr_repo="${github_repo##*/}"
  ECR_TO_GITHUB["$ecr_repo"]="$github_repo"
done < <(awk '
  /github_repositories[[:space:]]*=[[:space:]]*\[/ {in_list=1; next}
  in_list && /\]/ {in_list=0}
  in_list {
    if (match($0, /"([^"]+)"/)) {
      value=substr($0, RSTART+1, RLENGTH-2)
      print value
    }
  }
' "$COMMONS_TFVARS")

while IFS=$'\t' read -r github_repo ecr_repo; do
  [[ -z "${github_repo:-}" || -z "${ecr_repo:-}" ]] && continue
  GITHUB_TO_ECR["$github_repo"]="$ecr_repo"
  ECR_TO_GITHUB["$ecr_repo"]="$github_repo"
done < <(awk '
  /ecr_repository_mapping[[:space:]]*=[[:space:]]*\{/ {in_map=1; next}
  in_map && /\}/ {in_map=0}
  in_map {
    if (match($0, /"[^"]+"[[:space:]]*=[[:space:]]*"[^"]+"/)) {
      pair=substr($0, RSTART, RLENGTH)
      split(pair, parts, "=")
      gsub(/^[[:space:]]*"/, "", parts[1]); gsub(/"[[:space:]]*$/, "", parts[1])
      gsub(/^[[:space:]]*"/, "", parts[2]); gsub(/"[[:space:]]*$/, "", parts[2])
      print parts[1] "\t" parts[2]
    }
  }
' "$COMMONS_TFVARS")

declare -A GH_BY_IMAGE_REPO=()
declare -A CLONE_BY_IMAGE_REPO=()
declare -A SOURCE_BY_IMAGE_REPO=()
declare -A HIT_BY_IMAGE_REPO=()
declare -A LOCAL_PATH_BY_IMAGE_REPO=()

while IFS= read -r image_repo; do
  [[ -z "$image_repo" ]] && continue

  github_repo=""
  source_kind=""

  if [[ "$image_repo" == "${ECR_REGISTRY}/"* ]]; then
    ecr_repo="${image_repo#${ECR_REGISTRY}/}"
    ecr_repo="${ecr_repo%%/*}"
    github_repo="${ECR_TO_GITHUB[$ecr_repo]:-}"
    if [[ -z "$github_repo" ]]; then
      github_repo="morpho-org/${ecr_repo}"
      source_kind="commons-ecr-heuristic"
    else
      source_kind="commons-ecr-mapping"
    fi
  elif [[ "$image_repo" == morphoorg/* ]]; then
    image_name="${image_repo#morphoorg/}"
    github_repo="morpho-org/${image_name}"
    source_kind="dockerhub-morpho-heuristic"
  else
    github_repo="morpho-org/morpho-infra"
    source_kind="infra-source-of-truth"
  fi

  clone_url="https://github.com/${github_repo}.git"
  hit="$(find_first_hit "$image_repo")"
  hit="${hit%%$'\n'*}"

  repo_name="${github_repo##*/}"
  local_path="/Users/florian/morpho/${repo_name}"
  if [[ "$github_repo" == "morpho-org/morpho-infra" ]]; then
    local_path="/Users/florian/morpho/morpho-infra"
  elif [[ "$github_repo" == "morpho-org/morpho-infra-helm" ]]; then
    local_path="/Users/florian/morpho/morpho-infra-helm"
  fi
  if [[ ! -d "$local_path" ]]; then
    local_path=""
  fi

  GH_BY_IMAGE_REPO["$image_repo"]="$github_repo"
  CLONE_BY_IMAGE_REPO["$image_repo"]="$clone_url"
  SOURCE_BY_IMAGE_REPO["$image_repo"]="$source_kind"
  HIT_BY_IMAGE_REPO["$image_repo"]="$hit"
  LOCAL_PATH_BY_IMAGE_REPO["$image_repo"]="$local_path"
done < "$UNIQUE_REPOS_TXT"

{
  printf "image_repo\tgithub_repo\tclone_url\tlocal_repo_path\tmapping_source\tdefinition_hit\n"
  while IFS= read -r image_repo; do
    [[ -z "$image_repo" ]] && continue
    printf "%s\t%s\t%s\t%s\t%s\t%s\n" \
      "$image_repo" \
      "${GH_BY_IMAGE_REPO[$image_repo]:-}" \
      "${CLONE_BY_IMAGE_REPO[$image_repo]:-}" \
      "${LOCAL_PATH_BY_IMAGE_REPO[$image_repo]:-}" \
      "${SOURCE_BY_IMAGE_REPO[$image_repo]:-}" \
      "${HIT_BY_IMAGE_REPO[$image_repo]:-}"
  done < "$UNIQUE_REPOS_TXT"
} > "$IMAGE_MAP_TSV"

{
  printf "namespace\tpod\timage\timage_repo\tgithub_repo\tclone_url\tlocal_repo_path\tmapping_source\tdefinition_hit\n"
  while IFS=$'\t' read -r namespace pod image; do
    image_repo="$(normalize_image_repo "$image")"
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
      "$namespace" \
      "$pod" \
      "$image" \
      "$image_repo" \
      "${GH_BY_IMAGE_REPO[$image_repo]:-}" \
      "${CLONE_BY_IMAGE_REPO[$image_repo]:-}" \
      "${LOCAL_PATH_BY_IMAGE_REPO[$image_repo]:-}" \
      "${SOURCE_BY_IMAGE_REPO[$image_repo]:-}" \
      "${HIT_BY_IMAGE_REPO[$image_repo]:-}"
  done < "$WORKLOAD_IMAGES_TSV"
} > "$WORKLOAD_MAP_TSV"

if [[ -n "$IMAGE_FILTER" ]]; then
  printf "Filtered matches for image substring: %s\n" "$IMAGE_FILTER"
  awk -F'\t' -v q="$IMAGE_FILTER" '
    NR==1 { print; next }
    index($3, q) > 0 || index($4, q) > 0 { print }
  ' "$WORKLOAD_MAP_TSV"
fi

echo "Wrote: $IMAGE_MAP_TSV"
echo "Wrote: $WORKLOAD_MAP_TSV"
