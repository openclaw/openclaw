require_command() {
  local tool="${1:-}"
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Error: required command not found: %s\n' "$tool" >&2
    exit 1
  fi
}

parse_github_repo_slug() {
  local remote_url="${1:-}"
  local slug=""

  remote_url="${remote_url#git+}"
  case "$remote_url" in
    git@github.com:*)
      slug="${remote_url#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      slug="${remote_url#ssh://git@github.com/}"
      ;;
    https://github.com/*)
      slug="${remote_url#https://github.com/}"
      ;;
    http://github.com/*)
      slug="${remote_url#http://github.com/}"
      ;;
    https://*@github.com/*)
      slug="${remote_url#https://}"
      slug="${slug#*@github.com/}"
      ;;
    http://*@github.com/*)
      slug="${remote_url#http://}"
      slug="${slug#*@github.com/}"
      ;;
    *)
      return 1
      ;;
  esac

  slug="${slug%.git}"
  if [[ "$slug" =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$ ]]; then
    printf '%s\n' "$slug"
    return 0
  fi

  return 1
}

describe_ref_oid() {
  local ref="${1:-}"

  if [[ -z "$ref" ]]; then
    printf 'missing\n'
    return 0
  fi

  git rev-parse "$ref" 2>/dev/null || printf 'missing\n'
}

resolve_repo_slug() {
  local remote_url repo_slug

  # Test-only / explicit override for hermetic runs that cannot rely on the
  # local origin URL. Normal production use should resolve the repo from origin.
  if [[ -n "${OPENCLAW_COMMITTER_REPO_SLUG:-}" ]]; then
    repo_slug="${OPENCLAW_COMMITTER_REPO_SLUG}"
    if [[ "$repo_slug" =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$ ]]; then
      printf '%s\n' "$repo_slug"
      return 0
    fi
    printf 'Error: OPENCLAW_COMMITTER_REPO_SLUG must be owner/repo (got %s)\n' "$repo_slug" >&2
    return 1
  fi

  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -z "$remote_url" ]]; then
    printf 'Error: origin remote is required for signed API commits\n' >&2
    return 1
  fi

  repo_slug="$(parse_github_repo_slug "$remote_url" || true)"
  if [[ -z "$repo_slug" ]]; then
    printf 'Error: origin remote must point to github.com for signed API commits (got %s)\n' "$remote_url" >&2
    return 1
  fi

  printf '%s\n' "$repo_slug"
}

resolve_current_branch() {
  local branch

  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$branch" ]]; then
    printf 'Error: signed API commits require a named branch; detached HEAD is not supported\n' >&2
    return 1
  fi

  printf '%s\n' "$branch"
}

resolve_default_branch() {
  local repo_slug="${1:-}"
  local default_branch

  if [[ -z "$repo_slug" ]]; then
    printf 'Error: resolve_default_branch requires repo slug\n' >&2
    return 1
  fi

  default_branch="$(gh repo view "$repo_slug" --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || true)"
  if [[ -z "$default_branch" ]]; then
    printf 'Error: failed to resolve default branch for %s via gh repo view\n' "$repo_slug" >&2
    return 1
  fi

  printf '%s\n' "$default_branch"
}

resolve_remote_branch_oid() {
  local branch="${1:-}"

  if [[ -z "$branch" ]]; then
    return 1
  fi

  git ls-remote --heads origin "$branch" 2>/dev/null | awk '{print $1}' | head -n1
}

ensure_remote_branch_for_api_commit() {
  local repo_slug="${1:-}"
  local branch="${2:-}"
  local local_head="${3:-}"
  local remote_head default_branch default_head

  if [[ -z "$repo_slug" || -z "$branch" || -z "$local_head" ]]; then
    printf 'Error: ensure_remote_branch_for_api_commit requires repo slug, branch, and local head\n' >&2
    return 1
  fi

  remote_head="$(resolve_remote_branch_oid "$branch" || true)"
  if [[ -n "$remote_head" ]]; then
    if [[ "$remote_head" != "$local_head" ]]; then
      printf 'Error: signed API commits require %s to match origin/%s first (local=%s remote=%s). Sync the branch to origin/%s, then replay unpublished local commits with scripts/committer.\n' \
        "$branch" "$branch" "$local_head" "$remote_head" "$branch" >&2
      return 1
    fi
    printf '%s\n' "$remote_head"
    return 0
  fi

  default_branch="$(resolve_default_branch "$repo_slug")" || return 1
  if ! run_git_with_lock_retry "fetching default branch" git fetch origin "$default_branch" >/dev/null; then
    printf 'Error: failed to fetch origin/%s before creating remote branch %s\n' "$default_branch" "$branch" >&2
    return 1
  fi

  default_head="$(git rev-parse "origin/${default_branch}" 2>/dev/null || true)"
  if [[ -z "$default_head" ]]; then
    printf 'Error: failed to resolve origin/%s locally\n' "$default_branch" >&2
    return 1
  fi
  if [[ "$local_head" != "$default_head" ]]; then
    printf 'Error: branch %s has no origin ref and local HEAD (%s) does not match origin/%s (%s). Reset or rebase onto origin/%s, then replay unpublished local commits with scripts/committer.\n' \
      "$branch" "$local_head" "$default_branch" "$default_head" "$default_branch" >&2
    return 1
  fi

  if ! gh api -X POST "repos/${repo_slug}/git/refs" \
    -f "ref=refs/heads/${branch}" \
    -f "sha=${local_head}" >/dev/null 2>&1; then
    remote_head="$(resolve_remote_branch_oid "$branch" || true)"
    if [[ -z "$remote_head" ]]; then
      printf 'Error: failed to create remote branch %s via GitHub API\n' "$branch" >&2
      return 1
    fi
    if [[ "$remote_head" != "$local_head" ]]; then
      printf 'Error: remote branch %s was created concurrently but points to %s instead of %s. Sync the branch state, then replay unpublished local commits with scripts/committer.\n' \
        "$branch" "$remote_head" "$local_head" >&2
      return 1
    fi
    printf '%s\n' "$remote_head"
    return 0
  fi

  printf '%s\n' "$local_head"
}

staged_file_mode() {
  local path="${1:-}"

  git ls-files -s -- "$path" | awk 'NR == 1 { print $1 }'
}

head_file_mode() {
  local path="${1:-}"

  git ls-tree HEAD -- "$path" | awk 'NR == 1 { print $1 }'
}

require_api_blob_mode() {
  local path="${1:-}"
  local mode="${2:-}"
  local previous_mode="${3:-}"

  case "$mode" in
    100644)
      if [[ -n "$previous_mode" && "$previous_mode" != "100644" ]]; then
        printf 'Error: signed API commits do not support mode changes for %s (%s -> %s)\n' \
          "$path" "$previous_mode" "$mode" >&2
        return 1
      fi
      return 0
      ;;
    100755)
      if [[ -n "$previous_mode" && "$previous_mode" == "100755" ]]; then
        # Existing executable entries keep their mode; only new executable paths
        # or mode flips are blocked in the signed API flow.
        return 0
      fi
      if [[ -n "$previous_mode" ]]; then
        printf 'Error: signed API commits do not support mode changes for %s (%s -> %s)\n' \
          "$path" "$previous_mode" "$mode" >&2
      else
        printf 'Error: signed API commits do not support new executable files for %s\n' "$path" >&2
      fi
      return 1
      ;;
    120000)
      printf 'Error: signed API commits do not support symlinks for %s\n' "$path" >&2
      return 1
      ;;
    160000)
      printf 'Error: signed API commits do not support submodules for %s\n' "$path" >&2
      return 1
      ;;
    *)
      printf 'Error: unsupported staged mode %s for %s in signed API commit flow\n' "$mode" "$path" >&2
      return 1
      ;;
  esac
}

api_commit_headline=''
api_commit_body=''
api_additions_args=()
api_deletions_args=()

append_api_addition_arg() {
  local path="${1:-}"
  local contents_file="${2:-}"

  api_additions_args+=(-F "fileAdditions[][path]=$path" -F "fileAdditions[][contents]=@$contents_file")
}

append_api_deletion_arg() {
  local path="${1:-}"

  api_deletions_args+=(-F "fileDeletions[][path]=$path")
}

encode_index_blob_to_base64_file() {
  local object_spec="${1:-}"
  local tmp_dir="${2:-}"
  local error_context="${3:-}"
  local contents_file

  if [[ -z "$object_spec" || -z "$tmp_dir" || -z "$error_context" ]]; then
    printf 'Error: encode_index_blob_to_base64_file requires an object spec, temp dir, and context\n' >&2
    return 1
  fi

  contents_file="$(mktemp "${tmp_dir}/addition-XXXXXX")" || {
    printf 'Error: failed to allocate temp file for %s\n' "$error_context" >&2
    return 1
  }
  if ! (
    set -euo pipefail
    git cat-file -e "$object_spec"
    git cat-file blob "$object_spec" | base64 | tr -d '\n' >"$contents_file"
  ); then
    printf 'Error: failed to read %s\n' "$error_context" >&2
    return 1
  fi

  printf '%s\n' "$contents_file"
}

append_staged_addition_change() {
  local path="${1:-}"
  local tmp_dir="${2:-}"
  local mode previous_mode contents_file

  mode="$(staged_file_mode "$path")"
  previous_mode="$(head_file_mode "$path")"
  if [[ -z "$mode" ]] || ! require_api_blob_mode "$path" "$mode" "$previous_mode"; then
    return 1
  fi

  contents_file="$(encode_index_blob_to_base64_file ":$path" "$tmp_dir" "staged file contents for $path")" || return 1
  append_api_addition_arg "$path" "$contents_file"
}

append_staged_move_or_copy_change() {
  local status="${1:-}"
  local old_path="${2:-}"
  local new_path="${3:-}"
  local tmp_dir="${4:-}"
  local mode previous_mode contents_file

  mode="$(staged_file_mode "$new_path")"
  previous_mode="$(head_file_mode "$new_path")"
  if [[ -z "$mode" ]] || ! require_api_blob_mode "$new_path" "$mode" "$previous_mode"; then
    return 1
  fi

  if [[ "$status" == R* ]]; then
    append_api_deletion_arg "$old_path"
  fi
  contents_file="$(encode_index_blob_to_base64_file ":$new_path" "$tmp_dir" "staged renamed/copied file for $new_path")" || return 1
  append_api_addition_arg "$new_path" "$contents_file"
}

collect_staged_changes_for_api_commit() {
  local tmp_dir="${1:-}"
  local status path old_path new_path

  if [[ -z "$tmp_dir" ]]; then
    printf 'Error: collect_staged_changes_for_api_commit requires a temp dir\n' >&2
    return 1
  fi

  while IFS= read -r -d '' status; do
    case "$status" in
      A|M)
        IFS= read -r -d '' path || {
          printf 'Error: malformed staged diff output for status %s\n' "$status" >&2
          return 1
        }
        append_staged_addition_change "$path" "$tmp_dir" || return 1
        ;;
      D)
        IFS= read -r -d '' path || {
          printf 'Error: malformed staged diff output for deletion\n' >&2
          return 1
        }
        append_api_deletion_arg "$path"
        ;;
      R*|C*)
        IFS= read -r -d '' old_path || {
          printf 'Error: malformed staged diff output for rename/copy source\n' >&2
          return 1
        }
        IFS= read -r -d '' new_path || {
          printf 'Error: malformed staged diff output for rename/copy target\n' >&2
          return 1
        }
        append_staged_move_or_copy_change "$status" "$old_path" "$new_path" "$tmp_dir" || return 1
        ;;
      T)
        IFS= read -r -d '' path || {
          printf 'Error: malformed staged diff output for type change\n' >&2
          return 1
        }
        printf 'Error: signed API commits do not support type changes for %s\n' "$path" >&2
        return 1
        ;;
      *)
        printf 'Error: unsupported staged status for signed API commit: %s\n' "$status" >&2
        return 1
        ;;
    esac
  done < <(git diff --cached --name-status --find-renames --find-copies-harder --diff-filter=ACDMRT -z)
}

normalize_api_file_change_args() {
  if [[ "${#api_additions_args[@]}" -eq 0 && "${#api_deletions_args[@]}" -eq 0 ]]; then
    printf 'Error: no staged changes available for signed API commit\n' >&2
    return 1
  fi
  if [[ "${#api_additions_args[@]}" -eq 0 ]]; then
    api_additions_args+=(-F 'fileAdditions[]')
  fi
  if [[ "${#api_deletions_args[@]}" -eq 0 ]]; then
    api_deletions_args+=(-F 'fileDeletions[]')
  fi
}

split_api_commit_message() {
  local commit_msg="${1:-}"

  api_commit_headline="$commit_msg"
  api_commit_body=""
  if [[ "$commit_msg" == *$'\n\n'* ]]; then
    api_commit_headline="${commit_msg%%$'\n\n'*}"
    api_commit_body="${commit_msg#*$'\n\n'}"
  elif [[ "$commit_msg" == *$'\n'* ]]; then
    api_commit_headline="${commit_msg%%$'\n'*}"
    api_commit_body="${commit_msg#*$'\n'}"
  fi
  if [[ ! "$api_commit_headline" =~ [^[:space:]] ]]; then
    printf 'Error: commit headline must not be empty\n' >&2
    return 1
  fi
}

graphql_create_commit_on_branch_query() {
  cat <<'EOF'
mutation(
  $repo: String!,
  $branch: String!,
  $headline: String!,
  $body: String,
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
      message: {
        headline: $headline,
        body: $body
      },
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
    }
  }
}
EOF
}

validate_api_signed_commit_response() {
  local response="${1:-}"

  if ! printf '%s' "$response" | jq -e '.data.createCommitOnBranch.commit.url // empty | length > 0' >/dev/null 2>&1; then
    printf 'Error: signed API commit returned unexpected response\n' >&2
    printf '%s\n' "$response" >&2
    return 1
  fi
}

create_api_signed_commit() (
  local repo_slug="${1:-}"
  local branch="${2:-}"
  local commit_msg="${3:-}"
  local expected_head_oid="${4:-}"
  local tmp_dir graphql_query response
  local -a graphql_args=()

  if [[ -z "$repo_slug" || -z "$branch" || -z "$commit_msg" || -z "$expected_head_oid" ]]; then
    printf 'Error: create_api_signed_commit requires repo slug, branch, commit message, and expected head oid\n' >&2
    return 1
  fi

  api_additions_args=()
  api_deletions_args=()
  api_commit_headline=''
  api_commit_body=''

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  collect_staged_changes_for_api_commit "$tmp_dir" || return 1
  normalize_api_file_change_args || return 1
  split_api_commit_message "$commit_msg" || return 1
  graphql_query="$(graphql_create_commit_on_branch_query)"

  graphql_args=(
    -F "repo=${repo_slug}"
    -F "branch=${branch}"
    -F "headline=${api_commit_headline}"
    -F "body=${api_commit_body}"
    -F "expectedHeadOid=${expected_head_oid}"
  )
  if (( ${#api_additions_args[@]} > 0 )); then
    graphql_args+=("${api_additions_args[@]}")
  fi
  if (( ${#api_deletions_args[@]} > 0 )); then
    graphql_args+=("${api_deletions_args[@]}")
  fi
  graphql_args+=(-F "query=${graphql_query}")

  response="$(gh api graphql "${graphql_args[@]}")" || return 1

  validate_api_signed_commit_response "$response" || return 1
  printf '%s\n' "$response"
)

sync_local_branch_to_signed_commit() {
  local branch="${1:-}"
  local previous_head="${2:-}"
  local expected_new_oid="${3:-}"
  local fetched_oid current_local_ref

  if [[ -z "$branch" || -z "$previous_head" || -z "$expected_new_oid" ]]; then
    printf 'Error: sync_local_branch_to_signed_commit requires branch, previous head, and new oid\n' >&2
    return 1
  fi

  if ! run_git_with_lock_retry "fetching signed commit" \
    git fetch origin "refs/heads/${branch}:refs/remotes/origin/${branch}" >/dev/null; then
    printf 'Error: failed to fetch origin/%s after signed API commit\n' "$branch" >&2
    return 1
  fi

  fetched_oid="$(git rev-parse "refs/remotes/origin/${branch}" 2>/dev/null || true)"
  if [[ "$fetched_oid" != "$expected_new_oid" ]]; then
    printf 'Error: fetched origin/%s (%s) does not match signed API commit %s\n' \
      "$branch" "${fetched_oid:-missing}" "$expected_new_oid" >&2
    return 1
  fi

  if ! run_git_with_lock_retry "updating local branch ref" \
    git update-ref -m "scripts/committer signed API commit" \
      "refs/heads/${branch}" "$expected_new_oid" "$previous_head" >/dev/null; then
    current_local_ref="$(describe_ref_oid "refs/heads/${branch}")"
    printf 'Error: failed to update local branch %s to signed commit %s (current=%s expected-previous=%s)\n' \
      "$branch" "$expected_new_oid" "$current_local_ref" "$previous_head" >&2
    return 1
  fi

  git branch --set-upstream-to "origin/${branch}" "$branch" >/dev/null 2>&1 || true
}
