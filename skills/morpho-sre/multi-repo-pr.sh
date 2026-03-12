#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="${SCRIPT_DIR}/change-plan-check.sh"
VALIDATE_SCRIPT="${SCRIPT_DIR}/validate-change-plan.sh"
AUTOFIX_SCRIPT_DEFAULT="${SCRIPT_DIR}/autofix-pr.sh"

usage() {
  cat <<'EOF'
Usage:
  multi-repo-pr.sh --plan <file> [--dry-run] [--validation-summary-file <file>]

Validates a change plan, then creates linked PRs in dependency order.
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

for cmd in jq bash mktemp sed awk; do
  require_cmd "$cmd"
done

PLAN_FILE=""
OWNERSHIP_FILE=""
AUTOFIX_SCRIPT="$AUTOFIX_SCRIPT_DEFAULT"
VALIDATION_SUMMARY_FILE=""
DRY_RUN=0
PLAN_STATE_DIR="${OPENCLAW_SRE_PLANS_DIR:-/home/node/.openclaw/state/sre-plans}"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --plan)
      PLAN_FILE="${2:-}"
      shift 2
      ;;
    --ownership-file)
      OWNERSHIP_FILE="${2:-}"
      shift 2
      ;;
    --autofix-script)
      AUTOFIX_SCRIPT="${2:-}"
      shift 2
      ;;
    --validation-summary-file)
      VALIDATION_SUMMARY_FILE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      exit 1
      ;;
  esac
done

[[ -n "$PLAN_FILE" ]] || {
  printf '--plan required\n' >&2
  exit 1
}
[[ -x "$AUTOFIX_SCRIPT" ]] || {
  printf 'autofix script not executable: %s\n' "$AUTOFIX_SCRIPT" >&2
  exit 1
}

normalize_args=(--plan "$PLAN_FILE")
if [[ -n "$OWNERSHIP_FILE" ]]; then
  normalize_args+=(--ownership-file "$OWNERSHIP_FILE")
fi

plan_state_path() {
  local plan_file="$1"
  local base
  base="$(basename -- "$plan_file")"
  base="${base%.*}"
  printf '%s/%s.state.json\n' "$PLAN_STATE_DIR" "$base"
}

write_plan_state() {
  local plan_file="$1"
  local phase="$2"
  local repos_json="${3:-[]}"
  local status="${4:-running}"
  local state_path tmp_file
  state_path="$(plan_state_path "$plan_file")"
  mkdir -p "${state_path%/*}"
  tmp_file="${state_path}.tmp.$$"
  jq -cn \
    --arg plan_file "$plan_file" \
    --arg phase "$phase" \
    --arg status "$status" \
    --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson repos "$repos_json" \
    '{
      version: "sre.multi-repo-plan-state.v1",
      plan_file: $plan_file,
      phase: $phase,
      status: $status,
      updated_at: $updated_at,
      repos: $repos
    }' >"$tmp_file"
  mv -f "$tmp_file" "$state_path"
}

NORMALIZED="$(bash "$CHECK_SCRIPT" "${normalize_args[@]}")"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SUMMARY_FILE="${VALIDATION_SUMMARY_FILE:-${TMP_DIR}/validation-summary.json}"
validate_args=(--plan "$PLAN_FILE" --summary-file "$SUMMARY_FILE")
if [[ -n "$OWNERSHIP_FILE" ]]; then
  validate_args+=(--ownership-file "$OWNERSHIP_FILE")
fi
bash "$VALIDATE_SCRIPT" "${validate_args[@]}" >/dev/null
VALIDATION_STATUS="$(jq -r '.status' "$SUMMARY_FILE")"
write_plan_state "$PLAN_FILE" "validated" "$(jq -c '.repos' "$SUMMARY_FILE")" "$VALIDATION_STATUS"
[[ "$VALIDATION_STATUS" == "ok" ]] || {
  write_plan_state "$PLAN_FILE" "failed-validation" "$(jq -c '.repos' "$SUMMARY_FILE")" "error"
  printf 'change plan validation failed\n' >&2
  cat "$SUMMARY_FILE" >&2
  exit 1
}

order_repo_ids() {
  local normalized="$1"
  local -a ordered=()
  local -a pending=()
  local -a deps=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && pending+=("$line")
  done < <(jq -r '.repos[].repo_id' <<<"$normalized")
  while [[ "${#pending[@]}" -gt 0 ]]; do
    local progress=0
    local -a next_pending=()
    local repo_id deps unmet dep
    for repo_id in "${pending[@]}"; do
      deps=()
      while IFS= read -r dep; do
        [[ -n "$dep" ]] && deps+=("$dep")
      done < <(jq -r --arg repo "$repo_id" '.repos[] | select(.repo_id == $repo) | .depends_on_repos[]?' <<<"$normalized")
      unmet=0
      for dep in "${deps[@]-}"; do
        if [[ ! " ${ordered[*]-} " =~ " ${dep} " ]]; then
          unmet=1
          break
        fi
      done
      if [[ "$unmet" -eq 0 ]]; then
        ordered+=("$repo_id")
        progress=1
      else
        next_pending+=("$repo_id")
      fi
    done
    [[ "$progress" -eq 1 ]] || {
      printf 'cyclic repo dependencies in change plan\n' >&2
      exit 1
    }
    if [[ "${#next_pending[@]}" -eq 0 ]]; then
      pending=()
    else
      pending=("${next_pending[@]}")
    fi
  done
  printf '%s\n' "${ordered[@]}"
}

build_pr_body_file() {
  local repo_json="$1"
  local outfile="$2"
  local validation_json="$3"
  jq -rn \
    --argjson repo "$repo_json" \
    --argjson validation "$validation_json" '
    [
      "## Summary",
      "",
      $repo.rationale,
      "",
      "## Files",
      "",
      ($repo.files[] | "- `\(.)`"),
      "",
      "## Validation",
      "",
      (if ($repo.validation_profile // null) != null then "- profile: `\($repo.validation_profile)`" else empty end),
      (if ($repo.base_sha // null) != null then "- base_sha: `\($repo.base_sha)`" else empty end),
      ($repo.expected_validations[] | "- `\(.)`"),
      "",
      "## Impact",
      "",
      (if (($repo.change_type // "") != "") then "- change_type: `\($repo.change_type)`" else empty end),
      (if (($repo.impacted_apps // []) | length) > 0 then ($repo.impacted_apps[] | "- impacted_app: `\(.)`") else empty end),
      "",
      "## Rollback",
      "",
      ($repo.rollback[] | "- \(.)"),
      "",
      "## Validation Summary",
      "",
      ("- status: " + ($validation.status // "unknown"))
    ] | join("\n")
    ' >"$outfile"
}

extract_pr_url() {
  printf '%s\n' "$1" | grep -Eo 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | head -n1 || true
}

declare -a ORDERED_REPOS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ORDERED_REPOS+=("$line")
done < <(order_repo_ids "$NORMALIZED")

declare -a RESULT_JSON_LINES=()
declare -a PR_URLS=()

for repo_id in "${ORDERED_REPOS[@]-}"; do
  repo_json="$(jq -c --arg repo "$repo_id" '.repos[] | select(.repo_id == $repo)' <<<"$NORMALIZED")"
  repo_slug="$(jq -r '.repo_slug' <<<"$repo_json")"
  local_path="$(jq -r '.local_path' <<<"$repo_json")"
  title="$(jq -r '.pr.title' <<<"$repo_json")"
  commit_msg="$(jq -r '.pr.commit' <<<"$repo_json")"
  base_branch="$(jq -r '.pr.base' <<<"$repo_json")"
  branch_name="$(jq -r '.pr.branch // empty' <<<"$repo_json")"
  draft_flag="$(jq -r '.pr.draft' <<<"$repo_json")"
  files_csv="$(jq -r '.files | join(",")' <<<"$repo_json")"
  base_sha="$(jq -r '.base_sha // empty' <<<"$repo_json")"
  change_type="$(jq -r '.change_type // empty' <<<"$repo_json")"
  validation_profile="$(jq -r '.validation_profile // empty' <<<"$repo_json")"
  impacted_apps="$(jq -c '.impacted_apps // []' <<<"$repo_json")"
  validation_json="$(jq -c --arg repo "$repo_id" 'first(.repos[] | select(.repo_id == $repo)) // {}' "$SUMMARY_FILE")"
  body_file="${TMP_DIR}/${repo_id}.body.md"
  build_pr_body_file "$repo_json" "$body_file" "$validation_json"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    RESULT_JSON_LINES+=("$(jq -cn --arg repo_id "$repo_id" --arg repo_slug "$repo_slug" --arg local_path "$local_path" --arg base_sha "$base_sha" --arg change_type "$change_type" --arg validation_profile "$validation_profile" --argjson impacted_apps "$impacted_apps" '{repo_id:$repo_id, repo_slug:$repo_slug, local_path:$local_path, base_sha:(if $base_sha == "" then null else $base_sha end), change_type:(if $change_type == "" then null else $change_type end), validation_profile:(if $validation_profile == "" then null else $validation_profile end), impacted_apps:$impacted_apps, status:"dry-run"}')")
    write_plan_state "$PLAN_FILE" "repo-dry-run" "$(printf '%s\n' "${RESULT_JSON_LINES[@]}" | jq -s '.')" "running"
    continue
  fi

  cmd=("$AUTOFIX_SCRIPT" --repo "$repo_slug" --path "$local_path" --title "$title" --commit "$commit_msg" --confidence "100" --body-file "$body_file" --base "$base_branch" --files "$files_csv")
  if [[ -n "$branch_name" ]]; then
    cmd+=(--branch "$branch_name")
  fi
  if [[ "$draft_flag" == "true" ]]; then
    cmd+=(--draft)
  fi

  output="$("${cmd[@]}")"
  pr_url="$(extract_pr_url "$output")"
  [[ -n "$pr_url" ]] || {
    write_plan_state "$PLAN_FILE" "failed-pr-parse" "$(printf '%s\n' "${RESULT_JSON_LINES[@]}" | jq -s '.')" "error"
    printf 'failed to parse PR URL for %s\n' "$repo_id" >&2
    exit 1
  }
  PR_URLS+=("$pr_url")
  RESULT_JSON_LINES+=("$(jq -cn --arg repo_id "$repo_id" --arg repo_slug "$repo_slug" --arg pr_url "$pr_url" --arg base_sha "$base_sha" --arg change_type "$change_type" --arg validation_profile "$validation_profile" --argjson impacted_apps "$impacted_apps" '{repo_id:$repo_id, repo_slug:$repo_slug, pr_url:$pr_url, base_sha:(if $base_sha == "" then null else $base_sha end), change_type:(if $change_type == "" then null else $change_type end), validation_profile:(if $validation_profile == "" then null else $validation_profile end), impacted_apps:$impacted_apps, status:"created"}')")
  write_plan_state "$PLAN_FILE" "repo-created" "$(printf '%s\n' "${RESULT_JSON_LINES[@]}" | jq -s '.')" "running"
done

if [[ "$DRY_RUN" -ne 1 && "${#PR_URLS[@]}" -gt 1 && -x "$(command -v gh)" ]]; then
  for pr_url in "${PR_URLS[@]}"; do
    repo_slug="$(printf '%s\n' "$pr_url" | sed -E 's#https://github.com/([^/]+/[^/]+)/pull/[0-9]+#\1#')"
    pr_number="$(printf '%s\n' "$pr_url" | sed -E 's#.*/pull/([0-9]+).*#\1#')"
    siblings="$(printf '%s\n' "${PR_URLS[@]}" | grep -Fxv "$pr_url" || true)"
    [[ -n "$siblings" ]] || continue
    gh pr comment "$pr_number" -R "$repo_slug" -F - <<EOF
Sibling PRs:
${siblings}
EOF
  done
fi

FINAL_RESULT_FILE="${TMP_DIR}/result.json"
jq -s \
  --arg plan_file "$PLAN_FILE" \
  '{
    version: "sre.multi-repo-pr.v1",
    plan_file: $plan_file,
    repos: .,
    status: (if all(.[]; .status == "dry-run" or .status == "created") then "ok" else "error" end)
  }' \
  <(printf '%s\n' "${RESULT_JSON_LINES[@]}") | tee "$FINAL_RESULT_FILE"

write_plan_state "$PLAN_FILE" "completed" "$(jq -c '.repos' "$FINAL_RESULT_FILE")" "$(jq -r '.status' "$FINAL_RESULT_FILE")"
