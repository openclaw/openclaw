#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
helm-lineage-tracker.sh [--rendered-file <path>] [--live-file <path>] [--repo <path>] [--values-file <path>] [--scope <value>] [--field <name>...]
EOF
}

RENDERED_FILE="${HELM_LINEAGE_RENDERED_FILE:-}"
LIVE_FILE="${HELM_LINEAGE_LIVE_FILE:-}"
REPO_DIR="${HELM_LINEAGE_REPO_DIR:-${MORPHO_INFRA_HELM_DIR:-}}"
VALUES_FILE="${HELM_LINEAGE_VALUES_FILE:-}"
SCOPE="${HELM_LINEAGE_SCOPE:-openclaw-sre}"
FIELDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rendered-file) RENDERED_FILE="${2:-}"; shift 2 ;;
    --live-file) LIVE_FILE="${2:-}"; shift 2 ;;
    --repo) REPO_DIR="${2:-}"; shift 2 ;;
    --values-file) VALUES_FILE="${2:-}"; shift 2 ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --field) FIELDS+=("${2:-}"); shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || {
  printf '{"version":"sre.helm-lineage.v1","scope":"%s","collection_error":"missing_jq","reports":[]}\n' "$SCOPE"
  exit 0
}

if [[ -z "$RENDERED_FILE" || -z "$LIVE_FILE" || ! -f "$RENDERED_FILE" || ! -f "$LIVE_FILE" ]]; then
  printf '{"version":"sre.helm-lineage.v1","scope":"%s","collection_error":"missing_rendered_or_live_file","reports":[]}\n' "$SCOPE"
  exit 0
fi

if [[ ${#FIELDS[@]} -eq 0 ]]; then
  FIELDS=(image resources env replicas probes annotations)
fi

field_render_path() {
  case "$1" in
    image) printf '.spec.template.spec.containers // [] | map({name, image})' ;;
    resources) printf '.spec.template.spec.containers // [] | map({name, resources})' ;;
    env) printf '.spec.template.spec.containers // [] | map({name, env, envFrom})' ;;
    replicas) printf '.spec.replicas' ;;
    probes) printf '.spec.template.spec.containers // [] | map({name, livenessProbe, readinessProbe, startupProbe})' ;;
    annotations) printf '.spec.template.metadata.annotations // {}' ;;
    *) return 1 ;;
  esac
}

field_values_hint() {
  case "$1" in
    image) printf 'image.uri' ;;
    resources) printf 'resources.gateway' ;;
    env) printf 'charts/openclaw-sre/templates/deployment.yaml:env' ;;
    replicas) printf 'replicaCount' ;;
    probes) printf 'probes.*' ;;
    annotations) printf 'charts/openclaw-sre/templates/deployment.yaml:annotations' ;;
    *) return 1 ;;
  esac
}

git_meta_json() {
  local repo_dir="$1"
  shift
  if [[ -z "$repo_dir" || ! -d "$repo_dir/.git" ]]; then
    printf 'null'
    return 0
  fi
  local first_file=""
  for candidate in "$@"; do
    if [[ -n "$candidate" && -e "$repo_dir/$candidate" ]]; then
      first_file="$candidate"
      break
    fi
  done
  if [[ -z "$first_file" ]]; then
    printf 'null'
    return 0
  fi
  local line hash subject
  line="$(git -C "$repo_dir" log -1 --pretty=format:'%H%x1f%s' -- "$first_file" 2>/dev/null || true)"
  hash="${line%%$'\x1f'*}"
  subject="${line#*$'\x1f'}"
  if [[ -z "$hash" || "$hash" == "$line" ]]; then
    printf 'null'
    return 0
  fi
  jq -nc --arg commit "$hash" --arg subject "$subject" --arg file "$first_file" \
    '{commit:$commit, subject:$subject, file:$file}'
}

reports=()
for field in "${FIELDS[@]}"; do
  render_path="$(field_render_path "$field" 2>/dev/null || true)"
  [[ -n "$render_path" ]] || continue
  values_hint="$(field_values_hint "$field" 2>/dev/null || printf '')"
  rendered_value="$(jq -c "$render_path" "$RENDERED_FILE" 2>/dev/null || printf 'null')"
  live_value="$(jq -c "$render_path" "$LIVE_FILE" 2>/dev/null || printf 'null')"
  git_meta="$(git_meta_json "$REPO_DIR" "charts/openclaw-sre/templates/deployment.yaml" "${VALUES_FILE:-}")"
  reports+=("$(
    jq -nc \
      --arg field "$field" \
      --arg scope "$SCOPE" \
      --arg template_file "charts/openclaw-sre/templates/deployment.yaml" \
      --arg values_file "${VALUES_FILE:-}" \
      --arg value_path_hint "$values_hint" \
      --argjson rendered "$rendered_value" \
      --argjson live "$live_value" \
      --argjson git "$git_meta" \
      '{
        field:$field,
        scope:$scope,
        template_file:$template_file,
        values_file:$values_file,
        value_path_hint:$value_path_hint,
        rendered:$rendered,
        live:$live,
        matches_live: ($rendered == $live),
        git: $git
      }'
  )")
done

printf '%s\n' "${reports[@]}" | jq -cs --arg scope "$SCOPE" '
  {
    version: "sre.helm-lineage.v1",
    tracked_at: (now | todateiso8601),
    scope: $scope,
    collection_error: "",
    reports: .
  }'
