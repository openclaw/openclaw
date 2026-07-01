checkout_prep_branch() {
  local pr="$1"
  require_artifact .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local prep_branch
  prep_branch=$(resolve_prep_branch_name "$pr")
  git checkout "$prep_branch"
}

resolve_prep_branch_name() {
  local pr="$1"
  require_artifact .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local prep_branch="${PREP_BRANCH:-pr-$pr-prep}"
  if ! git show-ref --verify --quiet "refs/heads/$prep_branch"; then
    echo "Expected prep branch $prep_branch not found. Run prepare-init first."
    exit 1
  fi

  printf '%s\n' "$prep_branch"
}

verify_prep_branch_matches_prepared_head() {
  local pr="$1"
  local prepared_head_sha="$2"

  local prep_branch
  prep_branch=$(resolve_prep_branch_name "$pr")
  local prep_branch_head_sha
  prep_branch_head_sha=$(git rev-parse "refs/heads/$prep_branch")
  if [ "$prep_branch_head_sha" = "$prepared_head_sha" ]; then
    return 0
  fi

  echo "Local prep branch moved after prepare-push (branch=$prep_branch expected $prepared_head_sha, got $prep_branch_head_sha)."
  if git merge-base --is-ancestor "$prepared_head_sha" "$prep_branch_head_sha" 2>/dev/null; then
    echo "Unpushed local commits on prep branch:"
    git log --oneline "${prepared_head_sha}..${prep_branch_head_sha}" | sed 's/^/  /' || true
    echo "Run scripts/pr prepare-sync-head $pr to push them before merge."
  else
    echo "Prep branch no longer contains the prepared head. Re-run prepare-init."
  fi
  exit 1
}

write_prep_sync_artifact() {
  local pr="$1"
  local pr_head="$2"
  local remote_lease_sha="$3"
  local local_head_sha="$4"
  local mainline_base_sha="$5"
  local published_head_sha="${6:-}"
  local sync_tree
  sync_tree=$(git rev-parse "${local_head_sha}^{tree}")
  local artifact_path=".local/prep-sync.env"
  if [ -L .local ] || [ ! -d .local ]; then
    echo "Refusing untrusted local artifact directory: .local"
    exit 1
  fi
  if artifact_path_is_tracked "$artifact_path"; then
    echo "Refusing tracked local artifact destination: $artifact_path"
    exit 1
  fi
  if [ -e "$artifact_path" ] || [ -L "$artifact_path" ]; then
    if [ -L "$artifact_path" ] || [ ! -f "$artifact_path" ]; then
      echo "Refusing untrusted local artifact destination: $artifact_path"
      exit 1
    fi
  fi
  local artifact_tmp
  artifact_tmp=$(mktemp .local/prep-sync.env.XXXXXX)

  # Security: shell-escape values before the repair flow sources this artifact.
  printf '%s=%q\n' \
    PREP_SYNC_PR_NUMBER "$pr" \
    PREP_SYNC_BRANCH "$pr_head" \
    PREP_SYNC_REMOTE_LEASE_SHA "$remote_lease_sha" \
    PREP_SYNC_LOCAL_HEAD_SHA "$local_head_sha" \
    PREP_SYNC_MAINLINE_BASE_SHA "$mainline_base_sha" \
    PREP_SYNC_TREE "$sync_tree" \
    PREP_SYNC_PUBLISHED_HEAD_SHA "$published_head_sha" \
    PREP_SYNC_MODE ancestry_repair \
    PREP_SYNC_REQUIRES_HOSTED_GATES 1 \
    PREP_SYNC_RECORDED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$artifact_tmp"
  mv -f "$artifact_tmp" "$artifact_path"
  if [ -L "$artifact_path" ] || [ ! -f "$artifact_path" ]; then
    echo "Failed to create regular sync artifact: $artifact_path"
    exit 1
  fi
  if artifact_path_is_tracked "$artifact_path"; then
    echo "Created sync artifact unexpectedly became tracked: $artifact_path"
    exit 1
  fi
}

require_exact_prepare_gates() {
  local prep_head_sha="$1"
  require_artifact .local/gates.env
  # shellcheck disable=SC1091
  source .local/gates.env

  if [ "${LAST_VERIFIED_HEAD_SHA:-}" != "$prep_head_sha" ]; then
    echo "Prepare gates do not cover the current local head (expected $prep_head_sha, got ${LAST_VERIFIED_HEAD_SHA:-missing})."
    exit 1
  fi
  if [ ! -e .local/prep-sync.env ] && [ ! -L .local/prep-sync.env ]; then
    return 0
  fi
  require_artifact .local/prep-sync.env

  # shellcheck disable=SC1091
  source .local/prep-sync.env
  if [ "${PREP_SYNC_MODE:-}" != "ancestry_repair" ]; then
    echo "Prepared sync artifact has an unsupported mode; restart prepare from a clean worktree."
    exit 1
  fi
  if [ "${PREP_SYNC_REQUIRES_HOSTED_GATES:-}" != "1" ]; then
    echo "Ancestry-repair artifact is stale or invalid. Re-run prepare-sync-head."
    exit 1
  fi
  if [ "${PREP_SYNC_PUBLISHED_HEAD_SHA:-}" != "$prep_head_sha" ]; then
    echo "Prepared synced head has not been published by the ancestry-repair flow."
    exit 1
  fi
  if [ "${GATES_MODE:-}" != "hosted_exact_head" ] || [ "${HOSTED_GATES_HEAD_SHA:-}" != "$prep_head_sha" ]; then
    echo "Ancestry-repaired head requires exact published-head hosted gates before prepare-push."
    exit 1
  fi
}

guard_active_prep_sync() {
  if [ ! -e .local/prep-sync.env ] && [ ! -L .local/prep-sync.env ]; then
    return 0
  fi
  require_artifact .local/prep-sync.env
  # shellcheck disable=SC1091
  source .local/prep-sync.env
  if [ "${PREP_SYNC_MODE:-}" != "ancestry_repair" ]; then
    echo "Active sync artifact has an unsupported mode; restart prepare from a clean worktree."
    return 1
  fi
  if [ "${PREP_SYNC_REQUIRES_HOSTED_GATES:-}" != "1" ]; then
    echo "Active sync artifact is legacy or invalid; remove it and re-run prepare-sync-head."
    return 1
  fi
  if [ -n "${PREP_SYNC_PUBLISHED_HEAD_SHA:-}" ]; then
    echo "Published synced head $PREP_SYNC_PUBLISHED_HEAD_SHA still requires exact hosted gates."
    echo "Run OPENCLAW_TESTBOX=1 scripts/pr prepare-run <PR>; prepare-init and prepare-sync-head cannot replace it."
  else
    echo "An active sync artifact requires its explicit publication mode; normal prepare cannot replace it."
  fi
  return 1
}

prepare_init() {
  local pr="$1"
  enter_worktree "$pr" true

  guard_active_prep_sync || exit 1

  require_artifact .local/pr-meta.env
  require_artifact .local/review.md

  if [ ! -s .local/review.json ]; then
    echo "WARNING: .local/review.json is missing; structured findings are expected."
  fi

  # shellcheck disable=SC1091
  source .local/pr-meta.env

  local json
  json=$(pr_meta_json "$pr")

  local head
  head=$(printf '%s\n' "$json" | jq -r .headRefName)
  local pr_head_sha_before
  pr_head_sha_before=$(printf '%s\n' "$json" | jq -r .headRefOid)

  if [ -n "${PR_HEAD:-}" ] && [ "$head" != "$PR_HEAD" ]; then
    echo "PR head branch changed from $PR_HEAD to $head. Re-run review-pr."
    exit 1
  fi

  git fetch origin "pull/$pr/head:pr-$pr" --force
  git checkout -B "pr-$pr-prep" "pr-$pr"
  git fetch origin main

  # Security: shell-escape values to prevent command injection via malicious branch names.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    PR_HEAD "$head" \
    PR_HEAD_SHA_BEFORE "$pr_head_sha_before" \
    PREP_BRANCH "pr-$pr-prep" \
    PREP_STARTED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/prep-context.env

  if [ ! -f .local/prep.md ]; then
    cat > .local/prep.md <<EOF_PREP
# PR $pr prepare log

- Initialized prepare context from the PR head branch without rebasing on origin/main.
EOF_PREP
  fi

  echo "worktree=$PWD"
  echo "branch=$(git branch --show-current)"
  echo "wrote=.local/prep-context.env .local/prep.md"
}

prepare_validate_commit() {
  local pr="$1"
  enter_worktree "$pr" false
  require_artifact .local/pr-meta.env

  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  local pr_number="${PR_NUMBER:-$pr}"

  local subject
  subject=$(git log -1 --pretty=%s)

  if echo "$subject" | rg -qi "(^|[[:space:]])openclaw#$pr_number([[:space:]]|$)|\\(#$pr_number\\)"; then
    echo "ERROR: prep commit subject should not include PR number metadata"
    exit 1
  fi

  if echo "$subject" | rg -qi "thanks @"; then
    echo "ERROR: prep commit subject should not include contributor thanks"
    exit 1
  fi

  echo "prep commit subject validated: $subject"
}

prepare_push() {
  local pr="$1"
  enter_worktree "$pr" false

  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env

  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local prep_head_sha
  prep_head_sha=$(git rev-parse HEAD)
  require_exact_prepare_gates "$prep_head_sha"
  local local_prep_head_sha

  local lease_sha
  lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  local push_result_env=".local/prepare-push-result.env"

  verify_pr_head_branch_matches_expected "$pr" "$PR_HEAD"
  if [ "${PREP_SYNC_MODE:-}" != "ancestry_repair" ] && [ "${OPENCLAW_PR_PUSH_MODE:-graphql}" != "git" ]; then
    require_graphql_push_preserves_ancestry "$lease_sha" "$prep_head_sha" || exit 1
  fi
  if [ "${PREP_SYNC_MODE:-}" = "ancestry_repair" ]; then
    if [ "$lease_sha" != "$PREP_SYNC_PUBLISHED_HEAD_SHA" ]; then
      echo "Repaired PR head changed after exact hosted gates; refusing to republish it."
      exit 1
    fi
    setup_prhead_remote
    local final_remote_sha
    final_remote_sha=$(resolve_prhead_remote_sha "$PR_HEAD")
    if [ "$final_remote_sha" != "$PREP_SYNC_PUBLISHED_HEAD_SHA" ]; then
      echo "Repaired remote branch changed after exact hosted gates; refusing to republish it."
      exit 1
    fi
    printf '%s=%q\n' \
      PUSH_PREP_HEAD_SHA "$prep_head_sha" \
      PUSH_LOCAL_PREP_HEAD_SHA "$prep_head_sha" \
      PUSHED_FROM_SHA "$final_remote_sha" \
      PR_HEAD_SHA_AFTER_PUSH "$final_remote_sha" \
      > "$push_result_env"
  else
    push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha" "$lease_sha" true "${DOCS_ONLY:-false}" "$push_result_env"
  fi
  # shellcheck disable=SC1090
  source "$push_result_env"
  prep_head_sha="$PUSH_PREP_HEAD_SHA"
  local_prep_head_sha="$PUSH_LOCAL_PREP_HEAD_SHA"
  local mainline_base_sha
  mainline_base_sha=$(git merge-base "$local_prep_head_sha" origin/main) || {
    echo "Unable to resolve the prepared mainline base."
    exit 1
  }
  if [ -s .local/prep-sync.env ]; then
    # shellcheck disable=SC1091
    source .local/prep-sync.env
    local current_prep_tree
    current_prep_tree=$(git rev-parse "${local_prep_head_sha}^{tree}")
    if [ "${PREP_SYNC_TREE:-}" != "$current_prep_tree" ] || [ -z "${PREP_SYNC_MAINLINE_BASE_SHA:-}" ]; then
      echo "Prepared PR head no longer matches the verified sync tree."
      exit 1
    fi
    mainline_base_sha="$PREP_SYNC_MAINLINE_BASE_SHA"
    local remove_prep_sync_after_finalize=true
  else
    local remove_prep_sync_after_finalize=false
  fi
  local pushed_from_sha="$PUSHED_FROM_SHA"
  local pr_head_sha_after="$PR_HEAD_SHA_AFTER_PUSH"

  local contrib="${PR_AUTHOR:-}"
  if [ -z "$contrib" ]; then
    contrib=$(gh pr view "$pr" --json author --jq .author.login)
  fi
  local coauthor_email=""
  if coauthor_email=$(resolve_contributor_coauthor_email "$contrib"); then
    :
  else
    coauthor_email=""
  fi

  cat >> .local/prep.md <<EOF_PREP
- Gates passed and push succeeded to branch $PR_HEAD.
- Gate mode: ${GATES_MODE:-unknown}.
- Verified the remote PR head tree matches the local prep head.
EOF_PREP

  # Security: shell-escape values to prevent command injection via propagated PR_HEAD.
  printf '%s=%q\n' \
    PR_NUMBER "$PR_NUMBER" \
    PR_AUTHOR "$contrib" \
    PR_URL "${PR_URL:-}" \
    PR_HEAD "$PR_HEAD" \
    PR_HEAD_SHA_BEFORE "$pushed_from_sha" \
    PREP_HEAD_SHA "$prep_head_sha" \
    LOCAL_PREP_HEAD_SHA "$local_prep_head_sha" \
    PREP_MAINLINE_BASE_SHA "$mainline_base_sha" \
    COAUTHOR_EMAIL "$coauthor_email" \
    > .local/prep.env

  ls -la .local/prep.md .local/prep.env >/dev/null
  if [ "$remove_prep_sync_after_finalize" = "true" ]; then
    rm -f .local/prep-sync.env
  fi

  echo "prepare-push complete"
  echo "pr_url=${PR_URL:-}"
  echo "prep_branch=$(git branch --show-current)"
  echo "prep_head_sha=$prep_head_sha"
  echo "pr_head_sha=$pr_head_sha_after"
  echo "artifacts=.local/prep.md .local/prep.env"
}

prepare_push_ancestry_repair() {
  local pr="$1"
  enter_worktree "$pr" false

  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env
  require_artifact .local/prep.md
  require_artifact .local/prep-sync.env
  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/prep-sync.env

  local required_sync_field
  for required_sync_field in \
    PREP_SYNC_PR_NUMBER \
    PREP_SYNC_BRANCH \
    PREP_SYNC_REMOTE_LEASE_SHA \
    PREP_SYNC_LOCAL_HEAD_SHA \
    PREP_SYNC_MAINLINE_BASE_SHA \
    PREP_SYNC_TREE
  do
    if [ -z "${!required_sync_field:-}" ]; then
      echo "Ancestry repair artifact is missing $required_sync_field. Re-run prepare-sync-head."
      exit 1
    fi
  done

  if [ "${OPENCLAW_PR_PUSH_MODE:-}" != "git" ] || [ "${OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH:-}" != "1" ]; then
    echo "Ancestry repair requires OPENCLAW_PR_PUSH_MODE=git and OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH=1."
    exit 1
  fi
  if [ "${PREP_SYNC_PR_NUMBER:-}" != "$pr" ] || [ "${PREP_SYNC_BRANCH:-}" != "$PR_HEAD" ]; then
    echo "Ancestry repair artifact does not match PR #$pr branch $PR_HEAD."
    exit 1
  fi
  if [ "${PREP_SYNC_REQUIRES_HOSTED_GATES:-}" != "1" ]; then
    echo "Ancestry repair artifact does not require the hosted-gates publication flow."
    exit 1
  fi
  if [ "${PREP_SYNC_MODE:-}" != "ancestry_repair" ]; then
    echo "Ancestry repair requires an ancestry_repair sync artifact."
    exit 1
  fi

  local repo_nwo
  local live_head_repo
  repo_nwo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  live_head_repo=$(gh pr view "$pr" --json headRepository --jq .headRepository.nameWithOwner)
  if [ "$PR_HEAD_REPO" != "$repo_nwo" ] || [ "$live_head_repo" != "$repo_nwo" ]; then
    echo "Ancestry repair is restricted to same-repository maintainer branches."
    exit 1
  fi
  verify_pr_head_branch_matches_expected "$pr" "$PR_HEAD"

  local local_head_sha
  local_head_sha=$(git rev-parse HEAD)
  if [ "$local_head_sha" != "${PREP_SYNC_LOCAL_HEAD_SHA:-}" ]; then
    echo "Ancestry repair refused: local prep head differs from the verified sync artifact."
    exit 1
  fi
  local local_tree
  local_tree=$(git rev-parse "${local_head_sha}^{tree}")
  if [ "$local_tree" != "${PREP_SYNC_TREE:-}" ]; then
    echo "Ancestry repair refused: local prep tree differs from the verified sync artifact."
    exit 1
  fi
  if ! git merge-base --is-ancestor "$PREP_SYNC_MAINLINE_BASE_SHA" "$local_head_sha" 2>/dev/null; then
    echo "Ancestry repair refused: verified mainline base is not an ancestor of the local prep head."
    exit 1
  fi
  local current_merge_base
  current_merge_base=$(git merge-base "$local_head_sha" origin/main)
  if [ "$current_merge_base" != "$PREP_SYNC_MAINLINE_BASE_SHA" ]; then
    echo "Ancestry repair refused: local prep head no longer has the verified mainline merge-base."
    exit 1
  fi

  local live_lease_sha
  live_lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  local recovering_published_head=false
  if [ "$live_lease_sha" != "$PREP_SYNC_REMOTE_LEASE_SHA" ]; then
    if [ "$live_lease_sha" = "$local_head_sha" ]; then
      recovering_published_head=true
    else
      echo "Ancestry repair refused: PR head changed after the sync artifact was written."
      exit 1
    fi
  fi
  setup_prhead_remote
  local remote_lease_sha
  remote_lease_sha=$(resolve_prhead_remote_sha "$PR_HEAD")
  if [ "$recovering_published_head" = "true" ] && [ "$remote_lease_sha" != "$local_head_sha" ]; then
    echo "Ancestry repair recovery refused: PR metadata and remote branch disagree."
    exit 1
  fi
  if [ "$recovering_published_head" = "false" ] && [ "$remote_lease_sha" != "$PREP_SYNC_REMOTE_LEASE_SHA" ]; then
    echo "Ancestry repair refused: remote branch changed after the sync artifact was written."
    exit 1
  fi

  # Stale gate/prepare artifacts must never survive a topology-only publish.
  rm -f .local/gates.env .local/prep.env .local/prepare-push-result.env
  local published_head_sha
  if [ "$recovering_published_head" = "true" ]; then
    published_head_sha="$local_head_sha"
  else
    published_head_sha=$(repair_synced_ancestry_ref \
      "$PR_HEAD" \
      "$PREP_SYNC_REMOTE_LEASE_SHA" \
      "$local_head_sha" \
      "$PREP_SYNC_MAINLINE_BASE_SHA" \
      "$PREP_SYNC_TREE")
  fi

  if ! wait_for_pr_head_sha "$pr" "$published_head_sha" 8 3; then
    echo "Ancestry repair published the ref, but the PR head did not converge to $published_head_sha."
    exit 1
  fi
  git fetch origin "pull/$pr/head:pr-$pr-ancestry-repair-verify" --force
  local verified_sha
  verified_sha=$(git rev-parse "pr-$pr-ancestry-repair-verify")
  local verified_tree
  verified_tree=$(git rev-parse "${verified_sha}^{tree}")
  local verified_merge_base
  verified_merge_base=$(git merge-base "$verified_sha" origin/main)
  git branch -D "pr-$pr-ancestry-repair-verify" >/dev/null 2>&1 || true
  if [ "$verified_sha" != "$local_head_sha" ] || [ "$verified_tree" != "$PREP_SYNC_TREE" ]; then
    echo "Ancestry repair verification failed: PR ref SHA or tree differs from the verified local sync."
    exit 1
  fi
  if [ "$verified_merge_base" != "$PREP_SYNC_MAINLINE_BASE_SHA" ]; then
    echo "Ancestry repair verification failed: PR ref merge-base differs from the verified mainline base."
    exit 1
  fi
  if ! git diff --quiet "$PREP_SYNC_REMOTE_LEASE_SHA" "$verified_sha"; then
    echo "Ancestry repair verification failed: PR ref publication changed file content."
    exit 1
  fi

  write_prep_sync_artifact \
    "$pr" \
    "$PR_HEAD" \
    "$PREP_SYNC_REMOTE_LEASE_SHA" \
    "$local_head_sha" \
    "$PREP_SYNC_MAINLINE_BASE_SHA" \
    "$published_head_sha"
  cat >> .local/prep.md <<EOF_PREP
- Published the verified synced commit topology to branch $PR_HEAD without changing its tree.
- Cleared stale prepare/gate artifacts; exact hosted gates are required for $published_head_sha.
EOF_PREP

  echo "prepare-push ancestry repair complete"
  echo "published_head_sha=$published_head_sha"
  echo "Run OPENCLAW_TESTBOX=1 scripts/pr prepare-gates $pr, then scripts/pr prepare-push $pr."
}

prepare_sync_head() {
  local pr="$1"
  enter_worktree "$pr" false

  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env

  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env
  guard_active_prep_sync || exit 1

  local rebased=false
  git fetch origin main
  if ! git merge-base --is-ancestor origin/main HEAD; then
    git rebase origin/main
    rebased=true
    if [ "${OPENCLAW_TESTBOX:-}" = "1" ]; then
      rm -f .local/gates.env .local/prep.env
      echo "Rebased head requires fresh exact-head hosted CI/Testbox evidence after push."
    else
      prepare_gates "$pr"
      checkout_prep_branch "$pr"
    fi
  fi

  local prep_head_sha
  prep_head_sha=$(git rev-parse HEAD)
  local local_prep_head_sha

  local lease_sha
  lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  local push_result_env=".local/prepare-sync-result.env"

  verify_pr_head_branch_matches_expected "$pr" "$PR_HEAD"
  git fetch origin "pull/$pr/head:pr-$pr-sync-lease" --force
  local fetched_lease_sha
  fetched_lease_sha=$(git rev-parse "pr-$pr-sync-lease")
  git branch -D "pr-$pr-sync-lease" >/dev/null 2>&1 || true
  if [ "$fetched_lease_sha" != "$lease_sha" ]; then
    echo "PR head changed while preparing the sync artifact. Re-run prepare-sync-head."
    exit 1
  fi

  local mainline_base_sha
  mainline_base_sha=$(git merge-base "$prep_head_sha" origin/main) || {
    echo "Unable to resolve the prepared mainline base."
    exit 1
  }
  local topology_requires_rewrite=false
  if ! git merge-base --is-ancestor "$lease_sha" "$prep_head_sha" 2>/dev/null; then
    topology_requires_rewrite=true
  fi
  local lease_tree
  local prep_tree
  lease_tree=$(git rev-parse "${lease_sha}^{tree}")
  prep_tree=$(git rev-parse "${prep_head_sha}^{tree}")
  if [ "$topology_requires_rewrite" = "true" ] && [ "$lease_tree" = "$prep_tree" ]; then
    local repo_nwo
    local live_head_repo
    repo_nwo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
    live_head_repo=$(gh pr view "$pr" --json headRepository --jq .headRepository.nameWithOwner)
    if [ "${PR_HEAD_REPO:-}" != "$repo_nwo" ] || [ "$live_head_repo" != "$repo_nwo" ]; then
      echo "Equal-tree ancestry repair is restricted to same-repository maintainer branches."
      return 1
    fi
    rm -f .local/gates.env .local/prep.env
    write_prep_sync_artifact \
      "$pr" \
      "$PR_HEAD" \
      "$lease_sha" \
      "$prep_head_sha" \
      "$mainline_base_sha" \
      ""
    echo "wrote=.local/prep-sync.env"
    echo "Equal-tree topology repair requires prepare-push --repair-ancestry; normal sync will not publish it."
    return 1
  fi

  if [ "${OPENCLAW_TESTBOX:-}" = "1" ] && [ "$prep_head_sha" != "$lease_sha" ]; then
    echo "Testbox changed-head publication is restricted to the equal-tree ancestry-repair mode."
    echo "Use the normal prepare flow for content-changing publication."
    return 1
  fi

  if [ "${OPENCLAW_TESTBOX:-}" != "1" ] && [ "$prep_head_sha" != "$lease_sha" ]; then
    local gates_cover_prep=false
    if [ -e .local/gates.env ] || [ -L .local/gates.env ]; then
      require_artifact .local/gates.env
      # shellcheck disable=SC1091
      source .local/gates.env
      if [ "${LAST_VERIFIED_HEAD_SHA:-}" = "$prep_head_sha" ]; then
        gates_cover_prep=true
      fi
    fi
    if [ "$gates_cover_prep" != "true" ]; then
      prepare_gates "$pr"
      checkout_prep_branch "$pr"
      if [ "$(git rev-parse HEAD)" != "$prep_head_sha" ]; then
        echo "Prepare gates changed the synced head; restart prepare-sync-head."
        return 1
      fi
    fi
  fi

  if [ "${OPENCLAW_PR_PUSH_MODE:-graphql}" != "git" ] && ! require_graphql_push_preserves_ancestry "$lease_sha" "$prep_head_sha"; then
    echo "Retry prepare-sync-head with the explicit git/unsigned overrides for this content-changing head."
    return 1
  fi

  push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha" "$lease_sha" false false "$push_result_env"
  # shellcheck disable=SC1090
  source "$push_result_env"
  prep_head_sha="$PUSH_PREP_HEAD_SHA"
  local_prep_head_sha="$PUSH_LOCAL_PREP_HEAD_SHA"
  mainline_base_sha=$(git merge-base "$local_prep_head_sha" origin/main) || {
    echo "Unable to resolve the prepared mainline base."
    exit 1
  }
  local pushed_from_sha="$PUSHED_FROM_SHA"
  local pr_head_sha_after="$PR_HEAD_SHA_AFTER_PUSH"

  local contrib="${PR_AUTHOR:-}"
  if [ -z "$contrib" ]; then
    contrib=$(gh pr view "$pr" --json author --jq .author.login)
  fi
  local coauthor_email=""
  if coauthor_email=$(resolve_contributor_coauthor_email "$contrib"); then
    :
  else
    coauthor_email=""
  fi

  cat >> .local/prep.md <<EOF_PREP
- Prep head sync completed to branch $PR_HEAD.
- Rebased onto origin/main: $rebased.
- Verified the remote PR head tree matches the local prep head.
EOF_PREP

  cat >> .local/prep.md <<EOF_PREP
- Prepare gates reran automatically when the sync rebase changed the prep head.
EOF_PREP

  # Security: shell-escape values to prevent command injection via propagated PR_HEAD.
  printf '%s=%q\n' \
    PR_NUMBER "$PR_NUMBER" \
    PR_AUTHOR "$contrib" \
    PR_URL "${PR_URL:-}" \
    PR_HEAD "$PR_HEAD" \
    PR_HEAD_SHA_BEFORE "$pushed_from_sha" \
    PREP_HEAD_SHA "$prep_head_sha" \
    LOCAL_PREP_HEAD_SHA "$local_prep_head_sha" \
    PREP_MAINLINE_BASE_SHA "$mainline_base_sha" \
    COAUTHOR_EMAIL "$coauthor_email" \
    > .local/prep.env

  ls -la .local/prep.md .local/prep.env >/dev/null

  echo "prepare-sync-head complete"
  echo "pr_url=${PR_URL:-}"
  echo "prep_branch=$(git branch --show-current)"
  echo "prep_head_sha=$prep_head_sha"
  echo "pr_head_sha=$pr_head_sha_after"
  echo "artifacts=.local/prep.md .local/prep.env"
}

prepare_run() {
  local pr="$1"

  enter_worktree "$pr" false

  if [ -e .local/prep-sync.env ] || [ -L .local/prep-sync.env ]; then
    require_artifact .local/prep-sync.env
    # shellcheck disable=SC1091
    source .local/prep-sync.env
    if [ "${PREP_SYNC_MODE:-}" = "ancestry_repair" ] && [ -n "${PREP_SYNC_PUBLISHED_HEAD_SHA:-}" ]; then
      if [ "${OPENCLAW_TESTBOX:-}" != "1" ]; then
        echo "Published synced head $PREP_SYNC_PUBLISHED_HEAD_SHA requires OPENCLAW_TESTBOX=1 scripts/pr prepare-run $pr."
        return 1
      fi
      prepare_gates "$pr"
      prepare_push "$pr"
      echo "prepare-run complete for PR #$pr"
      echo "pr_url=${PR_URL:-}"
      return
    fi
    if [ "${PREP_SYNC_MODE:-}" = "ancestry_repair" ]; then
      echo "Unpublished ancestry repair requires scripts/pr prepare-push --repair-ancestry $pr."
      return 1
    fi
  fi

  prepare_init "$pr"
  prepare_gates "$pr"
  prepare_push "$pr"
  echo "prepare-run complete for PR #$pr"
  echo "pr_url=${PR_URL:-}"
}
