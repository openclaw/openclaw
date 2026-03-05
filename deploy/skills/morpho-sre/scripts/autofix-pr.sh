#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage:
  autofix-pr.sh --repo <owner/repo|https://github.com/owner/repo.git> --title <title> --commit <message> --confidence <0-100> [options]

Options:
  --repo                Target GitHub repo slug or URL.
  --path                Local repo path (optional; auto-clones via repo-clone.sh when omitted).
  --title               PR title.
  --commit              Commit message.
  --confidence          Confidence score (0-100). Must be >= AUTO_PR_MIN_CONFIDENCE.
  --body                PR body inline string.
  --body-file           PR body markdown file path.
  --base                Base branch (default: main).
  --branch              Branch name override (default: AUTO_PR_BRANCH_PREFIX + timestamp).
  --check-cmd           Optional validation command run inside repo before commit.
  --files               Comma-separated file paths to stage (default: stage all changes).
  --draft               Create draft PR.
  --dry-run             Validate only; do not commit/push/create PR.

Env guards:
  AUTO_PR_ENABLED=1|0                (default: 1)
  AUTO_PR_MIN_CONFIDENCE=<int>       (default: 85)
  AUTO_PR_ALLOWED_REPOS=<csv/pattern> (default: morpho-org/*)
  AUTO_PR_BRANCH_PREFIX=<prefix>     (default: openclaw/sre-auto)
  AUTO_PR_SIGNED_COMMITS=1|0         (default: 1; GitHub API signed commit flow)
  AUTO_PR_NOTIFY_ENABLED=1|0         (default: 1)
  AUTO_PR_NOTIFY_USER_ID=<U...>      (default: first SLACK_ALLOWED_USER_IDS value)
  AUTO_PR_NOTIFY_STRICT=1|0          (default: 1)
  AUTO_PR_GIT_USER_NAME=<name>       (default: OpenClaw SRE Bot)
  AUTO_PR_GIT_USER_EMAIL=<email>     (default: openclaw-sre-bot@morpho.dev)
  AUTO_PR_TRACKING_LABEL=<label>     (default: openclaw-sre; empty disables)
  AUTO_PR_LINEAR_TICKET_API=<path>   (default: ./linear-ticket-api.sh next to this script)
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

for cmd in awk bash base64 curl git gh grep jq node sed tr; do
  require_cmd "$cmd"
done

PR_TITLE_PREFIX="[OPENCLAW-SRE]"

truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_pr_title_prefix() {
  local raw="${1:-}"
  local prefix_lower suffix
  raw="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  if [[ -z "$raw" ]]; then
    printf '%s\n' "$PR_TITLE_PREFIX"
    return 0
  fi
  prefix_lower="$(printf '%s' "${raw:0:${#PR_TITLE_PREFIX}}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$prefix_lower" == "$(printf '%s' "$PR_TITLE_PREFIX" | tr '[:upper:]' '[:lower:]')" ]]; then
    suffix="${raw:${#PR_TITLE_PREFIX}}"
    suffix="$(printf '%s' "$suffix" | sed -E 's/^[[:space:]]+//')"
    if [[ -n "$suffix" ]]; then
      printf '%s %s\n' "$PR_TITLE_PREFIX" "$suffix"
    else
      printf '%s\n' "$PR_TITLE_PREFIX"
    fi
    return 0
  fi
  printf '%s %s\n' "$PR_TITLE_PREFIX" "$raw"
}

normalize_repo_slug() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | sed -E 's#^https?://github\.com/##; s#\.git$##')"
  printf '%s\n' "$raw"
}

normalize_remote_repo_slug() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | sed -E 's#^https?://github\.com/##; s#^git@github\.com:##; s#\.git$##')"
  printf '%s\n' "$raw"
}

sanitize_branch_fragment() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  raw="$(printf '%s' "$raw" | sed -E 's#[^a-z0-9._/-]+#-#g; s#-+#-#g; s#^[-./]+##; s#[-./]+$##')"
  printf '%s\n' "$raw"
}

split_csv_nonempty_lines() {
  local raw="${1:-}"
  printf '%s' "$raw" \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }'
}

parse_int_in_range() {
  local value="${1:-}"
  local min="${2:-0}"
  local max="${3:-100}"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if [[ "$value" -lt "$min" || "$value" -gt "$max" ]]; then
    return 1
  fi
  return 0
}

sync_branch_with_base() {
  local repo_path="${1:-}"
  local base_branch="${2:-}"
  local git_auth_basic="${3:-}"

  if [[ -z "$repo_path" || -z "$base_branch" || -z "$git_auth_basic" ]]; then
    echo "sync_branch_with_base requires repo_path, base_branch, and git auth header token" >&2
    return 1
  fi

  if ! git -C "$repo_path" \
    -c credential.helper= \
    -c core.askPass= \
    -c "http.extraHeader=Authorization: Basic ${git_auth_basic}" \
    fetch origin "$base_branch"; then
    return 1
  fi

  if ! git -C "$repo_path" rebase "origin/$base_branch"; then
    return 1
  fi

  return 0
}

assert_clean_slate_before_branch() {
  local repo_path="${1:-}"
  local base_branch="${2:-}"
  local git_auth_basic="${3:-}"
  local preexisting_count

  if [[ -z "$repo_path" || -z "$base_branch" || -z "$git_auth_basic" ]]; then
    echo "assert_clean_slate_before_branch requires repo_path, base_branch, and git auth header token" >&2
    return 1
  fi

  if ! git -C "$repo_path" \
    -c credential.helper= \
    -c core.askPass= \
    -c "http.extraHeader=Authorization: Basic ${git_auth_basic}" \
    fetch origin "$base_branch"; then
    echo "failed to fetch origin/${base_branch} for clean-slate guard" >&2
    return 1
  fi

  preexisting_count="$(git -C "$repo_path" rev-list --count "origin/$base_branch..HEAD")"
  if ! [[ "$preexisting_count" =~ ^[0-9]+$ ]]; then
    echo "failed to evaluate existing commit distance from origin/${base_branch}" >&2
    return 1
  fi
  if [[ "$preexisting_count" -gt 0 ]]; then
    echo "clean-slate guard blocked: repository has ${preexisting_count} commit(s) ahead of origin/${base_branch} before staging; use a fresh clone/reset first" >&2
    return 1
  fi

  return 0
}

resolve_remote_branch_oid() {
  local repo_path="${1:-}"
  local head_branch="${2:-}"
  local git_auth_basic="${3:-}"

  if [[ -z "$repo_path" || -z "$head_branch" || -z "$git_auth_basic" ]]; then
    return 1
  fi

  git -C "$repo_path" \
    -c credential.helper= \
    -c core.askPass= \
    -c "http.extraHeader=Authorization: Basic ${git_auth_basic}" \
    ls-remote --heads origin "$head_branch" \
    | awk '{print $1}' \
    | head -n1
}

ensure_remote_branch_for_signed_commit() {
  local repo_path="${1:-}"
  local repo_slug="${2:-}"
  local base_branch="${3:-}"
  local head_branch="${4:-}"
  local git_auth_basic="${5:-}"
  local branch_oid base_oid

  if [[ -z "$repo_path" || -z "$repo_slug" || -z "$base_branch" || -z "$head_branch" || -z "$git_auth_basic" ]]; then
    echo "ensure_remote_branch_for_signed_commit requires repo path, repo slug, base branch, head branch, and auth" >&2
    return 1
  fi

  branch_oid="$(resolve_remote_branch_oid "$repo_path" "$head_branch" "$git_auth_basic" || true)"
  if [[ -n "$branch_oid" ]]; then
    printf '%s\n' "$branch_oid"
    return 0
  fi

  base_oid="$(git -C "$repo_path" rev-parse "origin/${base_branch}" 2>/dev/null || true)"
  if [[ -z "$base_oid" ]]; then
    echo "failed to resolve origin/${base_branch} for signed commit branch creation" >&2
    return 1
  fi

  if ! gh api -X POST "repos/${repo_slug}/git/refs" \
    -f "ref=refs/heads/${head_branch}" \
    -f "sha=${base_oid}" >/dev/null 2>&1; then
    branch_oid="$(resolve_remote_branch_oid "$repo_path" "$head_branch" "$git_auth_basic" || true)"
    if [[ -z "$branch_oid" ]]; then
      echo "failed to create remote branch ${head_branch} for signed commit" >&2
      return 1
    fi
    printf '%s\n' "$branch_oid"
    return 0
  fi

  printf '%s\n' "$base_oid"
}

create_api_signed_commit() {
  local repo_path="${1:-}"
  local repo_slug="${2:-}"
  local base_branch="${3:-}"
  local head_branch="${4:-}"
  local commit_msg="${5:-}"
  local git_auth_basic="${6:-}"
  local head_oid tmp_dir graphql_query response
  local -a additions_args=()
  local -a deletions_args=()
  local status path old_path new_path contents_file

  if [[ -z "$repo_path" || -z "$repo_slug" || -z "$base_branch" || -z "$head_branch" || -z "$commit_msg" || -z "$git_auth_basic" ]]; then
    echo "create_api_signed_commit requires repo path, repo slug, base branch, head branch, commit message, and auth" >&2
    return 1
  fi

  head_oid="$(ensure_remote_branch_for_signed_commit "$repo_path" "$repo_slug" "$base_branch" "$head_branch" "$git_auth_basic")" || return 1

  tmp_dir="$(mktemp -d)"
  while IFS= read -r -d '' status; do
    case "$status" in
      A|M|T)
        IFS= read -r -d '' path || {
          echo "malformed staged diff output for signed commit (missing path for status ${status})" >&2
          rm -rf "$tmp_dir"
          return 1
        }
        contents_file="$(mktemp "${tmp_dir}/addition-XXXXXX")"
        if ! git -C "$repo_path" show ":$path" | base64 | tr -d '\n' >"$contents_file"; then
          echo "failed to read staged file for signed commit: $path" >&2
          rm -rf "$tmp_dir"
          return 1
        fi
        additions_args+=(-F "fileAdditions[][path]=$path" -F "fileAdditions[][contents]=@$contents_file")
        ;;
      D)
        IFS= read -r -d '' path || {
          echo "malformed staged diff output for signed commit (missing deletion path)" >&2
          rm -rf "$tmp_dir"
          return 1
        }
        deletions_args+=(-F "fileDeletions[][path]=$path")
        ;;
      R*|C*)
        IFS= read -r -d '' old_path || {
          echo "malformed staged diff output for signed commit (missing rename source path)" >&2
          rm -rf "$tmp_dir"
          return 1
        }
        IFS= read -r -d '' new_path || {
          echo "malformed staged diff output for signed commit (missing rename target path)" >&2
          rm -rf "$tmp_dir"
          return 1
        }
        deletions_args+=(-F "fileDeletions[][path]=$old_path")
        contents_file="$(mktemp "${tmp_dir}/addition-XXXXXX")"
        if ! git -C "$repo_path" show ":$new_path" | base64 | tr -d '\n' >"$contents_file"; then
          echo "failed to read staged renamed file for signed commit: $new_path" >&2
          rm -rf "$tmp_dir"
          return 1
        fi
        additions_args+=(-F "fileAdditions[][path]=$new_path" -F "fileAdditions[][contents]=@$contents_file")
        ;;
      *)
        echo "unsupported staged status for signed commit: $status" >&2
        rm -rf "$tmp_dir"
        return 1
        ;;
    esac
  done < <(git -C "$repo_path" diff --cached --name-status --find-renames --diff-filter=ACDMRT -z)

  if [[ "${#additions_args[@]}" -eq 0 && "${#deletions_args[@]}" -eq 0 ]]; then
    echo "no staged changes available for signed commit" >&2
    rm -rf "$tmp_dir"
    return 1
  fi
  if [[ "${#additions_args[@]}" -eq 0 ]]; then
    additions_args+=(-F "fileAdditions[]")
  fi
  if [[ "${#deletions_args[@]}" -eq 0 ]]; then
    deletions_args+=(-F "fileDeletions[]")
  fi

  graphql_query='mutation(
      $repo: String!,
      $branch: String!,
      $commitMessage: String!,
      $expectedHeadOid: GitObjectID!,
      $fileAdditions: [FileAddition!]!,
      $fileDeletions: [FileDeletion!]!
    ) {
      createCommitOnBranch(
        input: {
          branch: {
            repositoryNameWithOwner: $repo,
            branchName: $branch
          },
          message: { headline: $commitMessage },
          fileChanges: {
            additions: $fileAdditions,
            deletions: $fileDeletions
          },
          expectedHeadOid: $expectedHeadOid
        }
      ) {
        commit {
          url
          oid
          changedFilesIfAvailable
        }
      }
    }'

  response="$(
    gh api graphql \
      -F "repo=${repo_slug}" \
      -F "branch=${head_branch}" \
      -F "commitMessage=${commit_msg}" \
      -F "expectedHeadOid=${head_oid}" \
      "${additions_args[@]}" \
      "${deletions_args[@]}" \
      -F "query=${graphql_query}"
  )" || {
    rm -rf "$tmp_dir"
    return 1
  }

  rm -rf "$tmp_dir"
  if ! printf '%s' "$response" | jq -e '.data.createCommitOnBranch.commit.url // empty | length > 0' >/dev/null 2>&1; then
    echo "signed commit API returned unexpected response" >&2
    printf '%s\n' "$response" >&2
    return 1
  fi

  printf '%s\n' "$response"
}

mint_github_app_token() {
  local app_id="${GITHUB_APP_ID:-}"
  local private_key="${GITHUB_APP_PRIVATE_KEY:-}"
  local install_id="${GITHUB_APP_INSTALLATION_ID:-}"
  local install_owner="${GITHUB_APP_OWNER:-morpho-org}"
  local app_jwt install_json install_code token_json token_code token

  if [[ -z "$app_id" || -z "$private_key" ]]; then
    return 1
  fi

  app_jwt="$(GITHUB_APP_ID="$app_id" GITHUB_APP_PRIVATE_KEY="$private_key" node - <<'NODE'
const crypto = require("crypto");
const appId = process.env.GITHUB_APP_ID;
const keyRaw = process.env.GITHUB_APP_PRIVATE_KEY || "";
const key = keyRaw.replace(/\\n/g, "\n");
const now = Math.floor(Date.now() / 1000);
const header = { alg: "RS256", typ: "JWT" };
const payload = { iat: now - 60, exp: now + 540, iss: appId };
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const input = `${b64(header)}.${b64(payload)}`;
const signature = crypto.createSign("RSA-SHA256").update(input).sign(key, "base64url");
process.stdout.write(`${input}.${signature}`);
NODE
  )" || return 1

  if [[ -z "$install_id" ]]; then
    install_json="$(mktemp)"
    install_code="$(curl -sS -o "$install_json" -w '%{http_code}' \
      -H "Authorization: Bearer ${app_jwt}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/app/installations" || true)"
    if [[ "$install_code" != "200" ]]; then
      rm -f "$install_json"
      return 1
    fi
    install_id="$(jq -r --arg owner "$install_owner" '.[] | select(.account.login==$owner) | .id' "$install_json" | head -n1)"
    rm -f "$install_json"
  fi

  if [[ -z "$install_id" ]]; then
    return 1
  fi

  token_json="$(mktemp)"
  token_code="$(curl -sS -o "$token_json" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${app_jwt}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/${install_id}/access_tokens" || true)"
  if [[ "$token_code" != "201" && "$token_code" != "200" ]]; then
    rm -f "$token_json"
    return 1
  fi
  token="$(jq -r '.token // empty' "$token_json")"
  rm -f "$token_json"
  if [[ -z "$token" ]]; then
    return 1
  fi
  printf '%s\n' "$token"
}

github_repo_access_ok() {
  local token="${1:-}"
  local repo="${2:-}"
  local probe_json probe_code

  GITHUB_REPO_ACCESS_LAST_CODE=""
  if [[ -z "$token" || -z "$repo" ]]; then
    return 1
  fi

  probe_json="$(mktemp)"
  probe_code="$(curl -sS -o "$probe_json" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${repo}" || true)"
  rm -f "$probe_json"
  GITHUB_REPO_ACCESS_LAST_CODE="$probe_code"

  [[ "$probe_code" == "200" ]]
}

resolve_auth_token_for_repo() {
  local repo="${1:-}"
  local env_token app_token env_probe_code app_probe_code

  env_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [[ -n "$env_token" ]] && github_repo_access_ok "$env_token" "$repo"; then
    printf '%s\n' "$env_token"
    return 0
  fi
  env_probe_code="${GITHUB_REPO_ACCESS_LAST_CODE:-}"

  app_token="$(mint_github_app_token || true)"
  if [[ -n "$app_token" ]] && github_repo_access_ok "$app_token" "$repo"; then
    printf '%s\n' "$app_token"
    return 0
  fi
  app_probe_code="${GITHUB_REPO_ACCESS_LAST_CODE:-}"

  if [[ -n "$env_token" && "$env_probe_code" != "401" && "$env_probe_code" != "403" && "$env_probe_code" != "404" ]]; then
    printf '%s\n' "$env_token"
    return 0
  fi
  if [[ -n "$app_token" && "$app_probe_code" != "401" && "$app_probe_code" != "403" && "$app_probe_code" != "404" ]]; then
    printf '%s\n' "$app_token"
    return 0
  fi

  return 1
}

resolve_slack_notify_user_id() {
  if [[ -n "${AUTO_PR_NOTIFY_USER_ID:-}" ]]; then
    printf '%s\n' "$AUTO_PR_NOTIFY_USER_ID"
    return 0
  fi
  if [[ -n "${SLACK_ALLOWED_USER_IDS:-}" ]]; then
    split_csv_nonempty_lines "$SLACK_ALLOWED_USER_IDS" | head -n1
    return 0
  fi
  return 1
}

resolve_slack_dm_channel_id() {
  local user_id="$1"
  local token="$2"
  local tmp_json http_code channel_id
  tmp_json="$(mktemp)"
  http_code="$(
    curl -sS -o "$tmp_json" -w '%{http_code}' \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json; charset=utf-8" \
      --data "{\"users\":\"${user_id}\"}" \
      https://slack.com/api/conversations.open || true
  )"
  if [[ "$http_code" != "200" ]]; then
    rm -f "$tmp_json"
    return 1
  fi
  if [[ "$(jq -r '.ok // false' "$tmp_json")" != "true" ]]; then
    rm -f "$tmp_json"
    return 1
  fi
  channel_id="$(jq -r '.channel.id // empty' "$tmp_json")"
  rm -f "$tmp_json"
  if [[ -z "$channel_id" ]]; then
    return 1
  fi
  printf '%s\n' "$channel_id"
}

send_slack_pr_notify() {
  local text="$1"
  local enabled strict user_id token channel_id payload tmp_json http_code
  enabled="${AUTO_PR_NOTIFY_ENABLED:-1}"
  strict="${AUTO_PR_NOTIFY_STRICT:-1}"
  if ! truthy "$enabled"; then
    return 0
  fi

  user_id="$(resolve_slack_notify_user_id || true)"
  token="${SLACK_BOT_TOKEN:-}"
  if [[ -z "$user_id" || -z "$token" ]]; then
    if truthy "$strict"; then
      echo "auto-pr notify blocked: missing AUTO_PR_NOTIFY_USER_ID/SLACK_ALLOWED_USER_IDS or SLACK_BOT_TOKEN" >&2
      return 1
    fi
    return 0
  fi

  channel_id="$(resolve_slack_dm_channel_id "$user_id" "$token" || true)"
  if [[ -z "$channel_id" ]]; then
    if truthy "$strict"; then
      echo "auto-pr notify blocked: failed to open Slack DM channel for ${user_id}" >&2
      return 1
    fi
    return 0
  fi

  payload="$(jq -n --arg ch "$channel_id" --arg txt "$text" '{channel:$ch,text:$txt,mrkdwn:true}')"
  tmp_json="$(mktemp)"
  http_code="$(
    curl -sS -o "$tmp_json" -w '%{http_code}' \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json; charset=utf-8" \
      --data "$payload" \
      https://slack.com/api/chat.postMessage || true
  )"
  if [[ "$http_code" != "200" || "$(jq -r '.ok // false' "$tmp_json")" != "true" ]]; then
    rm -f "$tmp_json"
    if truthy "$strict"; then
      echo "auto-pr notify blocked: failed to send Slack DM notification" >&2
      return 1
    fi
    return 0
  fi
  rm -f "$tmp_json"
  return 0
}

is_repo_allowlisted() {
  local repo="$1"
  local allow_csv="${2:-morpho-org/*}"
  local pattern
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    case "$repo" in
      $pattern) return 0 ;;
    esac
  done < <(split_csv_nonempty_lines "$allow_csv")
  return 1
}

collect_linear_issue_refs() {
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi
  {
    printf '%s\n' "$@" | grep -Eoi '[A-Za-z][A-Za-z0-9]+-[0-9]+' || true
  } \
    | tr '[:lower:]' '[:upper:]' \
    | awk 'NF > 0 && !seen[$0]++'
}

resolve_linear_issue_refs() {
  local body_file="${1:-}"
  shift || true
  local -a refs=()
  local line body_text
  if [[ "$#" -gt 0 ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      refs+=("$line")
    done < <(collect_linear_issue_refs "$@")
  fi
  if [[ -n "$body_file" && -f "$body_file" ]]; then
    body_text="$(cat "$body_file")"
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      refs+=("$line")
    done < <(collect_linear_issue_refs "$body_text")
  fi
  if [[ "${#refs[@]}" -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "${refs[@]}" | awk 'NF > 0 && !seen[$0]++'
}

apply_pr_tracking_label() {
  local repo_slug="${1:-}"
  local pr_ref="${2:-}"
  local label="${3:-}"
  local output status
  local -a cmd

  if [[ -z "$repo_slug" || -z "$pr_ref" || -z "$label" ]]; then
    return 0
  fi

  cmd=(
    gh pr edit "$pr_ref"
    --repo "$repo_slug"
    --add-label "$label"
  )

  set +e
  output="$("${cmd[@]}" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]] && printf '%s' "$output" | grep -Eqi '(401|403|bad credentials|authentication failed|requires authentication|expired)'; then
    if declare -F refresh_auth_context >/dev/null 2>&1 && refresh_auth_context; then
      set +e
      output="$("${cmd[@]}" 2>&1)"
      status=$?
      set -e
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  return 0
}

apply_ticket_tracking_labels() {
  local label="${1:-}"
  shift || true
  local api_cmd ticket_ref output

  if [[ -z "$label" || "$#" -eq 0 ]]; then
    return 0
  fi

  api_cmd="${AUTO_PR_LINEAR_TICKET_API:-${SCRIPT_DIR}/linear-ticket-api.sh}"
  if [[ ! -x "$api_cmd" ]]; then
    echo "missing executable Linear ticket API helper: $api_cmd" >&2
    return 1
  fi

  for ticket_ref in "$@"; do
    [[ -n "$ticket_ref" ]] || continue
    if ! output="$("$api_cmd" issue ensure-label "$ticket_ref" "$label" 2>&1)"; then
      printf '%s\n' "$output" >&2
      echo "failed to ensure Linear label for ${ticket_ref}" >&2
      return 1
    fi
    printf 'linear_ticket_label=%s\tlabel=%s\n' "$ticket_ref" "$label"
  done
  return 0
}

REPO_INPUT=""
REPO_PATH=""
TITLE=""
COMMIT_MSG=""
CONFIDENCE=""
BODY_INLINE=""
BODY_FILE=""
BASE_BRANCH="${BASE_BRANCH:-main}"
HEAD_BRANCH=""
CHECK_CMD=""
FILES_CSV=""
DRAFT=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_INPUT="${2:-}"
      shift 2
      ;;
    --path)
      REPO_PATH="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --commit)
      COMMIT_MSG="${2:-}"
      shift 2
      ;;
    --confidence)
      CONFIDENCE="${2:-}"
      shift 2
      ;;
    --body)
      BODY_INLINE="${2:-}"
      shift 2
      ;;
    --body-file)
      BODY_FILE="${2:-}"
      shift 2
      ;;
    --base)
      BASE_BRANCH="${2:-}"
      shift 2
      ;;
    --branch)
      HEAD_BRANCH="${2:-}"
      shift 2
      ;;
    --check-cmd)
      CHECK_CMD="${2:-}"
      shift 2
      ;;
    --files)
      FILES_CSV="${2:-}"
      shift 2
      ;;
    --draft)
      DRAFT=1
      shift
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
      echo "unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$REPO_INPUT" || -z "$TITLE" || -z "$COMMIT_MSG" || -z "$CONFIDENCE" ]]; then
  usage
  exit 1
fi

if [[ -n "$BODY_INLINE" && -n "$BODY_FILE" ]]; then
  echo "use one of --body or --body-file" >&2
  exit 1
fi

TITLE_RAW="$TITLE"
TITLE="$(ensure_pr_title_prefix "$TITLE_RAW")"

REPO_SLUG="$(normalize_repo_slug "$REPO_INPUT")"
if ! [[ "$REPO_SLUG" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo "invalid --repo value: $REPO_INPUT" >&2
  exit 1
fi

MIN_CONFIDENCE="${AUTO_PR_MIN_CONFIDENCE:-85}"
if ! parse_int_in_range "$MIN_CONFIDENCE" 0 100; then
  echo "AUTO_PR_MIN_CONFIDENCE must be integer in [0,100]" >&2
  exit 1
fi
if ! parse_int_in_range "$CONFIDENCE" 0 100; then
  echo "--confidence must be integer in [0,100]" >&2
  exit 1
fi
if ! truthy "${AUTO_PR_ENABLED:-1}"; then
  echo "auto-pr gate blocked: AUTO_PR_ENABLED=${AUTO_PR_ENABLED:-0}" >&2
  exit 2
fi
if [[ "$CONFIDENCE" -lt "$MIN_CONFIDENCE" ]]; then
  echo "auto-pr gate blocked: confidence ${CONFIDENCE} < required ${MIN_CONFIDENCE}" >&2
  exit 2
fi

ALLOWLIST="${AUTO_PR_ALLOWED_REPOS:-morpho-org/*}"
if ! is_repo_allowlisted "$REPO_SLUG" "$ALLOWLIST"; then
  echo "auto-pr gate blocked: repo not allowlisted ($REPO_SLUG)" >&2
  exit 2
fi

if [[ -z "$REPO_PATH" ]]; then
  clone_script="/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh"
  if [[ ! -x "$clone_script" ]]; then
    echo "missing executable clone helper: $clone_script" >&2
    exit 1
  fi
  clone_output="$(bash "$clone_script" --repo "$REPO_SLUG")"
  REPO_PATH="$(printf '%s\n' "$clone_output" | awk -F= '$1=="path"{print $2; exit}')"
fi

if [[ -z "$REPO_PATH" || ! -d "$REPO_PATH" ]]; then
  echo "invalid repo path: $REPO_PATH" >&2
  exit 1
fi

if ! git -C "$REPO_PATH" rev-parse --git-dir >/dev/null 2>&1; then
  echo "path is not a git repository: $REPO_PATH" >&2
  exit 1
fi

# Ensure commits can be authored in ephemeral runtime clones.
if [[ -z "$(git -C "$REPO_PATH" config --get user.name || true)" ]]; then
  git -C "$REPO_PATH" config user.name "${AUTO_PR_GIT_USER_NAME:-OpenClaw SRE Bot}"
fi
if [[ -z "$(git -C "$REPO_PATH" config --get user.email || true)" ]]; then
  git -C "$REPO_PATH" config user.email "${AUTO_PR_GIT_USER_EMAIL:-openclaw-sre-bot@morpho.dev}"
fi

origin_raw="$(git -C "$REPO_PATH" remote get-url origin 2>/dev/null || true)"
if [[ -n "$origin_raw" ]]; then
  origin_slug="$(normalize_remote_repo_slug "$origin_raw")"
  if [[ "$origin_slug" != "$REPO_SLUG" ]]; then
    echo "repo mismatch: origin=$origin_slug expected=$REPO_SLUG" >&2
    exit 1
  fi
fi
git -C "$REPO_PATH" remote set-url origin "https://github.com/${REPO_SLUG}.git"

if [[ -n "$CHECK_CMD" ]]; then
  (
    cd "$REPO_PATH"
    bash -lc "$CHECK_CMD"
  )
fi

if [[ -z "$(git -C "$REPO_PATH" status --porcelain)" ]]; then
  echo "no local changes to commit in $REPO_PATH" >&2
  exit 1
fi

if [[ -z "$HEAD_BRANCH" ]]; then
  branch_prefix="${AUTO_PR_BRANCH_PREFIX:-openclaw/sre-auto}"
  branch_fragment="$(sanitize_branch_fragment "$TITLE_RAW")"
  timestamp="$(date -u +%Y%m%d-%H%M%S)"
  HEAD_BRANCH="${branch_prefix}/${timestamp}"
  if [[ -n "$branch_fragment" ]]; then
    HEAD_BRANCH="${HEAD_BRANCH}-${branch_fragment}"
  fi
fi
HEAD_BRANCH="$(sanitize_branch_fragment "$HEAD_BRANCH")"
if [[ -z "$HEAD_BRANCH" ]]; then
  echo "invalid head branch after normalization" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'repo=%s\n' "$REPO_SLUG"
  printf 'path=%s\n' "$REPO_PATH"
  printf 'base=%s\n' "$BASE_BRANCH"
  printf 'branch=%s\n' "$HEAD_BRANCH"
  printf 'confidence=%s\n' "$CONFIDENCE"
  printf 'dry_run=1\n'
  exit 0
fi

refresh_auth_context() {
  AUTH_TOKEN="$(resolve_auth_token_for_repo "$REPO_SLUG" || true)"
  if [[ -z "$AUTH_TOKEN" ]]; then
    echo "missing or invalid GitHub auth token for ${REPO_SLUG} (GITHUB_TOKEN/GH_TOKEN or GitHub App env)" >&2
    return 1
  fi
  export GITHUB_TOKEN="$AUTH_TOKEN"
  export GH_TOKEN="$AUTH_TOKEN"
  git_auth_basic="$(printf 'x-access-token:%s' "$AUTH_TOKEN" | base64 | tr -d '\n')"
  return 0
}

if ! refresh_auth_context; then
  exit 1
fi
if ! assert_clean_slate_before_branch "$REPO_PATH" "$BASE_BRANCH" "$git_auth_basic"; then
  exit 1
fi

if ! send_slack_pr_notify "OpenClaw SRE auto-PR starting. repo=${REPO_SLUG} base=${BASE_BRANCH} confidence=${CONFIDENCE}/100 title=${TITLE}"; then
  exit 1
fi

if git -C "$REPO_PATH" show-ref --verify --quiet "refs/heads/${HEAD_BRANCH}"; then
  git -C "$REPO_PATH" checkout "$HEAD_BRANCH"
else
  git -C "$REPO_PATH" checkout -b "$HEAD_BRANCH"
fi

if [[ -n "$FILES_CSV" ]]; then
  mapfile -t stage_files < <(split_csv_nonempty_lines "$FILES_CSV")
  if [[ "${#stage_files[@]}" -eq 0 ]]; then
    echo "--files provided but empty after parsing" >&2
    exit 1
  fi
  git -C "$REPO_PATH" add -- "${stage_files[@]}"
else
  git -C "$REPO_PATH" add -A
fi

if git -C "$REPO_PATH" diff --cached --quiet; then
  echo "no staged changes to commit in $REPO_PATH" >&2
  exit 1
fi

if git -C "$REPO_PATH" diff --cached \
  | grep -E '(xox[baprs]-|xapp-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' >/dev/null; then
  echo "secret-like content detected in staged diff; refusing to create PR" >&2
  exit 1
fi

if truthy "${AUTO_PR_SIGNED_COMMITS:-1}"; then
  if ! refresh_auth_context; then
    exit 1
  fi
  signed_commit_response="$(create_api_signed_commit "$REPO_PATH" "$REPO_SLUG" "$BASE_BRANCH" "$HEAD_BRANCH" "$COMMIT_MSG" "$git_auth_basic" || true)"
  if [[ -z "$signed_commit_response" ]]; then
    if ! refresh_auth_context; then
      exit 1
    fi
    signed_commit_response="$(create_api_signed_commit "$REPO_PATH" "$REPO_SLUG" "$BASE_BRANCH" "$HEAD_BRANCH" "$COMMIT_MSG" "$git_auth_basic" || true)"
  fi
  if [[ -z "$signed_commit_response" ]]; then
    echo "failed to create signed commit via GitHub API (set AUTO_PR_SIGNED_COMMITS=0 to use local git commit fallback)" >&2
    exit 1
  fi
  signed_commit_url="$(printf '%s' "$signed_commit_response" | jq -r '.data.createCommitOnBranch.commit.url // empty')"
  if [[ -n "$signed_commit_url" ]]; then
    echo "signed commit created: ${signed_commit_url}"
  fi
else
  git -C "$REPO_PATH" commit -m "$COMMIT_MSG"

  if ! refresh_auth_context; then
    exit 1
  fi
  if ! sync_branch_with_base "$REPO_PATH" "$BASE_BRANCH" "$git_auth_basic"; then
    echo "failed to sync ${HEAD_BRANCH} with origin/${BASE_BRANCH} before PR creation" >&2
    exit 1
  fi

  if ! refresh_auth_context; then
    exit 1
  fi
  git -C "$REPO_PATH" \
    -c credential.helper= \
    -c core.askPass= \
    -c "http.extraHeader=Authorization: Basic ${git_auth_basic}" \
    push -u origin "$HEAD_BRANCH"
fi

tmp_body=""
cleanup() {
  [[ -n "${tmp_body:-}" && -f "$tmp_body" ]] && rm -f "$tmp_body"
}
trap cleanup EXIT

if [[ -n "$BODY_FILE" ]]; then
  if [[ ! -f "$BODY_FILE" ]]; then
    echo "missing --body-file path: $BODY_FILE" >&2
    exit 1
  fi
  PR_BODY_FILE="$BODY_FILE"
elif [[ -n "$BODY_INLINE" ]]; then
  tmp_body="$(mktemp)"
  printf '%s\n' "$BODY_INLINE" >"$tmp_body"
  PR_BODY_FILE="$tmp_body"
else
  tmp_body="$(mktemp)"
  cat >"$tmp_body" <<EOF
## Summary
- Automated remediation PR from OpenClaw SRE.
- Confidence score: ${CONFIDENCE}/100 (threshold: ${MIN_CONFIDENCE}).

## Validation
- Incident triage + targeted checks completed in-cluster before patch.

## Safety
- Secrets redaction checks passed before push.
EOF
  PR_BODY_FILE="$tmp_body"
fi

TRACKING_LABEL="${AUTO_PR_TRACKING_LABEL:-openclaw-sre}"
LINEAR_ISSUE_REFS=()
while IFS= read -r linear_ref; do
  [[ -n "$linear_ref" ]] || continue
  LINEAR_ISSUE_REFS+=("$linear_ref")
done < <(
  resolve_linear_issue_refs "$PR_BODY_FILE" "$TITLE_RAW" "$TITLE" "$COMMIT_MSG" "$HEAD_BRANCH"
)

pr_cmd=(
  gh pr create
  --repo "$REPO_SLUG"
  --base "$BASE_BRANCH"
  --head "$HEAD_BRANCH"
  --title "$TITLE"
  --body-file "$PR_BODY_FILE"
)
if [[ "$DRAFT" -eq 1 ]]; then
  pr_cmd+=(--draft)
fi

if ! refresh_auth_context; then
  exit 1
fi
set +e
pr_output="$("${pr_cmd[@]}" 2>&1)"
pr_status=$?
set -e
if [[ "$pr_status" -ne 0 ]] && printf '%s' "$pr_output" | grep -Eqi '(401|403|bad credentials|authentication failed|requires authentication|expired)'; then
  if refresh_auth_context; then
    set +e
    pr_output="$("${pr_cmd[@]}" 2>&1)"
    pr_status=$?
    set -e
  fi
fi
if [[ "$pr_status" -ne 0 ]]; then
  printf '%s\n' "$pr_output" >&2
  echo "failed to create PR" >&2
  exit 1
fi
pr_url="$(printf '%s\n' "$pr_output" | tail -n1)"
if [[ -z "$pr_url" ]]; then
  echo "failed to create PR" >&2
  exit 1
fi

if [[ -n "$TRACKING_LABEL" ]]; then
  if ! apply_pr_tracking_label "$REPO_SLUG" "$pr_url" "$TRACKING_LABEL"; then
    echo "failed to add tracking label '${TRACKING_LABEL}' to PR: ${pr_url}" >&2
    exit 1
  fi
  if [[ "${#LINEAR_ISSUE_REFS[@]}" -gt 0 ]]; then
    if ! apply_ticket_tracking_labels "$TRACKING_LABEL" "${LINEAR_ISSUE_REFS[@]}"; then
      echo "failed to add tracking label '${TRACKING_LABEL}' on linked Linear ticket(s)" >&2
      exit 1
    fi
  fi
fi

send_slack_pr_notify "OpenClaw SRE auto-PR created. repo=${REPO_SLUG} branch=${HEAD_BRANCH} url=${pr_url}" || true

printf 'repo=%s\n' "$REPO_SLUG"
printf 'path=%s\n' "$REPO_PATH"
printf 'base=%s\n' "$BASE_BRANCH"
printf 'branch=%s\n' "$HEAD_BRANCH"
printf 'confidence=%s\n' "$CONFIDENCE"
printf 'pr_url=%s\n' "$pr_url"
printf 'tracking_label=%s\n' "${TRACKING_LABEL:-}"
