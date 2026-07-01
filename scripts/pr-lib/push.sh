resolve_head_push_url() {
  # shellcheck disable=SC1091
  source .local/pr-meta.env

  if [ -n "${PR_HEAD_OWNER:-}" ] && [ -n "${PR_HEAD_REPO_NAME:-}" ]; then
    printf 'https://github.com/%s/%s.git\n' "$PR_HEAD_OWNER" "$PR_HEAD_REPO_NAME"
    return 0
  fi

  if [ -n "${PR_HEAD_REPO_URL:-}" ] && [ "$PR_HEAD_REPO_URL" != "null" ]; then
    case "$PR_HEAD_REPO_URL" in
      *.git) printf '%s\n' "$PR_HEAD_REPO_URL" ;;
      *) printf '%s.git\n' "$PR_HEAD_REPO_URL" ;;
    esac
    return 0
  fi

  return 1
}

# Push to a fork PR branch via GitHub GraphQL createCommitOnBranch.
# This uses the same permission model as the GitHub web editor, bypassing
# the git-protocol 403 that occurs even when maintainer_can_modify is true.
# Usage: graphql_push_to_fork <owner/repo> <branch> <expected_head_oid> [mainline_ref]
# Pushes the diff between expected_head_oid and local HEAD as file additions/deletions.
# File bytes are read from git objects (not the working tree) to avoid
# symlink/special-file dereference risks from untrusted fork content.
require_graphql_push_preserves_ancestry() {
  local expected_oid="$1"
  local prepared_oid="$2"
  local mainline_ref="${3:-origin/main}"

  if ! git cat-file -e "${expected_oid}^{commit}" 2>/dev/null; then
    echo "GraphQL push refused before mutation: remote lease $expected_oid is not available locally." >&2
    echo "Refresh the PR head and retry so commit ancestry can be verified." >&2
    return 1
  fi
  if ! git merge-base --is-ancestor "$expected_oid" "$prepared_oid" 2>/dev/null; then
    echo "GraphQL push refused before mutation: prepared head $prepared_oid is not a descendant of remote lease $expected_oid." >&2
    echo "createCommitOnBranch always parents the new commit to the remote branch head, so this push would discard the prepared topology." >&2
    return 1
  fi
  local expected_mainline_base
  local prepared_mainline_base
  expected_mainline_base=$(git merge-base "$expected_oid" "$mainline_ref") || {
    echo "GraphQL push refused before mutation: unable to resolve the remote lease mainline base." >&2
    return 1
  }
  prepared_mainline_base=$(git merge-base "$prepared_oid" "$mainline_ref") || {
    echo "GraphQL push refused before mutation: unable to resolve the prepared mainline base." >&2
    return 1
  }
  if [ "$expected_mainline_base" != "$prepared_mainline_base" ]; then
    echo "GraphQL push refused before mutation: publication would discard the prepared mainline merge-base." >&2
    echo "createCommitOnBranch gives the published commit only the remote branch head as its parent." >&2
    return 1
  fi
}

graphql_push_to_fork() {
  local repo_nwo="$1"
  local branch="$2"
  local expected_oid="$3"
  local mainline_ref="${4:-origin/main}"
  local max_blob_bytes=$((5 * 1024 * 1024))

  # GitHub creates the commit on the remote branch head, not with the local
  # commit's parents. Only a descendant local head can preserve that lineage.
  require_graphql_push_preserves_ancestry "$expected_oid" HEAD "$mainline_ref" || return 1

  local additions="[]"
  local deletions="[]"

  local added_files
  added_files=$(git diff --no-renames --name-only --diff-filter=AM "$expected_oid" HEAD)
  if [ -n "$added_files" ]; then
    additions="["
    local first=true
    while IFS= read -r fpath; do
      [ -n "$fpath" ] || continue

      local tree_entry
      tree_entry=$(git ls-tree HEAD -- "$fpath")
      if [ -z "$tree_entry" ]; then
        echo "GraphQL push could not resolve path in HEAD tree: $fpath" >&2
        return 1
      fi

      local file_mode
      file_mode=$(printf '%s\n' "$tree_entry" | awk '{print $1}')
      local file_type
      file_type=$(printf '%s\n' "$tree_entry" | awk '{print $2}')
      local file_oid
      file_oid=$(printf '%s\n' "$tree_entry" | awk '{print $3}')

      if [ "$file_type" != "blob" ] || [ "$file_mode" = "160000" ]; then
        echo "GraphQL push only supports blob files; refusing $fpath (mode=$file_mode type=$file_type)" >&2
        return 1
      fi

      local blob_size
      blob_size=$(git cat-file -s "$file_oid")
      if [ "$blob_size" -gt "$max_blob_bytes" ]; then
        echo "GraphQL push refused large file $fpath (${blob_size} bytes > ${max_blob_bytes})" >&2
        return 1
      fi

      local b64
      b64=$(git cat-file -p "$file_oid" | base64 | tr -d '\n')
      if [ "$first" = true ]; then first=false; else additions+=","; fi
      additions+="{\"path\":$(printf '%s' "$fpath" | jq -Rs .),\"contents\":$(printf '%s' "$b64" | jq -Rs .)}"
    done <<< "$added_files"
    additions+="]"
  fi

  local deleted_files
  deleted_files=$(git diff --no-renames --name-only --diff-filter=D "$expected_oid" HEAD)
  if [ -n "$deleted_files" ]; then
    deletions="["
    local first=true
    while IFS= read -r fpath; do
      [ -n "$fpath" ] || continue
      if [ "$first" = true ]; then first=false; else deletions+=","; fi
      deletions+="{\"path\":$(printf '%s' "$fpath" | jq -Rs .)}"
    done <<< "$deleted_files"
    deletions+="]"
  fi

  local commit_headline
  commit_headline=$(git log -1 --format=%s HEAD)

  local query
  query=$(cat <<'GRAPHQL'
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}
GRAPHQL
)

  local additions_file deletions_file
  additions_file=$(mktemp)
  deletions_file=$(mktemp)
  printf '%s\n' "$additions" >"$additions_file"
  printf '%s\n' "$deletions" >"$deletions_file"

  local variables
  variables=$(jq -n \
    --arg nwo "$repo_nwo" \
    --arg branch "$branch" \
    --arg oid "$expected_oid" \
    --arg headline "$commit_headline" \
    --slurpfile additions "$additions_file" \
    --slurpfile deletions "$deletions_file" \
    '{input: {
      branch: { repositoryNameWithOwner: $nwo, branchName: $branch },
      message: { headline: $headline },
      fileChanges: { additions: $additions[0], deletions: $deletions[0] },
      expectedHeadOid: $oid
    }}')
  rm -f "$additions_file" "$deletions_file"

  local variables_file
  variables_file=$(mktemp)
  printf '%s\n' "$variables" >"$variables_file"

  local payload
  payload=$(jq -n --arg query "$query" --slurpfile variables "$variables_file" \
    '{query: $query, variables: $variables[0]}')
  rm -f "$variables_file"

  local result
  result=$(gh api graphql --input - <<< "$payload" 2>&1) || {
    echo "GraphQL push failed: $result" >&2
    return 1
  }

  local new_oid
  new_oid=$(printf '%s' "$result" | jq -r '.data.createCommitOnBranch.commit.oid // empty')
  if [ -z "$new_oid" ]; then
    echo "GraphQL push returned no commit OID: $result" >&2
    return 1
  fi

  echo "GraphQL push succeeded: $new_oid" >&2
  printf '%s\n' "$new_oid"
}

resolve_head_push_url_https() {
  # shellcheck disable=SC1091
  source .local/pr-meta.env

  if [ -n "${PR_HEAD_OWNER:-}" ] && [ -n "${PR_HEAD_REPO_NAME:-}" ]; then
    printf 'https://github.com/%s/%s.git\n' "$PR_HEAD_OWNER" "$PR_HEAD_REPO_NAME"
    return 0
  fi

  if [ -n "${PR_HEAD_REPO_URL:-}" ] && [ "$PR_HEAD_REPO_URL" != "null" ]; then
    case "$PR_HEAD_REPO_URL" in
      *.git) printf '%s\n' "$PR_HEAD_REPO_URL" ;;
      *) printf '%s.git\n' "$PR_HEAD_REPO_URL" ;;
    esac
    return 0
  fi

  return 1
}

verify_pr_head_branch_matches_expected() {
  local pr="$1"
  local expected_head="$2"

  local current_head
  current_head=$(gh pr view "$pr" --json headRefName --jq .headRefName)
  if [ "$current_head" != "$expected_head" ]; then
    echo "PR head branch changed from $expected_head to $current_head. Re-run prepare-init."
    exit 1
  fi
}

setup_prhead_remote() {
  local push_url
  push_url=$(resolve_head_push_url) || {
    echo "Unable to resolve PR head repo push URL."
    exit 1
  }

  git remote remove prhead 2>/dev/null || true
  git remote add prhead "$push_url"
}

resolve_prhead_remote_sha() {
  local pr_head="$1"

  local remote_sha
  remote_sha=$(git ls-remote prhead "refs/heads/$pr_head" 2>/dev/null | awk '{print $1}' || true)
  if [ -z "$remote_sha" ]; then
    local https_url
    https_url=$(resolve_head_push_url_https 2>/dev/null) || true
    local current_push_url
    current_push_url=$(git remote get-url prhead 2>/dev/null || true)
    if [ -n "$https_url" ] && [ "$https_url" != "$current_push_url" ]; then
      echo "SSH remote failed; falling back to HTTPS..." >&2
      git remote set-url prhead "$https_url"
      git remote set-url --push prhead "$https_url"
      remote_sha=$(git ls-remote prhead "refs/heads/$pr_head" 2>/dev/null | awk '{print $1}' || true)
    fi
    if [ -z "$remote_sha" ]; then
      echo "Remote branch refs/heads/$pr_head not found on prhead" >&2
      exit 1
    fi
  fi

  printf '%s\n' "$remote_sha"
}

push_prep_head_once() {
  local pr_head="$1"
  local lease_sha="$2"
  local prep_head_sha="$3"

  if [ -n "${PR_HEAD_OWNER:-}" ] && [ -n "${PR_HEAD_REPO_NAME:-}" ] && [ "${OPENCLAW_PR_PUSH_MODE:-graphql}" != "git" ]; then
    echo "Pushing PR branch through GitHub createCommitOnBranch so the prepared commit is verified." >&2
    graphql_push_to_fork "${PR_HEAD_OWNER}/${PR_HEAD_REPO_NAME}" "$pr_head" "$lease_sha"
    return $?
  fi

  if [ "${OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH:-}" != "1" ]; then
    echo "Refusing git-protocol PR branch push because it can publish unsigned commits." >&2
    echo "Use the default GitHub createCommitOnBranch path, or set OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH=1 for an explicit manual override." >&2
    return 2
  fi

  git push --force-with-lease=refs/heads/$pr_head:$lease_sha prhead HEAD:$pr_head >&2
  printf '%s\n' "$prep_head_sha"
}

repair_synced_ancestry_ref() {
  local pr_head="$1"
  local lease_sha="$2"
  local prepared_head_sha="$3"
  local synced_base_sha="$4"
  local synced_tree="$5"
  local verify_ref="refs/remotes/prhead/ancestry-repair"

  local remote_sha
  remote_sha=$(resolve_prhead_remote_sha "$pr_head")
  if [ "$remote_sha" != "$lease_sha" ]; then
    echo "Ancestry repair refused: remote lease changed (expected $lease_sha, got $remote_sha)." >&2
    return 1
  fi

  if ! git fetch --no-tags prhead "+refs/heads/$pr_head:$verify_ref" >/dev/null 2>&1; then
    echo "Ancestry repair refused: unable to fetch the remote lease for verification." >&2
    return 1
  fi
  local fetched_sha
  fetched_sha=$(git rev-parse "$verify_ref")
  if [ "$fetched_sha" != "$lease_sha" ]; then
    echo "Ancestry repair refused: fetched branch head differs from the verified lease." >&2
    return 1
  fi
  if [ "$lease_sha" = "$prepared_head_sha" ] || git merge-base --is-ancestor "$lease_sha" "$prepared_head_sha" 2>/dev/null; then
    echo "Ancestry repair refused: normal publication already preserves this topology." >&2
    return 1
  fi

  local prepared_tree
  local lease_tree
  prepared_tree=$(git rev-parse "${prepared_head_sha}^{tree}")
  lease_tree=$(git rev-parse "${lease_sha}^{tree}")
  if [ "$prepared_tree" != "$synced_tree" ]; then
    echo "Ancestry repair refused: local prepared tree no longer matches the verified sync artifact." >&2
    return 1
  fi
  if [ "$lease_tree" != "$synced_tree" ]; then
    echo "Ancestry repair refused: remote lease tree differs from the local prepared tree." >&2
    return 1
  fi
  if ! git merge-base --is-ancestor "$synced_base_sha" "$prepared_head_sha" 2>/dev/null; then
    echo "Ancestry repair refused: synced base is not an ancestor of the prepared head." >&2
    return 1
  fi
  if ! git diff --quiet "$lease_sha" "$prepared_head_sha"; then
    echo "Ancestry repair refused: lease and prepared commits contain different file changes." >&2
    return 1
  fi

  # This mode is topology-only. The dry run proves git-protocol permission,
  # and the second lease read closes the race before the only mutating command.
  if ! git push --dry-run \
    --force-with-lease="refs/heads/$pr_head:$lease_sha" \
    prhead "$prepared_head_sha:refs/heads/$pr_head" >&2
  then
    echo "Ancestry repair refused: force-with-lease permission dry run failed." >&2
    return 1
  fi
  remote_sha=$(resolve_prhead_remote_sha "$pr_head")
  if [ "$remote_sha" != "$lease_sha" ]; then
    echo "Ancestry repair refused: remote lease changed after the permission dry run." >&2
    return 1
  fi
  if ! git push \
    --force-with-lease="refs/heads/$pr_head:$lease_sha" \
    prhead "$prepared_head_sha:refs/heads/$pr_head" >&2
  then
    echo "Ancestry repair publication failed." >&2
    return 1
  fi

  remote_sha=$(resolve_prhead_remote_sha "$pr_head")
  if [ "$remote_sha" != "$prepared_head_sha" ]; then
    echo "Ancestry repair verification failed: expected remote $prepared_head_sha, got $remote_sha." >&2
    return 1
  fi
  if ! git fetch --no-tags prhead "+refs/heads/$pr_head:$verify_ref" >/dev/null 2>&1; then
    echo "Ancestry repair verification failed: unable to fetch the published ref." >&2
    return 1
  fi
  fetched_sha=$(git rev-parse "$verify_ref")
  local published_tree
  published_tree=$(git rev-parse "${fetched_sha}^{tree}")
  if [ "$fetched_sha" != "$prepared_head_sha" ] || [ "$published_tree" != "$synced_tree" ]; then
    echo "Ancestry repair verification failed: published SHA or tree differs from the verified sync." >&2
    return 1
  fi
  if ! git merge-base --is-ancestor "$synced_base_sha" "$fetched_sha" 2>/dev/null; then
    echo "Ancestry repair verification failed: published head lost the synced base ancestry." >&2
    return 1
  fi
  local published_merge_base
  published_merge_base=$(git merge-base "$synced_base_sha" "$fetched_sha")
  if [ "$published_merge_base" != "$synced_base_sha" ]; then
    echo "Ancestry repair verification failed: published merge-base differs from the synced base." >&2
    return 1
  fi
  if ! git diff --quiet "$lease_sha" "$fetched_sha"; then
    echo "Ancestry repair verification failed: publication changed file content." >&2
    return 1
  fi

  printf '%s\n' "$fetched_sha"
}

push_prep_head_to_pr_branch() {
  local pr="$1"
  local pr_head="$2"
  local prep_head_sha="$3"
  local lease_sha="$4"
  local rerun_gates_on_lease_retry="${5:-false}"
  local docs_only="${6:-false}"
  local result_env_path="${7:-.local/push-result.env}"
  local local_prep_head_sha="$prep_head_sha"

  setup_prhead_remote

  local remote_sha
  remote_sha=$(resolve_prhead_remote_sha "$pr_head")

  local pushed_from_sha="$remote_sha"
  if [ "$remote_sha" = "$prep_head_sha" ]; then
    echo "Remote branch already at local prep HEAD; skipping push."
  else
    if [ "$remote_sha" != "$lease_sha" ]; then
      echo "Remote SHA $remote_sha differs from PR head lease $lease_sha. Re-run prepare from the refreshed head."
      exit 1
    fi
    pushed_from_sha="$lease_sha"
    local push_output
    if ! push_output=$(push_prep_head_once "$pr_head" "$lease_sha" "$prep_head_sha" 2>&1); then
      echo "Push failed: $push_output"

      if printf '%s' "$push_output" | grep -qiE '(permission|denied|403|forbidden)'; then
        if [ "${OPENCLAW_PR_PUSH_MODE:-graphql}" = "git" ]; then
          echo "Explicit git push permission failed; refusing GraphQL fallback."
          exit 1
        fi
        echo "Permission denied on git push; trying GraphQL createCommitOnBranch fallback..."
        if [ -n "${PR_HEAD_OWNER:-}" ] && [ -n "${PR_HEAD_REPO_NAME:-}" ]; then
          local graphql_oid
          graphql_oid=$(graphql_push_to_fork "${PR_HEAD_OWNER}/${PR_HEAD_REPO_NAME}" "$pr_head" "$lease_sha")
          prep_head_sha="$graphql_oid"
        else
          echo "Git push permission denied and no fork owner/repo info for GraphQL fallback."
          exit 1
        fi
      else
        if [ "$rerun_gates_on_lease_retry" != "true" ]; then
          echo "PR head changed during sync; re-run prepare-sync-head from the refreshed branch."
          exit 1
        fi
        echo "Lease push failed, retrying once with fresh PR head..."
        lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
        pushed_from_sha="$lease_sha"

        if [ "$rerun_gates_on_lease_retry" = "true" ]; then
          git fetch origin "pull/$pr/head:pr-$pr-latest" --force
          git rebase "pr-$pr-latest"
          prep_head_sha=$(git rev-parse HEAD)
          local_prep_head_sha="$prep_head_sha"
          run_prepare_push_retry_gates "$docs_only"
        fi

        if ! push_output=$(push_prep_head_once "$pr_head" "$lease_sha" "$prep_head_sha" 2>&1); then
          echo "Retry push failed: $push_output"
          if [ "${OPENCLAW_PR_PUSH_MODE:-graphql}" = "git" ]; then
            echo "Explicit git retry failed; refusing GraphQL fallback."
            exit 1
          fi
          if [ -n "${PR_HEAD_OWNER:-}" ] && [ -n "${PR_HEAD_REPO_NAME:-}" ]; then
            echo "Retry failed; trying GraphQL createCommitOnBranch fallback..."
            local graphql_oid
            graphql_oid=$(graphql_push_to_fork "${PR_HEAD_OWNER}/${PR_HEAD_REPO_NAME}" "$pr_head" "$lease_sha")
            prep_head_sha="$graphql_oid"
          else
            echo "Git push failed and no fork owner/repo info for GraphQL fallback."
            exit 1
          fi
        else
          prep_head_sha=$(printf '%s\n' "$push_output" | tail -n 1)
        fi
      fi
    else
      prep_head_sha=$(printf '%s\n' "$push_output" | tail -n 1)
    fi
  fi

  if ! wait_for_pr_head_sha "$pr" "$prep_head_sha" 8 3; then
    local observed_sha
    observed_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
    echo "Pushed head SHA propagation timed out. expected=$prep_head_sha observed=$observed_sha"
    exit 1
  fi

  local pr_head_sha_after
  pr_head_sha_after=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)

  git fetch origin "pull/$pr/head:pr-$pr-verify" --force
  local local_prep_tree
  local remote_prep_tree
  local_prep_tree=$(git rev-parse "${local_prep_head_sha}^{tree}")
  remote_prep_tree=$(git rev-parse "pr-$pr-verify^{tree}")
  git branch -D "pr-$pr-verify" 2>/dev/null || true
  if [ "$local_prep_tree" != "$remote_prep_tree" ]; then
    echo "Pushed PR head tree differs from the prepared local tree."
    exit 1
  fi

  # merge-verify owns relevance-aware mainline drift checks. Requiring every
  # prepared head to contain main here forces needless rebases, while GraphQL
  # createCommitOnBranch cannot move a rebased branch's commit ancestry.
  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    PUSH_PREP_HEAD_SHA "$prep_head_sha" \
    PUSH_LOCAL_PREP_HEAD_SHA "$local_prep_head_sha" \
    PUSHED_FROM_SHA "$pushed_from_sha" \
    PR_HEAD_SHA_AFTER_PUSH "$pr_head_sha_after" \
    > "$result_env_path"
}
