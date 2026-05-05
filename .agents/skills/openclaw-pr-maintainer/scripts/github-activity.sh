#!/usr/bin/env bash
set -euo pipefail

repo="openclaw/openclaw"
months="12"
include_global="0"

usage() {
  printf 'Usage: %s [--repo owner/repo] [--months N] [--global] <github-login> [login...]\n' "$0"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

date_utc_relative_months() {
  local count="$1"
  if date -u -v-"${count}"m +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
    date -u -v-"${count}"m +%Y-%m-%dT%H:%M:%SZ
    return
  fi
  date -u -d "${count} months ago" +%Y-%m-%dT%H:%M:%SZ
}

date_to_epoch() {
  local value="$1"
  if date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$value" +%s >/dev/null 2>&1; then
    date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$value" +%s
    return
  fi
  date -u -d "$value" +%s
}

rough_age() {
  local created_at="$1"
  local now_s created_s days
  now_s=$(date -u +%s)
  created_s=$(date_to_epoch "$created_at")
  days=$(( (now_s - created_s) / 86400 ))
  if (( days < 120 )); then
    printf '~%dd old' "$days"
    return
  fi
  awk -v days="$days" 'BEGIN { printf "~%.1fy old", days / 365.2425 }'
}

count_threads() {
  local kind="$1"
  local login="$2"
  local since_ts="$3"
  local kind_filter
  if [[ "$kind" == "prs" ]]; then
    kind_filter='has("pull_request")'
  else
    kind_filter='has("pull_request") | not'
  fi
  gh api --paginate "repos/${repo}/issues?state=all&creator=${login}&since=${since_ts}&per_page=100" \
    --jq ".[] | select(.created_at >= \"${since_ts}\") | select(${kind_filter}) | .number" |
    wc -l |
    tr -d '[:space:]'
}

count_commits() {
  local login="$1"
  local since_ts="$2"
  gh api --paginate "repos/${repo}/commits?author=${login}&since=${since_ts}&per_page=100" \
    --jq '.[].sha' | wc -l | tr -d '[:space:]'
}

global_activity() {
  local login="$1"
  local since_ts="$2"
  local now_ts="$3"
  # shellcheck disable=SC2016
  gh api graphql \
    -f login="$login" \
    -f from="$since_ts" \
    -f to="$now_ts" \
    -f query='
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
    }
  }
}' \
    --jq '.data.user.contributionsCollection // empty'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || die "--repo requires owner/repo"
      repo="$2"
      shift 2
      ;;
    --months)
      [[ $# -ge 2 ]] || die "--months requires a positive integer"
      months="$2"
      [[ "$months" =~ ^[0-9]+$ && "$months" != "0" ]] || die "--months must be a positive integer"
      shift 2
      ;;
    --global)
      include_global="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -gt 0 ]] || {
  usage >&2
  exit 2
}

need gh
need jq

since_ts=$(date_utc_relative_months "$months")
now_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

for login in "$@"; do
  profile=$(gh api "users/${login}" --jq '{login,name,created_at,type}')
  display_login=$(jq -r '.login' <<<"$profile")
  name=$(jq -r '.name // empty' <<<"$profile")
  created_at=$(jq -r '.created_at' <<<"$profile")
  type=$(jq -r '.type' <<<"$profile")
  created_day=${created_at%%T*}

  prs=$(count_threads prs "$display_login" "$since_ts")
  issues=$(count_threads issues "$display_login" "$since_ts")
  commits=$(count_commits "$display_login" "$since_ts")

  if [[ -n "$name" ]]; then
    printf '%s (@%s, %s, account created %s, %s)\n' \
      "$name" "$display_login" "$type" "$created_day" "$(rough_age "$created_at")"
  else
    printf '@%s (%s, account created %s, %s)\n' \
      "$display_login" "$type" "$created_day" "$(rough_age "$created_at")"
  fi
  printf '%s last %smo: %s PRs, %s issues, %s commits\n' "$repo" "$months" "$prs" "$issues" "$commits"

  if [[ "$include_global" == "1" ]]; then
    if global_json=$(global_activity "$display_login" "$since_ts" "$now_ts" 2>/dev/null); then
      if [[ -n "$global_json" ]]; then
        global_commits=$(jq -r '.totalCommitContributions' <<<"$global_json")
        global_issues=$(jq -r '.totalIssueContributions' <<<"$global_json")
        global_prs=$(jq -r '.totalPullRequestContributions' <<<"$global_json")
        global_reviews=$(jq -r '.totalPullRequestReviewContributions' <<<"$global_json")
        printf 'GitHub public last %smo: %s commits, %s PRs, %s issues, %s reviews\n' \
          "$months" "$global_commits" "$global_prs" "$global_issues" "$global_reviews"
      else
        printf 'GitHub public last %smo: unavailable\n' "$months"
      fi
    else
      printf 'GitHub public last %smo: unavailable\n' "$months"
    fi
  fi
done
