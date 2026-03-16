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
  AUTO_PR_BODY_MAX_LINES=<int>       (default: 120; compact oversized PR bodies)
  AUTO_PR_BODY_MAX_CHARS=<int>       (default: 12000; compact oversized PR bodies)
  AUTO_PR_SIGNED_COMMITS=1|0         (default: 1; GitHub API signed commit flow)
  AUTO_PR_NOTIFY_ENABLED=1|0         (default: 1)
  AUTO_PR_NOTIFY_USER_ID=<U...>      (default: first SLACK_ALLOWED_USER_IDS value)
  AUTO_PR_NOTIFY_STRICT=1|0          (default: 1)
  AUTO_PR_GIT_USER_NAME=<name>       (default: OpenClaw SRE Bot)
  AUTO_PR_GIT_USER_EMAIL=<email>     (default: openclaw-sre-bot@morpho.dev)
  AUTO_PR_TRACKING_LABEL=<label>     (default: openclaw-sre; empty disables)
  AUTO_PR_LINEAR_TICKET_API=<path>   (default: ./linear-ticket-api.sh next to this script)
  AUTO_PR_LINEAR_CREATE=1|0          (default: 1; create Linear issue when missing)
  AUTO_PR_LINEAR_STRICT=1|0          (default: 1; fail PR creation if Linear flow fails)
  AUTO_PR_LINEAR_TEAM=<name>         (default: Platform; override per runtime as needed)
  AUTO_PR_LINEAR_PROJECT=<name>      (default: [PLATFORM] Backlog; override per runtime as needed)
  AUTO_PR_LINEAR_ASSIGNEE=<user|me>  (default: me; override per runtime as needed)
  AUTO_PR_LINEAR_STATE=<name>        (default: In Progress)
  AUTO_PR_LINEAR_LABELS=<labels>     (default: openclaw-sre|Bug|Monitoring|Improvement)
  AUTO_PR_LINEAR_ATTACH_PR=1|0       (default: 1; add PR link/comment back to Linear)
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

strip_pr_title_prefix() {
  local raw="${1:-}"
  local prefix_lower suffix
  raw="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  prefix_lower="$(printf '%s' "${raw:0:${#PR_TITLE_PREFIX}}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$prefix_lower" == "$(printf '%s' "$PR_TITLE_PREFIX" | tr '[:upper:]' '[:lower:]')" ]]; then
    suffix="${raw:${#PR_TITLE_PREFIX}}"
    printf '%s\n' "$(printf '%s' "$suffix" | sed -E 's/^[[:space:]]+//')"
    return 0
  fi
  printf '%s\n' "$raw"
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

validate_linear_selector_value() {
  local env_name="$1"
  local value="${2:-}"
  local pattern="${3:-}"
  [[ -n "$env_name" ]] || return 1
  [[ -n "$value" ]] || return 0
  if [[ "$pattern" == "__SAFE_TEXT__" ]]; then
    case "$value" in
      *[$'\n\r\t`\\$;&|<>']*)
        printf 'invalid %s value: %s\n' "$env_name" "$value" >&2
        return 1
        ;;
    esac
    return 0
  fi
  printf '%s\n' "$value" | grep -Eq -- "$pattern" || {
    printf 'invalid %s value: %s\n' "$env_name" "$value" >&2
    return 1
  }
}

validate_linear_labels_value() {
  local raw="${1:-}" label
  [[ -n "$raw" ]] || return 0
  while IFS= read -r label; do
    [[ -n "$label" ]] || continue
    validate_linear_selector_value "AUTO_PR_LINEAR_LABELS" "$label" "__SAFE_TEXT__" || return 1
  done < <(printf '%s\n' "$raw" | tr '|,' '\n')
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

normalize_pr_body_line() {
  local line="${1:-}"
  local max_chars="${2:-220}"
  line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/^[-*][[:space:]]+//; s/^`+|`+$//g')"
  if [[ -z "$line" ]]; then
    return 0
  fi
  if ! [[ "$max_chars" =~ ^[0-9]+$ ]] || [[ "$max_chars" -lt 20 ]]; then
    max_chars=220
  fi
  if [[ "${#line}" -le "$max_chars" ]]; then
    printf '%s\n' "$line"
    return 0
  fi
  printf '%s...\n' "${line:0:$((max_chars - 3))}"
}

extract_pr_body_section_lines() {
  local body_file="${1:-}"
  local section="${2:-}"
  local max_lines="${3:-6}"
  if [[ -z "$body_file" || ! -f "$body_file" || -z "$section" ]]; then
    return 0
  fi
  if ! [[ "$max_lines" =~ ^[0-9]+$ ]] || [[ "$max_lines" -lt 1 ]]; then
    max_lines=6
  fi
  awk -v target="$(printf '%s' "$section" | tr '[:upper:]' '[:lower:]')" -v max="$max_lines" '
    BEGIN { in_section = 0; count = 0; }
    {
      line = $0
      line_l = tolower(line)
      if (!in_section && line_l ~ ("^##[[:space:]]*" target "([[:space:]]|$)")) {
        in_section = 1
        next
      }
      if (in_section && line ~ /^##[[:space:]]+/) {
        exit
      }
      if (!in_section) {
        next
      }
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      if (line == "") {
        next
      }
      if (line ~ /^```/) {
        next
      }
      if (line ~ /^(# Source:|apiVersion:|kind:|metadata:|spec:|---)/) {
        next
      }
      print line
      count++
      if (count >= max) {
        exit
      }
    }
  ' "$body_file"
}

extract_pr_body_candidate_lines() {
  local body_file="${1:-}"
  local max_lines="${2:-6}"
  if [[ -z "$body_file" || ! -f "$body_file" ]]; then
    return 0
  fi
  if ! [[ "$max_lines" =~ ^[0-9]+$ ]] || [[ "$max_lines" -lt 1 ]]; then
    max_lines=6
  fi
  awk -v max="$max_lines" '
    BEGIN { count = 0; }
    {
      line = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      if (line == "") {
        next
      }
      if (line ~ /^##[[:space:]]+/ || line ~ /^```/) {
        next
      }
      if (line ~ /^(# Source:|apiVersion:|kind:|metadata:|spec:|---)/) {
        next
      }
      print line
      count++
      if (count >= max) {
        exit
      }
    }
  ' "$body_file"
}

compact_pr_body_file() {
  local body_file="${1:-}"
  local max_lines="${AUTO_PR_BODY_MAX_LINES:-120}"
  local max_chars="${AUTO_PR_BODY_MAX_CHARS:-12000}"
  local body_lines body_chars manifest_markers tmp_file line
  local -a summary_lines=()
  local -a changes_lines=()
  local -a linear_refs=()

  if [[ -z "$body_file" || ! -f "$body_file" ]]; then
    return 0
  fi
  if ! [[ "$max_lines" =~ ^[0-9]+$ ]] || [[ "$max_lines" -lt 40 ]]; then
    max_lines=120
  fi
  if ! [[ "$max_chars" =~ ^[0-9]+$ ]] || [[ "$max_chars" -lt 2000 ]]; then
    max_chars=12000
  fi

  body_lines="$(wc -l <"$body_file" | tr -d ' ')"
  body_chars="$(wc -c <"$body_file" | tr -d ' ')"
  manifest_markers="$(grep -Ec '^(# Source:|apiVersion:|kind:|metadata:|spec:|---)' "$body_file" || true)"

  if [[ "$body_lines" -le "$max_lines" && "$body_chars" -le "$max_chars" && "$manifest_markers" -lt 30 ]]; then
    return 0
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    summary_lines+=("$line")
  done < <(extract_pr_body_section_lines "$body_file" "summary" 6)

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    changes_lines+=("$line")
  done < <(extract_pr_body_section_lines "$body_file" "changes" 8)

  if [[ "${#changes_lines[@]}" -eq 0 ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      changes_lines+=("$line")
    done < <(extract_pr_body_section_lines "$body_file" "scope" 6)
  fi

  if [[ "${#summary_lines[@]}" -eq 0 ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      summary_lines+=("$line")
    done < <(extract_pr_body_candidate_lines "$body_file" 6)
  fi

  if [[ "${#changes_lines[@]}" -eq 0 ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      changes_lines+=("$line")
    done < <(extract_pr_body_candidate_lines "$body_file" 8)
  fi

  if [[ "${#summary_lines[@]}" -eq 0 ]]; then
    summary_lines+=("Automated remediation/update PR.")
  fi
  if [[ "${#changes_lines[@]}" -eq 0 ]]; then
    changes_lines+=("See PR file diff for exact code/config changes.")
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    linear_refs+=("$line")
  done < <(
    grep -Eoi '[A-Za-z][A-Za-z0-9]+-[0-9]+' "$body_file" 2>/dev/null \
      | tr '[:lower:]' '[:upper:]' \
      | awk 'NF > 0 && !seen[$0]++'
  )

  tmp_file="$(mktemp)"
  {
    echo "## Summary"
    for line in "${summary_lines[@]}"; do
      line="$(normalize_pr_body_line "$line" 220)"
      [[ -n "$line" ]] || continue
      printf '%s\n' "- ${line}"
    done
    echo
    echo "## Changes"
    for line in "${changes_lines[@]}"; do
      line="$(normalize_pr_body_line "$line" 220)"
      [[ -n "$line" ]] || continue
      printf '%s\n' "- ${line}"
    done
    echo
    echo "## Validation"
    echo "- Validation output was large and has been omitted from PR body."
    echo "- Use CI/job logs and PR file diff for full details."
    if [[ "${#linear_refs[@]}" -gt 0 ]]; then
      echo
      echo "## Linear"
      for line in "${linear_refs[@]}"; do
        printf '%s\n' "- ${line}"
      done
    fi
  } >"$tmp_file"

  mv -f "$tmp_file" "$body_file"
  echo "auto-pr: compacted oversized PR body (${body_lines} lines, ${body_chars} chars)" >&2
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

linear_ticket_scope_token() {
  local ticket_ref="${1:-}"
  printf '%s\n' "$ticket_ref" | tr '[:lower:]' '[:upper:]'
}

is_linear_ticket_ref() {
  [[ "${1:-}" =~ ^[A-Za-z][A-Za-z0-9]+-[0-9]+$ ]]
}

escape_extended_regex() {
  local raw="${1:-}"
  printf '%s\n' "$raw" | sed -E 's/[][{}().^$+*?|\\-]/\\&/g'
}

parse_conventional_commit_title() {
  local raw="${1:-}"
  local stripped regex_scoped regex_plain
  local kind type scope summary

  stripped="$(strip_pr_title_prefix "$raw")"
  stripped="$(printf '%s' "$stripped" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  kind="other"
  type=""
  scope=""
  summary="$stripped"

  regex_scoped='^(feat|fix|refactor|build|ci|chore|docs|style|perf|test)\(([^)]*)\):[[:space:]]*(.+)$'
  regex_plain='^(feat|fix|refactor|build|ci|chore|docs|style|perf|test):[[:space:]]*(.+)$'
  if [[ "$stripped" =~ $regex_scoped ]]; then
    kind="scoped"
    type="${BASH_REMATCH[1]}"
    scope="$(printf '%s' "${BASH_REMATCH[2]}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    summary="${BASH_REMATCH[3]}"
  elif [[ "$stripped" =~ $regex_plain ]]; then
    kind="plain"
    type="${BASH_REMATCH[1]}"
    scope=""
    summary="${BASH_REMATCH[2]}"
  fi

  printf 'kind=%s\n' "$kind"
  printf 'type=%s\n' "$type"
  printf 'scope=%s\n' "$scope"
  printf 'summary=%s\n' "$summary"
}

extract_named_output_value() {
  local key="${1:-}"
  local raw="${2:-}"
  [[ -n "$key" ]] || return 1
  printf '%s\n' "$raw" \
    | awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }'
}

capture_command_output() {
  local __target_var="${1:-}"
  shift || true
  local __output __status
  [[ "$__target_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    echo "invalid capture target variable: $__target_var" >&2
    return 1
  }

  set +e
  __output="$("$@")"
  __status=$?
  set -e

  printf -v "$__target_var" '%s' "$__output"
  return "$__status"
}

parse_linear_create_field() {
  local output="${1:-}"
  local jq_filter="${2:-}"
  local field_name="${3:-field}"
  local value

  set +e
  value="$(printf '%s\n' "$output" | jq -r "$jq_filter")"
  local status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "failed to parse Linear issue ${field_name} from helper output" >&2
    return 1
  fi
  if [[ -z "$value" ]]; then
    echo "failed to parse Linear issue ${field_name} from helper output" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

ensure_linear_ticket_in_conventional_title() {
  local raw="${1:-}"
  local ticket_ref="${2:-}"
  local ticket_token stripped scope type summary kind ticket_regex parsed_title
  local stripped_lower ticket_token_regex

  parsed_title="$(parse_conventional_commit_title "$raw")"
  kind="$(extract_named_output_value kind "$parsed_title")"
  type="$(extract_named_output_value type "$parsed_title")"
  scope="$(extract_named_output_value scope "$parsed_title")"
  summary="$(extract_named_output_value summary "$parsed_title")"
  stripped="$(strip_pr_title_prefix "$raw")"
  stripped="$(printf '%s' "$stripped" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  [[ -n "$ticket_ref" ]] || {
    printf '%s\n' "$stripped"
    return 0
  }
  if ! is_linear_ticket_ref "$ticket_ref"; then
    printf '%s\n' "$stripped"
    return 0
  fi

  ticket_token="$(linear_ticket_scope_token "$ticket_ref")"
  stripped_lower="$(printf '%s' "$stripped" | tr '[:upper:]' '[:lower:]')"
  ticket_token_regex="$(escape_extended_regex "$(printf '%s' "$ticket_token" | tr '[:upper:]' '[:lower:]')")"
  ticket_regex="$(escape_extended_regex "$(printf '%s' "$ticket_ref" | tr '[:upper:]' '[:lower:]')")"
  if printf '%s\n' "$stripped_lower" | grep -Eq "[(][^)]*${ticket_token_regex}[^)]*[)]"; then
    printf '%s\n' "$stripped"
    return 0
  fi
  if [[ "$stripped_lower" =~ (^|[^[:alnum:]])${ticket_regex}([^[:alnum:]]|$) ]]; then
    printf '%s\n' "$stripped"
    return 0
  fi

  if [[ "$kind" == "scoped" ]]; then
    if [[ -n "$scope" ]]; then
      printf '%s(%s:%s): %s\n' "$type" "$scope" "$ticket_token" "$summary"
    else
      printf '%s(%s): %s\n' "$type" "$ticket_token" "$summary"
    fi
    return 0
  fi

  if [[ "$kind" == "plain" ]]; then
    printf '%s(%s): %s\n' "$type" "$ticket_token" "$summary"
    return 0
  fi

  printf 'chore(%s): %s\n' "$ticket_token" "$stripped"
}

build_linear_issue_title_from_pr_title() {
  local raw="${1:-}"
  local summary parsed_title
  parsed_title="$(parse_conventional_commit_title "$raw")"
  summary="$(extract_named_output_value summary "$parsed_title")"
  printf '%s\n' "$summary"
}

resolve_linear_api_cmd() {
  local api_cmd="${AUTO_PR_LINEAR_TICKET_API:-${SCRIPT_DIR}/linear-ticket-api.sh}"
  [[ -x "$api_cmd" ]] || {
    echo "missing executable Linear ticket API helper: $api_cmd" >&2
    return 1
  }
  printf '%s\n' "$api_cmd"
}

resolve_primary_linear_issue_ref() {
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "$1"
}

ensure_pr_body_linear_section() {
  local body_file="${1:-}"
  local ticket_ref="${2:-}"
  local ticket_url="${3:-}"
  if [[ -z "$body_file" || ! -f "$body_file" || -z "$ticket_ref" ]]; then
    return 0
  fi
  if grep -Eqi '^##[[:space:]]+Linear([[:space:]]|$)' "$body_file"; then
    return 0
  fi
  {
    printf '\n## Linear\n'
    if [[ -n "$ticket_url" ]]; then
      printf -- '- %s: %s\n' "$ticket_ref" "$ticket_url"
    else
      printf -- '- %s\n' "$ticket_ref"
    fi
  } >>"$body_file"
}

create_linear_issue_for_pr() {
  local title="${1:-}"
  local body_file="${2:-}"
  local api_cmd output issue_ref issue_url issue_branch status
  local team_name project_name assignee_name state_name labels_raw
  local strict="${AUTO_PR_LINEAR_STRICT:-1}"

  api_cmd="$(resolve_linear_api_cmd)" || return 1
  team_name="${AUTO_PR_LINEAR_TEAM:-Platform}"
  project_name="${AUTO_PR_LINEAR_PROJECT:-[PLATFORM] Backlog}"
  assignee_name="${AUTO_PR_LINEAR_ASSIGNEE:-me}"
  state_name="${AUTO_PR_LINEAR_STATE:-In Progress}"
  labels_raw="${AUTO_PR_LINEAR_LABELS:-openclaw-sre|Bug|Monitoring|Improvement}"

  validate_linear_selector_value "AUTO_PR_LINEAR_TEAM" "$team_name" "__SAFE_TEXT__" || return 1
  validate_linear_selector_value "AUTO_PR_LINEAR_PROJECT" "$project_name" "__SAFE_TEXT__" || return 1
  validate_linear_selector_value "AUTO_PR_LINEAR_ASSIGNEE" "$assignee_name" '^(me|[[:alnum:]_.-]+)$' || return 1
  validate_linear_selector_value "AUTO_PR_LINEAR_STATE" "$state_name" "__SAFE_TEXT__" || return 1
  validate_linear_labels_value "$labels_raw" || return 1

  set +e
  output="$("$api_cmd" issue create --title "$title" --file "$body_file" --team "$team_name" --project "$project_name" --assignee "$assignee_name" --state "$state_name" --labels "$labels_raw" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    if truthy "$strict"; then
      return 1
    fi
    return 0
  fi

  issue_ref="$(parse_linear_create_field "$output" '.identifier // empty' 'identifier')" || {
    truthy "$strict" && return 1
    return 0
  }
  issue_url="$(parse_linear_create_field "$output" '.url // empty' 'url')" || {
    truthy "$strict" && return 1
    return 0
  }
  issue_branch="$(parse_linear_create_field "$output" '.gitBranchName // empty' 'branch')" || {
    truthy "$strict" && return 1
    return 0
  }
  [[ -n "$issue_ref" ]] || {
    echo "failed to parse Linear issue identifier from helper output" >&2
    truthy "$strict" && return 1
    return 0
  }
  printf 'identifier=%s\n' "$issue_ref"
  printf 'url=%s\n' "$issue_url"
  printf 'branch=%s\n' "$issue_branch"
}

resolve_linear_issue_branch_name() {
  local ticket_ref="${1:-}"
  local api_cmd output status strict="${AUTO_PR_LINEAR_STRICT:-1}"
  local stderr_file stderr_output branch_name
  [[ -n "$ticket_ref" ]] || return 0
  api_cmd="$(resolve_linear_api_cmd)" || return 1
  stderr_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-sre-linear-branch.XXXXXX")"
  set +e
  output="$("$api_cmd" issue get-branch "$ticket_ref" 2>"$stderr_file")"
  status=$?
  set -e
  stderr_output="$(cat "$stderr_file" 2>/dev/null || true)"
  rm -f "$stderr_file"
  if [[ "$status" -ne 0 ]]; then
    [[ -n "$stderr_output" ]] && printf '%s\n' "$stderr_output" >&2
    if truthy "$strict"; then
      return 1
    fi
    return 0
  fi
  branch_name="$(printf '%s\n' "$output" | tail -n1)"
  [[ -n "$branch_name" ]] || {
    echo "failed to parse Linear issue branch from helper output" >&2
    if truthy "$strict"; then
      return 1
    fi
    return 0
  }
  printf '%s\n' "$branch_name"
}

attach_pr_to_linear_issue() {
  local ticket_ref="${1:-}"
  local pr_url="${2:-}"
  local repo_slug="${3:-}"
  local head_branch="${4:-}"
  local title="${5:-}"
  local api_cmd strict output status comment_body
  strict="${AUTO_PR_LINEAR_STRICT:-1}"
  truthy "${AUTO_PR_LINEAR_ATTACH_PR:-1}" || return 0
  if [[ -z "$ticket_ref" || -z "$pr_url" ]]; then
    echo "missing Linear ticket ref or PR URL for PR attachment" >&2
    if truthy "$strict"; then
      return 1
    fi
    return 0
  fi

  api_cmd="$(resolve_linear_api_cmd)" || return 1

  set +e
  output="$("$api_cmd" issue add-attachment "$ticket_ref" "$pr_url" "GitHub PR" "${repo_slug} ${head_branch}" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    if truthy "$strict"; then
      return 1
    fi
  fi

  printf -v comment_body \
'Opened remediation PR.
- URL: %s
- Repo: `%s`
- Branch: `%s`
- Title: %s' \
    "$pr_url" "$repo_slug" "$head_branch" "$title"
  set +e
  output="$("$api_cmd" issue add-comment "$ticket_ref" --text "$comment_body" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    if truthy "$strict"; then
      return 1
    fi
  fi
}

apply_pr_tracking_label() {
  local repo_slug="${1:-}"
  local pr_ref="${2:-}"
  local label="${3:-}"
  local output status pr_number api_path
  local -a cmd

  if [[ -z "$repo_slug" || -z "$pr_ref" || -z "$label" ]]; then
    return 0
  fi

  pr_number=""
  if [[ "$pr_ref" =~ /pull/([0-9]+) ]]; then
    pr_number="${BASH_REMATCH[1]}"
  elif [[ "$pr_ref" =~ ^[0-9]+$ ]]; then
    pr_number="$pr_ref"
  fi
  if [[ -z "$pr_number" ]]; then
    echo "failed to resolve PR number from ref: $pr_ref" >&2
    return 1
  fi

  api_path="repos/${repo_slug}/issues/${pr_number}/labels"
  cmd=(
    gh api
    -X POST
    "$api_path"
    -f "labels[]=${label}"
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

tmp_body=""
cleanup() {
  if [[ -n "${tmp_body:-}" && -f "$tmp_body" ]]; then
    rm -f "$tmp_body"
  fi
  return 0
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

compact_pr_body_file "$PR_BODY_FILE"

TRACKING_LABEL="${AUTO_PR_TRACKING_LABEL:-openclaw-sre}"
LINEAR_ISSUE_REFS=()
while IFS= read -r linear_ref; do
  [[ -n "$linear_ref" ]] || continue
  LINEAR_ISSUE_REFS+=("$linear_ref")
done < <(
  resolve_linear_issue_refs "$PR_BODY_FILE" "$TITLE_RAW" "$COMMIT_MSG"
)

PRIMARY_LINEAR_ISSUE="$(resolve_primary_linear_issue_ref "${LINEAR_ISSUE_REFS[@]:-}" || true)"
PRIMARY_LINEAR_URL=""
if [[ -z "$PRIMARY_LINEAR_ISSUE" && "$DRY_RUN" -ne 1 ]] && truthy "${AUTO_PR_LINEAR_CREATE:-1}"; then
  linear_create_output=""
  if ! capture_command_output linear_create_output create_linear_issue_for_pr \
    "$(build_linear_issue_title_from_pr_title "$TITLE_RAW")" "$PR_BODY_FILE"; then
    echo "auto-pr blocked: Linear issue creation failed" >&2
    exit 1
  fi
  PRIMARY_LINEAR_ISSUE="$(extract_named_output_value identifier "$linear_create_output")"
  PRIMARY_LINEAR_URL="$(extract_named_output_value url "$linear_create_output")"
  PRIMARY_LINEAR_BRANCH="$(extract_named_output_value branch "$linear_create_output")"
  if [[ -n "$PRIMARY_LINEAR_ISSUE" ]]; then
    LINEAR_ISSUE_REFS=("$PRIMARY_LINEAR_ISSUE")
  fi
fi

if [[ -n "$PRIMARY_LINEAR_ISSUE" ]]; then
  TITLE="$(ensure_linear_ticket_in_conventional_title "$TITLE_RAW" "$PRIMARY_LINEAR_ISSUE")"
  COMMIT_MSG="$(ensure_linear_ticket_in_conventional_title "$COMMIT_MSG" "$PRIMARY_LINEAR_ISSUE")"
  if [[ -z "${PRIMARY_LINEAR_BRANCH:-}" ]]; then
    if ! capture_command_output PRIMARY_LINEAR_BRANCH resolve_linear_issue_branch_name "$PRIMARY_LINEAR_ISSUE"; then
      echo "auto-pr blocked: failed to resolve Linear gitBranchName for ${PRIMARY_LINEAR_ISSUE}" >&2
      exit 1
    fi
  fi
  if [[ -n "$PRIMARY_LINEAR_BRANCH" ]]; then
    if [[ -n "$HEAD_BRANCH" && "$(sanitize_branch_fragment "$HEAD_BRANCH")" != "$(sanitize_branch_fragment "$PRIMARY_LINEAR_BRANCH")" ]]; then
      echo "auto-pr linear branch guard: --branch ${HEAD_BRANCH} does not match Linear gitBranchName ${PRIMARY_LINEAR_BRANCH}" >&2
      exit 1
    fi
    HEAD_BRANCH="$PRIMARY_LINEAR_BRANCH"
  fi
  if [[ -z "$PRIMARY_LINEAR_URL" ]]; then
    PRIMARY_LINEAR_URL="https://linear.app/morpho-labs/issue/${PRIMARY_LINEAR_ISSUE}"
  fi
  ensure_pr_body_linear_section "$PR_BODY_FILE" "$PRIMARY_LINEAR_ISSUE" "$PRIMARY_LINEAR_URL"
else
  TITLE="$(ensure_pr_title_prefix "$TITLE_RAW")"
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

LINEAR_ISSUE_REFS=()
while IFS= read -r linear_ref; do
  [[ -n "$linear_ref" ]] || continue
  LINEAR_ISSUE_REFS+=("$linear_ref")
done < <(
  resolve_linear_issue_refs "$PR_BODY_FILE" "$TITLE_RAW" "$TITLE" "$COMMIT_MSG" "$HEAD_BRANCH" "$PRIMARY_LINEAR_ISSUE"
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

if [[ -n "${PRIMARY_LINEAR_ISSUE:-}" ]]; then
  if ! attach_pr_to_linear_issue "$PRIMARY_LINEAR_ISSUE" "$pr_url" "$REPO_SLUG" "$HEAD_BRANCH" "$TITLE"; then
    echo "failed to attach PR to Linear issue ${PRIMARY_LINEAR_ISSUE}" >&2
    exit 1
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
