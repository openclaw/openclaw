# shellcheck source=scripts/pr-lib/github.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)/github.sh" || return 1

checkout_prep_branch() {
  local pr="$1"
  require_artifact .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local prep_branch
  prep_branch=$(resolve_prep_branch_name "$pr")
  pr_git checkout "$prep_branch"
}

resolve_pr_author_access_at_prepare() {
  # This lookup is optional: ordinary access refusals retain unknown access;
  # an exhausted/throttled API budget must stop preparation with its diagnostics.
  local author="$1" repo_nwo="$2" repo_host="$3" response permission exit_code
  if response=$(pr_gh author-permission "$repo_nwo" "$repo_host" "$author") &&
    permission=$(printf '%s\n' "$response" | jq -er '.permission | select(type == "string")' 2>/dev/null); then
    case "$permission" in
      admin | write) printf 'maintainer\n' ;;
      read | none) printf 'external\n' ;;
      *) printf 'unknown\n' ;;
    esac
  else
    exit_code=$?
    [ "$exit_code" -ne 75 ] || return 1
    printf 'unknown\n'
  fi
}

retire_prep_evidence() {
  local archive="" artifact
  for artifact in \
    .local/prep-context.env \
    .local/prep.env \
    .local/gates.env \
    .local/prepare-push-result.env \
    .local/prepare-sync-result.env \
    .local/prep.md \
    .local/correction-review.json \
    .local/correction-review.md \
    .local/correction-incoming-review.json \
    .local/correction-incoming-review.md \
    .local/gates-*.log; do
    if [ ! -e "$artifact" ] && [ ! -L "$artifact" ]; then
      continue
    fi
    if [ ! -f "$artifact" ] || [ -L "$artifact" ]; then
      echo "Cannot retain preparation evidence at $artifact: expected a regular file." >&2
      return 1
    fi
    if [ -z "$archive" ]; then
      archive=$(mktemp -d .local/prep-evidence.XXXXXX) || return 1
    fi
    cp -p "$artifact" "$archive/" || return 1
  done
  [ -n "$archive" ] || return 0

  # Retire active authority only after every prior artifact has been retained.
  # The caller replaces prep-context.env with its validated preparation source.
  rm -f \
    .local/gates.env \
    .local/prep.env \
    .local/correction-review.json \
    .local/correction-review.md \
    .local/correction-incoming-review.json \
    .local/correction-incoming-review.md \
    .local/prepare-push-result.env \
    .local/prepare-sync-result.env || return 1
  printf '%s\n' "- Prior preparation evidence retained at $archive." >> .local/prep.md || return 1
  echo "Prior preparation evidence retained at $archive."
}

refresh_prep_branch_for_reviewed_head() {
  local pr="$1"
  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env

  # Capture the prepare context before review metadata overrides the same names.
  # shellcheck disable=SC1091
  source .local/prep-context.env
  local prepared_head_ref="${PR_HEAD:-}"
  local recorded_source_head="${PR_HEAD_SHA_BEFORE:-}"
  local prep_branch="${PREP_BRANCH:-pr-$pr-prep}"
  local author_access_at_prep="${PR_AUTHOR_ACCESS_AT_PREP:-unknown}"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  local reviewed_head_ref="${PR_HEAD:-}"
  local reviewed_head_sha="${PR_HEAD_SHA:-}"

  if [ -z "$recorded_source_head" ] || [ -z "$reviewed_head_sha" ]; then
    echo "Prepare head refresh failed: missing recorded or reviewed PR head SHA. Re-run review-init and prepare-init."
    exit 1
  fi
  if [ -n "$prepared_head_ref" ] && [ "$prepared_head_ref" != "$reviewed_head_ref" ]; then
    echo "PR head branch changed from $prepared_head_ref to $reviewed_head_ref. Re-run review-init and prepare-init."
    exit 1
  fi
  if [ "$recorded_source_head" = "$reviewed_head_sha" ]; then
    return 0
  fi

  local reviewed_ref="refs/heads/pr-$pr"
  local fetched_reviewed_head=""
  if pr_git show-ref --verify --quiet "$reviewed_ref"; then
    fetched_reviewed_head=$(pr_git rev-parse "$reviewed_ref")
  fi
  if [ "$fetched_reviewed_head" != "$reviewed_head_sha" ]; then
    echo "Reviewed PR head $reviewed_head_sha is not available at $reviewed_ref (found ${fetched_reviewed_head:-missing})."
    echo "Re-run scripts/pr review-init $pr before preparing."
    exit 1
  fi

  local prior_prep_head
  prior_prep_head=$(pr_git rev-parse "refs/heads/$prep_branch")
  echo "Prep source head changed from $recorded_source_head to reviewed head $reviewed_head_sha."
  echo "Rebuilding $prep_branch from the reviewed PR head and invalidating stale prepare evidence."
  pr_git checkout -B "$prep_branch" "$reviewed_head_sha" || return 1
  retire_prep_evidence || return 1

  # Security: shell-escape values before sourcing this context later.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    PR_HEAD "$reviewed_head_ref" \
    PR_HEAD_SHA_BEFORE "$reviewed_head_sha" \
    PREP_BRANCH "$prep_branch" \
    PR_AUTHOR_ACCESS_AT_PREP "$author_access_at_prep" \
    PREP_STARTED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/prep-context.env

  if [ ! -f .local/prep.md ]; then
    printf '# PR %s prepare log\n\n' "$pr" > .local/prep.md
  fi
  cat >> .local/prep.md <<EOF_PREP
- Rebuilt prep branch $prep_branch after reviewed PR head drifted from $recorded_source_head to $reviewed_head_sha.
- Previous prep tip was $prior_prep_head; stale gate and prepare evidence was invalidated.
EOF_PREP
  PREP_BRANCH_REFRESHED=true
}

resolve_prep_branch_name() {
  local pr="$1"
  require_artifact .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local prep_branch="${PREP_BRANCH:-pr-$pr-prep}"
  if ! pr_git show-ref --verify --quiet "refs/heads/$prep_branch"; then
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
  prep_branch_head_sha=$(pr_git rev-parse "refs/heads/$prep_branch")
  if [ "$prep_branch_head_sha" = "$prepared_head_sha" ]; then
    return 0
  fi

  echo "Local prep branch moved after prepare-push (branch=$prep_branch expected $prepared_head_sha, got $prep_branch_head_sha)."
  if pr_git merge-base --is-ancestor "$prepared_head_sha" "$prep_branch_head_sha" 2>/dev/null; then
    echo "Unpushed local commits on prep branch:"
    pr_git log --oneline "${prepared_head_sha}..${prep_branch_head_sha}" | sed 's/^/  /' || true
    echo "Run scripts/pr prepare-sync-head $pr to push them before merge."
  else
    echo "Prep branch no longer contains the prepared head. Re-run prepare-init."
  fi
  exit 1
}

prepare_init() {
  local pr="$1" observation="${2:-}" review_mode="${3:-ready}"
  local incoming_json_oid=""
  # Validate the exact reviewed head before taking the lock past its reversible phase.
  case "$review_mode" in
    ready) review_validate_artifacts "$pr" true || return 1 ;;
    correction)
      review_validate_artifacts "$pr" correction || return 1
      require_correction_review_recommendation || return 1
      incoming_json_oid=$(pr_git hash-object --no-filters .local/review.json) || return 1
      ;;
    *) echo "Unknown preparation review mode: $review_mode" >&2; return 1 ;;
  esac
  mark_pr_operation_side_effects_started
  enter_worktree "$pr" false || return 1

  require_artifact .local/pr-meta.env

  local recorded_source_head=""
  if [ -s .local/prep-context.env ]; then
    recorded_source_head=$(
      unset PR_HEAD_SHA_BEFORE
      # shellcheck disable=SC1091
      source .local/prep-context.env
      printf '%s\n' "${PR_HEAD_SHA_BEFORE:-}"
    )
  fi

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  local reviewed_head="${PR_HEAD:-}"
  local reviewed_head_sha="${PR_HEAD_SHA:-}"
  if [ -z "$reviewed_head_sha" ]; then
    echo "Prepare init failed: missing PR_HEAD_SHA in .local/pr-meta.env. Re-run review-init."
    exit 1
  fi
  # Keep clean-state admission and recoverable detachment without visiting main.
  # Fetch cannot update pr-$pr while that branch is checked out.
  checkout_pr_worktree_target "$pr" "$reviewed_head_sha" || return 1

  if [ -n "$observation" ]; then
    use_pr_observation "$pr" "$observation" || return 1
  else
    pr_observe "$pr" || return 1
  fi
  local json="$PR_OBSERVATION"
  local author_access_at_prep
  author_access_at_prep=$(resolve_pr_author_access_at_prepare "${PR_AUTHOR:-}" \
    "$(printf '%s\n' "$json" | jq -er .baseRepository.nameWithOwner)" \
    "$(printf '%s\n' "$json" | jq -er '.baseRepository.url | capture("^https://(?<host>[^/]+)/").host')") || return 1

  local head
  head=$(printf '%s\n' "$json" | jq -r .headRefName)
  local pr_head_sha_before
  pr_head_sha_before=$(printf '%s\n' "$json" | jq -r .headRefOid)

  if [ -n "$reviewed_head" ] && [ "$head" != "$reviewed_head" ]; then
    echo "PR head branch changed from $reviewed_head to $head. Re-run review-init."
    exit 1
  fi
  if [ "$pr_head_sha_before" != "$reviewed_head_sha" ]; then
    echo "PR head changed after review-init (reviewed $reviewed_head_sha, live $pr_head_sha_before). Re-run review-init."
    exit 1
  fi

  fetch_pr_head "$pr" "$reviewed_head_sha" "refs/heads/pr-$pr" "$json" || return 1
  pr_git checkout -B "pr-$pr-prep" "$reviewed_head_sha" || return 1
  retire_prep_evidence || return 1

  # Security: shell-escape values to prevent command injection via malicious branch names.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    PR_HEAD "$reviewed_head" \
    PR_HEAD_SHA_BEFORE "$reviewed_head_sha" \
    PREP_BRANCH "pr-$pr-prep" \
    PREP_REVIEW_MODE "$review_mode" \
    PREP_INCOMING_JSON_OID "$incoming_json_oid" \
    PR_AUTHOR_ACCESS_AT_PREP "$author_access_at_prep" \
    PREP_STARTED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/prep-context.env

  if [ ! -f .local/prep.md ]; then
    cat > .local/prep.md <<EOF_PREP
# PR $pr prepare log

- Initialized prepare context from the PR head branch without rebasing on origin/main.
EOF_PREP
  fi
  if [ -n "$recorded_source_head" ] && [ "$recorded_source_head" != "$reviewed_head_sha" ]; then
    echo "Rebuilt pr-$pr-prep after reviewed PR head changed from $recorded_source_head to $reviewed_head_sha."
    cat >> .local/prep.md <<EOF_PREP
- Rebuilt prep branch pr-$pr-prep after reviewed PR head changed from $recorded_source_head to $reviewed_head_sha.
EOF_PREP
  fi

  echo "worktree=$PWD"
  echo "branch=$(pr_git branch --show-current)"
  echo "wrote=.local/prep-context.env .local/prep.md"
}

prepare_correction_review_init() {
  local pr="$1"
  enter_worktree "$pr" false || return 1
  mark_pr_operation_side_effects_started
  checkout_prep_branch "$pr" || return 1
  run_prepared_correction_review "$pr" init || return 1
  echo "Complete independent review of this exact correction in .local/correction-review.json (the validated summary is rendered from JSON)."
  echo "The incoming review is unchanged; gates and publication require the corrected-candidate READY review."
}

prepare_validate_commit() {
  local pr="$1"
  enter_worktree "$pr" false || return 1
  require_artifact .local/pr-meta.env

  mark_pr_operation_side_effects_started
  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  local pr_number="${PR_NUMBER:-$pr}"

  local subject
  subject=$(pr_git log -1 --pretty=%s)

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

read_prep_publication_result() {
  local file="$1" line key value seen=" " count=0 valid=true
  if [ ! -f "$file" ] || [ -L "$file" ]; then
    echo "Invalid publication receipt $file: expected a regular file." >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      PUSH_PREP_HEAD_SHA|PUSH_LOCAL_PREP_HEAD_SHA|PUSHED_FROM_SHA|PR_HEAD_SHA_AFTER_PUSH)
        [[ "$value" =~ ^[0-9a-f]{40}$ ]] || { valid=false; break; } ;;
      PUSH_REPLACED_HOSTED_ANCESTRY)
        [ "$value" = true ] || [ "$value" = false ] || { valid=false; break; } ;;
      *) valid=false; break ;;
    esac
    case "$seen" in *" $key "*) valid=false; break ;; esac
    printf -v "$key" '%s' "$value"
    seen="$seen$key "
    count=$((count + 1))
  done < "$file"
  if [ "$valid" != true ] || [ "$count" -ne 5 ] ||
    [ "$PUSH_PREP_HEAD_SHA" != "$PR_HEAD_SHA_AFTER_PUSH" ]; then
    echo "Invalid publication receipt $file: expected the complete native result." >&2
    return 1
  fi
}

verify_prep_publication_order() {
  local previous_head="$1" previous_local="$2" next_head="$3" next_local="$4"
  [ -n "$previous_head" ] && [ "$previous_head" != "$next_head" ] || return 0
  if { pr_git merge-base --is-ancestor "$previous_head" "$next_head" &&
      pr_git merge-base --is-ancestor "$previous_head" "$next_local"; } ||
    { pr_git merge-base --is-ancestor "$next_head" "$previous_head" &&
      pr_git merge-base --is-ancestor "$next_head" "$previous_local"; }; then
    return 0
  fi
  echo "Conflicting publication receipts; retain them and inspect the hosted ancestry." >&2
  return 1
}

resolve_prep_publication_target() {
  local pr="$1" local_head="$2"
  local source_head="${PR_HEAD_SHA_BEFORE:-}" head_ref="${PR_HEAD:-}"
  if [ "${PR_NUMBER:-}" != "$pr" ] || ! [[ "$source_head" =~ ^[0-9a-f]{40}$ ]] || [ -z "$head_ref" ]; then
    echo "Missing or mismatched prepare context. Re-run review-init and prepare-init." >&2
    return 1
  fi
  PREP_PUBLICATION_LEASE_SHA="$source_head"
  PREP_PUBLICATION_HEAD_SHA="$local_head"
  # A previous publication can advance authority only for this PR, branch,
  # and prepared source. Do not let sourced receipt fields replace context.
  local PR_NUMBER="" PR_HEAD="" PR_HEAD_SHA_BEFORE=""
  local PREP_HEAD_SHA="" LOCAL_PREP_HEAD_SHA=""
  if [ -e .local/prep.env ] || [ -L .local/prep.env ]; then
    [ -f .local/prep.env ] && [ ! -L .local/prep.env ] || return 1
    # shellcheck disable=SC1091
    source .local/prep.env || return 1
    if [ "$PR_NUMBER" != "$pr" ] || [ "$PR_HEAD" != "$head_ref" ] ||
      ! [[ "$PR_HEAD_SHA_BEFORE" =~ ^[0-9a-f]{40}$ ]] ||
      ! [[ "$PREP_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] ||
      ! [[ "$LOCAL_PREP_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] ||
      ! pr_git merge-base --is-ancestor "$source_head" "$PR_HEAD_SHA_BEFORE" ||
      ! pr_git merge-base --is-ancestor "$PR_HEAD_SHA_BEFORE" "$PREP_HEAD_SHA" ||
      ! pr_git merge-base --is-ancestor "$source_head" "$LOCAL_PREP_HEAD_SHA" ||
      [ "$(pr_git rev-parse "$LOCAL_PREP_HEAD_SHA^{tree}")" != "$(pr_git rev-parse "$PREP_HEAD_SHA^{tree}")" ]; then
      echo "Publication receipt does not match this preparation. Retain artifacts and re-run review-init and prepare-init." >&2
      return 1
    fi
  fi
  local completed_head="$PREP_HEAD_SHA" completed_local="$LOCAL_PREP_HEAD_SHA"
  local selected_head="$PREP_HEAD_SHA" selected_local="$LOCAL_PREP_HEAD_SHA"
  local previous_result_head="" previous_result_local=""
  local result PUSH_PREP_HEAD_SHA="" PUSH_LOCAL_PREP_HEAD_SHA="" PUSHED_FROM_SHA=""
  local PUSH_REPLACED_HOSTED_ANCESTRY="" PR_HEAD_SHA_AFTER_PUSH=""
  for result in .local/prepare-push-result.env .local/prepare-sync-result.env; do
    [ -e "$result" ] || [ -L "$result" ] || continue
    read_prep_publication_result "$result" || return 1
    if ! pr_git merge-base --is-ancestor "$source_head" "$PUSHED_FROM_SHA" ||
      ! pr_git merge-base --is-ancestor "$PUSHED_FROM_SHA" "$PUSH_PREP_HEAD_SHA" ||
      ! pr_git merge-base --is-ancestor "$source_head" "$PUSH_LOCAL_PREP_HEAD_SHA" ||
      [ "$PUSH_REPLACED_HOSTED_ANCESTRY" != false ] ||
      [ "$(pr_git rev-parse "$PUSH_LOCAL_PREP_HEAD_SHA^{tree}")" != "$(pr_git rev-parse "$PUSH_PREP_HEAD_SHA^{tree}")" ]; then
      echo "Publication receipt $result does not match this preparation." >&2
      return 1
    fi
    # A completed merge can contain conflicting older receipts. Validate every
    # recorded pair before selecting; equal GraphQL aliases need no self-ancestry.
    verify_prep_publication_order "$completed_head" "$completed_local" "$PUSH_PREP_HEAD_SHA" "$PUSH_LOCAL_PREP_HEAD_SHA" || return 1
    verify_prep_publication_order "$previous_result_head" "$previous_result_local" "$PUSH_PREP_HEAD_SHA" "$PUSH_LOCAL_PREP_HEAD_SHA" || return 1
    previous_result_head="$PUSH_PREP_HEAD_SHA"
    previous_result_local="$PUSH_LOCAL_PREP_HEAD_SHA"
    if [ -z "$selected_head" ] ||
      { [ "$selected_head" != "$PUSH_PREP_HEAD_SHA" ] &&
        pr_git merge-base --is-ancestor "$selected_head" "$PUSH_PREP_HEAD_SHA"; }; then
      selected_head="$PUSH_PREP_HEAD_SHA"
      selected_local="$PUSH_LOCAL_PREP_HEAD_SHA"
    elif [ "$selected_head" = "$PUSH_PREP_HEAD_SHA" ] &&
      [ "$selected_head" != "$completed_head" ] && [ "$local_head" = "$PUSH_LOCAL_PREP_HEAD_SHA" ]; then
      selected_local="$PUSH_LOCAL_PREP_HEAD_SHA"
    fi
  done
  [ -n "$selected_head" ] || return 0
  PREP_PUBLICATION_LEASE_SHA="$selected_head"
  if [ "$local_head" = "$selected_local" ]; then
    # GraphQL can return a different verified OID for this exact local commit.
    # Only that recorded pair permits a no-op; new fixups must extend the OID.
    PREP_PUBLICATION_HEAD_SHA="$selected_head"
  else
    verify_prep_head_extends_hosted_head "$selected_head" "$local_head" || return 1
  fi
}

verify_correction_publication_authority() {
  [ -n "${PREP_PUBLICATION_REVIEW_SNAPSHOT:-}" ] || return 0
  require_correction_publication_gates "$PREP_PUBLICATION_PR" "$(pr_git rev-parse HEAD)" \
    "$PREP_PUBLICATION_ALLOW_PENDING" || return 1
  verify_correction_review_snapshot "$PREP_PUBLICATION_PR" "$PREP_PUBLICATION_REVIEW_SNAPSHOT"
}

prepare_push() {
  local pr="$1"
  local observation="${2:-}" resume_run="${3:-}"
  local PREP_PUBLICATION_REVIEW_SNAPSHOT="" PREP_PUBLICATION_PR="$pr" PREP_PUBLICATION_ALLOW_PENDING=true
  PR_MAIN_SHA=""
  enter_worktree "$pr" false true || return 1
  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env
  if [ -n "$resume_run" ]; then
    resume_prepare_crabbox_gate "$pr" "$resume_run"
    return $?
  fi
  # Inspect retained intent before any main refresh, recovery or checkout.
  if [ -f .local/gates.env ] && rg -q '^PENDING_CRABBOX_' .local/gates.env; then
    echo "Crabbox dispatch is pending; use prepare-push $pr --resume-crabbox-run <Actions run ID>." >&2
    return 1
  fi
  enter_worktree "$pr" false || return 1
  mark_pr_operation_side_effects_started
  PREP_BRANCH_REFRESHED=false
  refresh_prep_branch_for_reviewed_head "$pr"
  checkout_prep_branch "$pr"
  if [ "$PREP_BRANCH_REFRESHED" = "true" ]; then
    echo "Prep branch was refreshed for reviewed head drift; rerunning prepare gates before push."
    prepare_gates "$pr"
    checkout_prep_branch "$pr"
    refresh_main_snapshot || return 1
  fi
  require_artifact .local/gates.env

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/gates.env

  local prep_head_sha
  prep_head_sha=$(pr_git rev-parse HEAD)
  local local_prep_head_sha

  resolve_prep_publication_target "$pr" "$prep_head_sha" || return 1
  local lease_sha="$PREP_PUBLICATION_LEASE_SHA"
  prep_head_sha="$PREP_PUBLICATION_HEAD_SHA"
  local push_result_env=".local/prepare-push-result.env"
  if [ "${GATES_MODE:-}" = github_pending ] && [ "${HOSTED_GATES_TARGET_HEAD_SHA:-}" != "$prep_head_sha" ]; then
    echo "Deferred GitHub gates do not match the prepared head; re-run prepare-gates." >&2
    return 1
  fi

  require_prepared_review "$pr" || return 1
  PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot "$pr") || return 1
  verify_correction_publication_authority || return 1
  push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha" "$lease_sha" "$push_result_env" "$observation" || return $?
  # shellcheck disable=SC1090
  source "$push_result_env"
  prep_head_sha="$PUSH_PREP_HEAD_SHA"
  local_prep_head_sha="$PUSH_LOCAL_PREP_HEAD_SHA"
  local mainline_base_sha
  mainline_base_sha=$(pr_git merge-base "$local_prep_head_sha" "$PR_MAIN_SHA") || {
    echo "Unable to resolve the prepared mainline base."
    exit 1
  }
  local pushed_from_sha="$PUSHED_FROM_SHA"
  local pr_head_sha_after="$PR_HEAD_SHA_AFTER_PUSH"

  if [ "${GATES_MODE:-}" = "remote_crabbox_aws_pending" ]; then
    finalize_remote_crabbox_aws_gate "$pr" "$prep_head_sha" || return 1
    # shellcheck disable=SC1091
    source .local/gates.env
  elif [ "${GATES_MODE:-}" = github_pending ]; then
    # Publication can assign a new OID to the verified prepared tree.
    write_gates_env_stamp "$pr" "${DOCS_ONLY:-false}" "${CHANGELOG_REQUIRED:-false}" \
      github_pending "" "" "$prep_head_sha" "" "" "" "" || return 1
  fi

  complete_prepare_push "$prep_head_sha" "$local_prep_head_sha" "$mainline_base_sha" "$pushed_from_sha" "$pr_head_sha_after"
}

resume_prepare_crabbox_gate() {
  local pr="$1" resume_run="$2"
  [[ "$resume_run" =~ ^[1-9][0-9]*$ ]] || return 2
  require_artifact .local/gates.env || return 1
  require_artifact .local/prepare-push-result.env || return 1
  local gate_record
  gate_record=$(node "$script_parent_dir/pr-lib/ci-dispatch.mjs" --read-crabbox-gates) || return 1
  source .local/pr-meta.env || return 1
  source .local/prep-context.env || return 1
  # Only validated data is consumed here; never source pending shell assignments.
  GATES_MODE=$(printf '%s\n' "$gate_record" | jq -r .GATES_MODE)
  LAST_VERIFIED_HEAD_SHA=$(printf '%s\n' "$gate_record" | jq -r .LAST_VERIFIED_HEAD_SHA)
  FULL_GATES_HEAD_SHA=$(printf '%s\n' "$gate_record" | jq -r '.FULL_GATES_HEAD_SHA // ""')
  PENDING_CRABBOX_BASE_SHA=$(printf '%s\n' "$gate_record" | jq -r '.PENDING_CRABBOX_BASE_SHA // .REMOTE_GATES_BASE_SHA // ""')
  PENDING_CRABBOX_STATE=$(printf '%s\n' "$gate_record" | jq -r '.PENDING_CRABBOX_STATE // ""')
  DOCS_ONLY=$(printf '%s\n' "$gate_record" | jq -r '.DOCS_ONLY // "false"')
  CHANGELOG_REQUIRED=$(printf '%s\n' "$gate_record" | jq -r '.CHANGELOG_REQUIRED // "false"')
  if [ "$PR_NUMBER" != "$pr" ] || [ "$(printf '%s\n' "$gate_record" | jq -r .PR_NUMBER)" != "$pr" ] ||
    [ "$(pr_git branch --show-current)" != "$(resolve_prep_branch_name "$pr")" ] ||
    [ -n "$(pr_git status --porcelain --untracked-files=no)" ]; then
    echo "Crabbox resume requires the unchanged, clean published preparation and pending gate receipt." >&2
    return 1
  fi
  local local_head head base pushed_from after
  local_head=$(pr_git rev-parse HEAD) || return 1
  resolve_prep_publication_target "$pr" "$local_head" || return 1
  read_prep_publication_result .local/prepare-push-result.env || return 1
  head="$PUSH_PREP_HEAD_SHA"
  if [ "$PUSH_LOCAL_PREP_HEAD_SHA" != "$local_head" ] ||
    [ "$PREP_PUBLICATION_HEAD_SHA" != "$head" ] ||
    { [ "$LAST_VERIFIED_HEAD_SHA" != "$head" ] && [ "$LAST_VERIFIED_HEAD_SHA" != "$local_head" ]; } ||
    { [ "$GATES_MODE" = remote_crabbox_aws_pending ] && [ -n "$FULL_GATES_HEAD_SHA" ]; } ||
    { [ "$GATES_MODE" = remote_crabbox_aws ] && [ "$FULL_GATES_HEAD_SHA" != "$head" ]; }; then
    echo "Crabbox resume publication and gate identities do not match." >&2
    return 1
  fi
  pushed_from="$PUSHED_FROM_SHA"
  after="$PR_HEAD_SHA_AFTER_PUSH"
  # Reuse the historical dispatch base, never a fresh main snapshot. The final
  # publisher check must bind this retained base before either success receipt.
  base="${PENDING_CRABBOX_BASE_SHA:-}"
  if [ -z "$base" ]; then
    require_artifact .local/pr-meta.json || return 1
    base=$(jq -er '.baseRefOid | strings' .local/pr-meta.json) || return 1
  fi
  [[ "$base" =~ ^[0-9a-f]{40}$ ]] || return 1
  local mainline_base
  mainline_base=$(pr_git merge-base "$local_head" "$base") || return 1
  require_prepared_review "$pr" || return 1
  PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot "$pr") || return 1
  verify_correction_publication_authority || return 1
  mark_pr_operation_side_effects_started
  finalize_remote_crabbox_aws_gate "$pr" "$head" "$resume_run" "$base" || return 1
  [ "$(pr_git rev-parse HEAD)" = "$local_head" ] || return 1
  [ -z "$(pr_git status --porcelain --untracked-files=no)" ] || return 1
  require_prepared_review "$pr" || return 1
  source .local/gates.env || return 1
  complete_prepare_push "$head" "$local_head" "$mainline_base" "$pushed_from" "$after"
}

complete_prepare_push() {
  local prep_head_sha="$1" local_prep_head_sha="$2" mainline_base_sha="$3"
  local pushed_from_sha="$4" pr_head_sha_after="$5"
  local contrib="${PR_AUTHOR:-}"
  if [ -z "$contrib" ]; then
    contrib=$(printf '%s\n' "$PR_HEAD_OBSERVATION" | jq -r .author.login) || return 1
  fi
  local coauthor_email=""
  if coauthor_email=$(resolve_contributor_coauthor_email "$contrib"); then
    :
  else
    coauthor_email=""
  fi

  if [ "${GATES_MODE:-}" = github_pending ]; then
    printf '%s\n' "- Required GitHub gates deferred; push succeeded to branch $PR_HEAD." >> .local/prep.md
  else
    printf '%s\n' "- Gates passed and push succeeded to branch $PR_HEAD." >> .local/prep.md
  fi
  cat >> .local/prep.md <<EOF_PREP
- Gate mode: ${GATES_MODE:-unknown}.
- Verified the remote PR head tree matches the local prep head.
EOF_PREP
  if [ "${GATES_MODE:-}" != github_pending ] && [ -n "${REMOTE_GATES_LEASE_ID:-}" ]; then
    cat >> .local/prep.md <<EOF_PREP
- Remote gate stamp: ${REMOTE_GATES_PROVIDER:-unknown} ${REMOTE_GATES_RUN_ID:+run ${REMOTE_GATES_RUN_ID}, }lease ${REMOTE_GATES_LEASE_ID}${REMOTE_GATES_RUN_URL:+ (${REMOTE_GATES_RUN_URL})}.
EOF_PREP
  fi

  local temporary
  temporary=$(mktemp .local/prep.env.XXXXXX) || return 1
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
    PREP_REPLACED_HOSTED_ANCESTRY "$PUSH_REPLACED_HOSTED_ANCESTRY" \
    PREP_AUTHOR_ACCESS "${PR_AUTHOR_ACCESS_AT_PREP:-unknown}" \
    COAUTHOR_EMAIL "$coauthor_email" \
    > "$temporary" || { rm -f "$temporary"; return 1; }
  mv -f "$temporary" .local/prep.env || { rm -f "$temporary"; return 1; }

  ls -la .local/prep.md .local/prep.env >/dev/null

  echo "prepare-push complete"
  echo "pr_url=${PR_URL:-}"
  echo "prep_branch=$(pr_git branch --show-current)"
  echo "prep_head_sha=$prep_head_sha"
  echo "pr_head_sha=$pr_head_sha_after"
  echo "artifacts=.local/prep.md .local/prep.env"
}

prepare_sync_head() {
  local pr="$1"
  local PREP_PUBLICATION_REVIEW_SNAPSHOT="" PREP_PUBLICATION_PR="$pr" PREP_PUBLICATION_ALLOW_PENDING=false
  enter_worktree "$pr" false || return 1

  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env

  mark_pr_operation_side_effects_started
  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  # merge-verify owns relevance-aware mainline drift. Keep the hosted PR head
  # as the publication parent so fork updates contain only reviewed fixups.
  local prep_head_sha
  prep_head_sha=$(pr_git rev-parse HEAD)
  local local_prep_head_sha

  resolve_prep_publication_target "$pr" "$prep_head_sha" || return 1
  local lease_sha="$PREP_PUBLICATION_LEASE_SHA"
  prep_head_sha="$PREP_PUBLICATION_HEAD_SHA"
  local push_result_env=".local/prepare-sync-result.env"

  require_prepared_review "$pr" || return 1
  PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot "$pr") || return 1
  verify_correction_publication_authority || return 1
  push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha" "$lease_sha" "$push_result_env" || return $?
  # shellcheck disable=SC1090
  source "$push_result_env"
  prep_head_sha="$PUSH_PREP_HEAD_SHA"
  local_prep_head_sha="$PUSH_LOCAL_PREP_HEAD_SHA"
  local mainline_base_sha
  mainline_base_sha=$(pr_git merge-base "$local_prep_head_sha" "$PR_MAIN_SHA") || {
    echo "Unable to resolve the prepared mainline base."
    exit 1
  }
  local pushed_from_sha="$PUSHED_FROM_SHA"
  local pr_head_sha_after="$PR_HEAD_SHA_AFTER_PUSH"

  local contrib="${PR_AUTHOR:-}"
  if [ -z "$contrib" ]; then
    contrib=$(printf '%s\n' "$PR_HEAD_OBSERVATION" | jq -r .author.login) || return 1
  fi
  local coauthor_email=""
  if coauthor_email=$(resolve_contributor_coauthor_email "$contrib"); then
    :
  else
    coauthor_email=""
  fi

  cat >> .local/prep.md <<EOF_PREP
- Prep head sync completed to branch $PR_HEAD.
- Preserved hosted PR ancestry; merge verification owns mainline drift.
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
    PREP_REPLACED_HOSTED_ANCESTRY "$PUSH_REPLACED_HOSTED_ANCESTRY" \
    PREP_AUTHOR_ACCESS "${PR_AUTHOR_ACCESS_AT_PREP:-unknown}" \
    COAUTHOR_EMAIL "$coauthor_email" \
    > .local/prep.env

  ls -la .local/prep.md .local/prep.env >/dev/null

  echo "prepare-sync-head complete"
  echo "pr_url=${PR_URL:-}"
  echo "prep_branch=$(pr_git branch --show-current)"
  echo "prep_head_sha=$prep_head_sha"
  echo "pr_head_sha=$pr_head_sha_after"
  echo "artifacts=.local/prep.md .local/prep.env"
}

prepare_run() {
  local pr="$1"
  prepare_init "$pr" "${2:-}" || return 1
  local observation="$PR_HEAD_OBSERVATION"
  prepare_gates "$pr" "$observation" || return 1
  prepare_push "$pr" "$observation" || return 1
  echo "prepare-run complete for PR #$pr"
  echo "pr_url=${PR_URL:-}"
}
