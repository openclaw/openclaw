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
  PREP_RETIRED_EVIDENCE=""
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
    .local/prepare-baseline.json \
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
    cmp -s "$artifact" "$archive/${artifact##*/}" || return 1
  done
  [ -n "$archive" ] || return 0
  PREP_RETIRED_EVIDENCE="$archive"
  [ "${1:-}" != retain ] || return 0

  # Retire active authority only after every prior artifact has been retained.
  # The caller replaces prep-context.env with its validated preparation source.
  rm -f \
    .local/gates.env \
    .local/prep.env \
    .local/correction-review.json \
    .local/correction-review.md \
    .local/correction-incoming-review.json \
    .local/correction-incoming-review.md \
    .local/prepare-baseline.json \
    .local/prepare-push-result.env \
    .local/prepare-sync-result.env || return 1
  printf '%s\n' "- Prior preparation evidence retained at $archive." >> .local/prep.md || return 1
  echo "Prior preparation evidence retained at $archive."
}

prepare_workflow_successor() (
  local pr="$1" request="${PR_WORKFLOW_SUCCESSOR:-}" head tree review hosted snapshot next
  local purpose=qualified
  [ -n "$request" ] || return 1
  [ "$(printf '%s\n' "$request" | jq -r '.purpose // "qualified"')" != proof ] || purpose=proof
  enter_worktree "$pr" false true || return 1
  require_artifact .local/prep-context.env || return 1
  local PR_NUMBER="" PR_HEAD="" PR_HEAD_SHA_BEFORE="" PREP_REVIEW_MODE=""
  source .local/prep-context.env || return 1
  [ "$PR_NUMBER" = "$pr" ] && [ "$PREP_REVIEW_MODE" = correction ] || {
    echo "Workflow succession requires an existing correction preparation." >&2; return 1;
  }
  IFS=$'\t' read -r head tree review hosted < <(printf '%s\n' "$request" | jq -r '[.head,.tree,.review,.hostedHead] | @tsv')
  [ "$(pr_git rev-parse HEAD)" = "$head" ] && [ "$(pr_git rev-parse 'HEAD^{tree}')" = "$tree" ] &&
    [ -z "$(pr_git status --porcelain --untracked-files=no)" ] &&
    [ "$(pr_git branch --show-current)" = "$(resolve_prep_branch_name "$pr")" ] || {
    echo "Workflow succession requires the unchanged retained preparation branch and tree." >&2; return 1;
  }
  if has_worktree_merge_output . ||
    { [ -f .local/gates.env ] && grep -q '^PENDING_CRABBOX_' .local/gates.env; }; then
    echo "Retained merge or pending dispatch evidence requires its existing reconciliation owner." >&2; return 1
  fi
  snapshot=$(correction_review_snapshot "$pr" "$purpose") || return 1
  [ -n "$snapshot" ] && [ "$(pr_git hash-object --no-filters -- .local/correction-review.json)" = "$review" ] || return 1
  resolve_prep_publication_target "$pr" "$head" || return 1
  [ "$PREP_PUBLICATION_LEASE_SHA" = "$hosted" ] || {
    echo "Workflow succession hosted authority changed; retain the publication receipts." >&2; return 1;
  }
  # Compare one fresh observation with retained review identity. A successor
  # changes tooling, never the hosted lease or a GraphQL local/hosted alias.
  local observation
  observation=$(cat .local/pr-meta.json) || return 1
  revalidate_pr_publication "$pr" "$observation" "$PR_HEAD" "$hosted" "$hosted" || return 1
  if [ "$purpose" = proof ]; then
    require_proof_publication_hosted_state "$pr" "$hosted" "$hosted" || return 1
  fi
  verify_correction_review_snapshot "$pr" "$snapshot" "$purpose" || return 1
  retire_prep_evidence retain || return 1
  verify_correction_review_snapshot "$pr" "$snapshot" "$purpose" || return 1
  # prep.env can be the only surviving authority for a completed publication.
  # Retire only qualification, before CAS: either binding then fails closed.
  if [ -e .local/gates.env ] || [ -L .local/gates.env ]; then
    [ -f .local/gates.env ] && [ ! -L .local/gates.env ] &&
      cmp -s .local/gates.env "$PREP_RETIRED_EVIDENCE/gates.env" || return 1
    rm .local/gates.env || return 1
  fi
  verify_correction_review_snapshot "$pr" "$snapshot" "$purpose" || return 1
  next=$(pr_batch_wrapper_git workflow-successor-commit "$canonical_repo_root" "$pr" \
    "$PR_WORKFLOW_SOURCE_REVISION" "$request" "$PR_WORKFLOW_TRUST_ANCHOR" "$snapshot" \
    "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID" "$PWD") || return 1
  printf 'Correction workflow successor admitted: %s\n' "$next"
  if [ "$purpose" = proof ]; then
    printf 'Source and pending proof retained; only scripts/pr prepare-publish-for-proof %s is admitted. Ordinary gates and merge remain blocked.\n' "$pr"
  else
    printf 'Source and review retained; run scripts/pr prepare-gates %s before publication.\n' "$pr"
  fi
)

prepare_baseline_successor() (
  # Explicit admission, never inferred by refresh or recovery from a present binding.
  prepare_baseline_materialize successor "$@"
)

prepare_baseline_refresh() { prepare_baseline_materialize initial "$@"; }
prepare_baseline_signing_request() { prepare_baseline_materialize request "$@"; }

revalidate_baseline_publication() (
  local pr="$1" observation="$2" source="$3" artifacts="${4:-.local}"
  local PR_NUMBER="" PR_HEAD="" PR_HEAD_SHA_BEFORE=""
  source "$artifacts/prep-context.env" || return 1
  resolve_prep_publication_target "$pr" "$source" "$artifacts" || return 1
  verify_prep_head_extends_hosted_head "$PREP_PUBLICATION_LEASE_SHA" "$source" || return 1
  if [ "$PREP_PUBLICATION_LEASE_SHA" != "$PR_HEAD_SHA_BEFORE" ]; then
    local result retained=false
    local PUSH_PREP_HEAD_SHA="" PUSH_LOCAL_PREP_HEAD_SHA="" PUSHED_FROM_SHA=""
    local PUSH_REPLACED_HOSTED_ANCESTRY="" PR_HEAD_SHA_AFTER_PUSH=""
    for result in "$artifacts/prepare-push-result.env" "$artifacts/prepare-sync-result.env"; do
      [ -e "$result" ] || [ -L "$result" ] || continue
      read_prep_publication_result "$result" || return 1
      [ "$PUSH_PREP_HEAD_SHA" != "$PREP_PUBLICATION_LEASE_SHA" ] || retained=true
    done
    if [ "$retained" != true ]; then
      echo "Baseline admission requires the native publication result for hosted head $PREP_PUBLICATION_LEASE_SHA." >&2
      echo "Retain preparation evidence and recover the completed publication result before retrying." >&2
      return 1
    fi
  fi
  # Only a native receipt can advance hosted authority beyond the incoming head.
  # The local candidate alone does not prove that this workflow published it.
  revalidate_pr_publication "$pr" "$observation" "$PR_HEAD" \
    "$PREP_PUBLICATION_LEASE_SHA" "$PREP_PUBLICATION_LEASE_SHA"
)

recover_correction_continuation() (
  local pr="$1" facts observation incoming head_ref root helper
  shift
  root=$(repo_root) || return 1
  helper="$(dirname "$(review_artifacts_helper_path)")/correction-continuation.mjs"
  facts=$(node "$helper" replay "$pr" "$root" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID" "$@") || return 1
  observation=$(cat .local/pr-meta.json) || return 1
  incoming=$(printf '%s' "$facts" | jq -er .request.incoming) || return 1
  head_ref=$(printf '%s' "$observation" | jq -er .headRefName) || return 1
  revalidate_pr_publication "$pr" "$observation" "$head_ref" "$incoming" "$incoming" || return 1
  mark_pr_operation_side_effects_started
  printf '%s' "$facts" | node "$helper" apply "$pr" "$root" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID"
)

prepare_correction_continue() (
  local pr="$1" head="" tree="" incoming="" review="" receipt="" receipt_oid="" option
  shift
  while [ "$#" -gt 0 ]; do
    option="$1"
    [ "$#" -ge 2 ] && [ -n "$2" ] || return 2
    case "$option" in
      --expected-head) [ -z "$head" ] || return 2; head="$2" ;;
      --expected-tree) [ -z "$tree" ] || return 2; tree="$2" ;;
      --incoming-head) [ -z "$incoming" ] || return 2; incoming="$2" ;;
      --incoming-review) [ -z "$review" ] || return 2; review="$2" ;;
      --publication-receipt) [ -z "$receipt" ] || return 2; receipt="$2" ;;
      --publication-oid) [ -z "$receipt_oid" ] || return 2; receipt_oid="$2" ;;
      *) return 2 ;;
    esac
    shift 2
  done
  for option in "$head" "$tree" "$incoming" "$review" "$receipt_oid"; do
    [[ "$option" =~ ^[0-9a-f]{40}$ ]] || return 2
  done
  case "$receipt" in
    push | sync) receipt="prepare-$receipt-result.env" ;;
    *) return 2 ;;
  esac
  # This route must never refresh/reset the retained preparation branch.
  enter_worktree "$pr" false true || return 1
  if [ -e .local/review-transition.json ] || [ -L .local/review-transition.json ]; then
    recover_correction_continuation "$pr" "$head" "$tree" "$incoming" "$review" "$receipt" "$receipt_oid" || return 1
  else
    [ "$(pr_git branch --show-current)" = "pr-$pr-prep" ] &&
      [ "$(pr_git rev-parse HEAD)" = "$head" ] &&
      [ "$(pr_git rev-parse HEAD^{tree})" = "$tree" ] &&
      [ -z "$(pr_git --no-optional-locks status --porcelain)" ] || {
        echo "Continuation requires the selected clean preparation branch, HEAD and tree." >&2
        return 1
      }
    local root helper facts observation head_ref
    root=$(repo_root) || return 1
    helper="$(dirname "$(review_artifacts_helper_path)")/correction-continuation.mjs"
    mark_pr_operation_side_effects_started
    retire_prep_evidence retain || return 1
    facts=$(node "$helper" prepare "$pr" "$root" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID" \
      "$head" "$tree" "$incoming" "$review" "$receipt" "$receipt_oid" "$PREP_RETIRED_EVIDENCE") || return 1
    observation=$(cat .local/pr-meta.json) || return 1
    head_ref=$(printf '%s' "$observation" | jq -er .headRefName) || return 1
    revalidate_pr_publication "$pr" "$observation" "$head_ref" "$incoming" "$incoming" || return 1
    printf '%s' "$facts" | node "$helper" apply "$pr" "$root" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID" || return 1
  fi
  echo "Continued correction at retained HEAD $head; source and prior proof preserved."
  echo "Fresh exact-candidate correction review and native gates are required."
)

prepare_baseline_materialize() (
  local admission="$1"
  shift
  local pr="$1" expected="" baseline="" resolutions="" option signer=""
  local expected_tree="" expected_review="" predecessor_head="" predecessor_binding=""
  local successor=false
  [ "$admission" != successor ] || successor=true
  shift
  while [ "$#" -gt 0 ]; do
    option="$1"
    [ "$#" -ge 2 ] && [ -n "$2" ] || return 2
    case "$option" in
      --expected-head) [ -z "$expected" ] || return 2; expected="$2" ;;
      --baseline) [ -z "$baseline" ] || return 2; baseline="$2" ;;
      --resolutions) [ -z "$resolutions" ] || return 2; resolutions="$2" ;;
      --signer) [ "$admission" = request ] && [ -z "$signer" ] || return 2; signer="$2" ;;
      --expected-tree) { [ "$successor" = true ] || [ "$admission" = request ]; } && [ -z "$expected_tree" ] || return 2; expected_tree="$2" ;;
      --expected-review) { [ "$successor" = true ] || [ "$admission" = request ]; } && [ -z "$expected_review" ] || return 2; expected_review="$2" ;;
      --predecessor-head) { [ "$successor" = true ] || [ "$admission" = request ]; } && [ -z "$predecessor_head" ] || return 2; predecessor_head="$2" ;;
      --predecessor-binding) { [ "$successor" = true ] || [ "$admission" = request ]; } && [ -z "$predecessor_binding" ] || return 2; predecessor_binding="$2" ;;
      *) return 2 ;;
    esac
    shift 2
  done
  if [ "$admission" = request ]; then
    [ -n "$signer" ] || return 2
    [ -z "$expected_tree$expected_review$predecessor_head$predecessor_binding" ] || successor=true
  fi
  [[ "$expected" =~ ^[0-9a-f]{40}$ ]] && [[ "$baseline" =~ ^[0-9a-f]{40}$ ]] || return 2
  if [ "$successor" = true ]; then
    for option in "$expected_tree" "$expected_review" "$predecessor_head" "$predecessor_binding"; do
      [[ "$option" =~ ^[0-9a-f]{40}$ ]] || return 2
    done
  fi
  enter_worktree "$pr" false || return 1
  local PREP_BRANCH="" PREP_REVIEW_MODE="" PR_NUMBER="" PR_HEAD_SHA_BEFORE=""
  local PREP_INCOMING_JSON_OID=""
  local PREP_BASELINE_REFRESH_HEAD="" PREP_BASELINE_REFRESH_OID=""
  source .local/prep-context.env || return 1
  [ "$PREP_REVIEW_MODE" = correction ] && [ "$PR_NUMBER" = "$pr" ] &&
    [ "$PREP_BRANCH" = "pr-$pr-prep" ] || return 1
  local snapshot target helper root observation prepared binding source_directory
  source_directory=$(pwd -P) || return 1
  root=$(repo_root) || return 1
  helper="$(dirname "$(review_artifacts_helper_path)")/baseline-refresh.mjs"
  node "$helper" check-signing-source "$expected" || return 1
  if [ "$successor" = false ] && [ "$expected" = "$PR_HEAD_SHA_BEFORE" ]; then
    snapshot=$(node "$helper" incoming-source-snapshot "$pr" "$expected" "$PREP_INCOMING_JSON_OID") || return 1
  else
    snapshot=$(correction_review_snapshot "$pr") || return 1
  fi
  observation=$(cat .local/pr-meta.json) || return 1
  [ -n "$snapshot" ] && [ -n "$PR_MAIN_SHA" ] || return 1
  require_baseline_source() {
    revalidate_baseline_publication "$pr" "$observation" "$expected" || return 1
    # The initial snapshot and create owner already validate the signed review.
    # After the live observation compare exact bytes, never replay that history.
    printf '%s' "$snapshot" | node "$helper" check-source "$pr" "$expected" "$source_directory" \
      "$root" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID"
  }
  if [ "$successor" = true ] && {
    [ "$PREP_BASELINE_REFRESH_HEAD" != "$predecessor_head" ] ||
    [ "$PREP_BASELINE_REFRESH_OID" != "$predecessor_binding" ] ||
    [ "$(pr_git rev-parse "$expected^{tree}")" != "$expected_tree" ] ||
    [ "$(pr_git hash-object --no-filters .local/correction-review.json)" != "$expected_review" ];
  }; then
    echo "Successor admission does not match the selected source, review or predecessor." >&2
    return 1
  fi
  require_baseline_source || return 1
  pr_git merge-base --is-ancestor "$baseline" "$PR_MAIN_SHA" || return 1
  mark_pr_operation_side_effects_started
  retire_prep_evidence retain || return 1
  local create_command=create
  set -- "$pr" "$expected" "$baseline" "$PR_MAIN_SHA" "$PREP_RETIRED_EVIDENCE" "$snapshot" "$resolutions"
  if [ "$successor" = true ]; then
    create_command=create-successor
    set -- "$@" "$predecessor_head" "$predecessor_binding" "$expected_review" "$expected_tree"
  fi
  if [ "$admission" = request ]; then
    create_command=create-signing-request
    set -- "$@" "$signer"
  fi
  prepared=$(node "$helper" "$create_command" "$@") || return 1
  if [ "$admission" = request ]; then
    require_baseline_source || return 1
    local request_oid
    request_oid=$(printf '%s' "$prepared" | node "$helper" save-signing-request \
      "$pr" "$root" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID") || return 1
    echo "Awaiting signature: request=$request_oid file=.local/prepare-baseline-signing.$request_oid.json"
    echo "Preparation authority and branch remain unchanged. Return the complete signed Git commit."
    return 0
  fi
  target=$(printf '%s' "$prepared" | jq -er .target) || return 1
  binding=$(printf '%s' "$prepared" | jq -er .binding) || return 1
  require_no_ignored_transition_paths "$pr" "$expected" "$target" || return 1
  require_baseline_source || return 1
  write_review_transition_journal "$pr" "$expected" "$target" prep "$PREP_BRANCH" "$binding" || return 1
  recover_review_transition "$pr" || return 1
  echo "Refreshed candidate $target; prior proof retained at $PREP_RETIRED_EVIDENCE."
  printf '%s' "$prepared" | jq -r '.resolutions[] | "Resolved \(.path): \(if .resolved == null then "deleted" else .resolved.mode + " " + .resolved.oid end)"' || return 1
  echo "Fresh exact-candidate correction review and native gate qualification are required."
)

prepare_baseline_signing_continue() (
  local pr="$1" request="" commit="" option
  shift
  while [ "$#" -gt 0 ]; do
    option="$1"
    [ "$#" -ge 2 ] && [ -n "$2" ] || return 2
    case "$option" in
      --request) [ -z "$request" ] || return 2; request="$2" ;;
      --signed-commit) [ -z "$commit" ] || return 2; commit="$2" ;;
      *) return 2 ;;
    esac
    shift 2
  done
  [[ "$request" =~ ^[0-9a-f]{40}$ ]] && [ -n "$commit" ] || return 2
  # Inspect the exact request/response before entry can recover any journal.
  enter_worktree "$pr" false true || return 1
  local helper root prepared target source binding state observation archive
  helper="$(dirname "$(review_artifacts_helper_path)")/baseline-refresh.mjs"
  root=$(repo_root) || return 1
  mark_pr_operation_side_effects_started
  prepared=$(node "$helper" continue-signing "$pr" "$request" "$commit") || return 1
  target=$(printf '%s' "$prepared" | jq -er .target) || return 1
  source=$(printf '%s' "$prepared" | jq -er .source) || return 1
  binding=$(printf '%s' "$prepared" | jq -er .binding) || return 1
  state=$(printf '%s' "$prepared" | jq -er .state) || return 1
  observation=$(cat .local/pr-meta.json) || return 1
  archive=$(printf '%s' "$prepared" | jq -er '.binding | @base64d | fromjson | .archive') || return 1
  revalidate_baseline_publication "$pr" "$observation" "$source" "$archive" || return 1
  require_no_ignored_transition_paths "$pr" "$source" "$target" || return 1
  printf '%s' "$prepared" | node "$helper" check-signing \
    "$pr" "$root" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID" || return 1
  if [ "$state" = source ]; then
    write_review_transition_journal "$pr" "$source" "$target" prep "pr-$pr-prep" "$binding" || return 1
  fi
  recover_review_transition "$pr" || return 1
  echo "Signed baseline candidate $target installed for request $request."
  echo "Fresh exact-candidate correction review and native gate qualification are required."
)

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
  # Review validation leaves this shell in the admitted worktree before side effects.
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
  PUSH_PURPOSE="" PUSH_REVIEW_OID="" PUSH_PENDING_FINDINGS=""
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
      PUSH_PURPOSE)
        [ "$value" = proof ] || { valid=false; break; } ;;
      PUSH_REVIEW_OID)
        [[ "$value" =~ ^[0-9a-f]{40}$ ]] || { valid=false; break; } ;;
      PUSH_PENDING_FINDINGS)
        [[ "$value" =~ ^[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*$ ]] || { valid=false; break; } ;;
      *) valid=false; break ;;
    esac
    case "$seen" in *" $key "*) valid=false; break ;; esac
    printf -v "$key" '%s' "$value"
    seen="$seen$key "
    count=$((count + 1))
  done < "$file"
  if [ "$valid" != true ] ||
    { [ "$count" -ne 5 ] && [ "$count" -ne 8 ]; } ||
    { [ "$count" -eq 5 ] && [ -n "$PUSH_PURPOSE$PUSH_REVIEW_OID$PUSH_PENDING_FINDINGS" ]; } ||
    { [ "$count" -eq 8 ] && { [ "$PUSH_PURPOSE" != proof ] || [ -z "$PUSH_REVIEW_OID$PUSH_PENDING_FINDINGS" ] ||
      [ "$PUSH_PREP_HEAD_SHA" != "$PUSH_LOCAL_PREP_HEAD_SHA" ]; }; } ||
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
  local artifacts="${3:-.local}"
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
  if [ -e "$artifacts/prep.env" ] || [ -L "$artifacts/prep.env" ]; then
    [ -f "$artifacts/prep.env" ] && [ ! -L "$artifacts/prep.env" ] || return 1
    # shellcheck disable=SC1091
    source "$artifacts/prep.env" || return 1
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
  for result in "$artifacts/prepare-push-result.env" "$artifacts/prepare-sync-result.env"; do
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
  if [ "${PREP_PUBLICATION_PURPOSE:-qualified}" = proof ]; then
    [ "$(pr_git branch --show-current)" = "$(resolve_prep_branch_name "$PREP_PUBLICATION_PR")" ] || return 1
    require_proof_publication_hosted_state "$PREP_PUBLICATION_PR" "$PREP_PROOF_HOSTED_HEAD" "$(pr_git rev-parse HEAD)" || return 1
  else
    require_correction_publication_gates "$PREP_PUBLICATION_PR" "$(pr_git rev-parse HEAD)" \
      "$PREP_PUBLICATION_ALLOW_PENDING" || return 1
  fi
  verify_correction_review_snapshot "$PREP_PUBLICATION_PR" "$PREP_PUBLICATION_REVIEW_SNAPSHOT" "${PREP_PUBLICATION_PURPOSE:-qualified}" || return 1
  require_proof_publication_custody
}

advance_correction_publication_authority() {
  local pr="$1" local_head="$2" snapshot="$3"
  [ -n "${PREP_PUBLICATION_REVIEW_SNAPSHOT:-}" ] || return 0
  # Only the verified writer's expected receipt may change during publication.
  # Advance hosted authority after checking the rest of the review stayed fixed.
  verify_correction_review_snapshot "$pr" "$snapshot" "${PREP_PUBLICATION_PURPOSE:-qualified}" || return 1
  resolve_prep_publication_target "$pr" "$local_head" || return 1
  PREP_PUBLICATION_REVIEW_SNAPSHOT="$snapshot"
  require_proof_publication_custody
}

require_proof_publication_custody() (
  [ "${PREP_PUBLICATION_PURPOSE:-qualified}" = proof ] || return 0
  local binding observed_binding observed_source
  local MERGE_OUTCOME_REF="" MERGE_OUTCOME_OID="" MERGE_OUTCOME_RECORD=""
  # Hosted reads yield authority. Recheck live local custody after the last
  # observation and at each effect; never publish under a replacement owner.
  [ "$(pr_git branch --show-current)" = "$(resolve_prep_branch_name "$PREP_PUBLICATION_PR")" ] || return 1
  if has_worktree_merge_output .; then
    echo "Retained merge evidence must be reconciled before proof publication." >&2; return 1
  fi
  merge_outcome_load_local "$PREP_PUBLICATION_PR" || return 1
  [ -z "$MERGE_OUTCOME_OID" ] || {
    echo "A retained merge outcome blocks proof publication; use its reconciliation owner." >&2; return 1;
  }
  binding=$(pr_batch_wrapper_git workflow-inspect "$canonical_repo_root" "$PREP_PUBLICATION_PR") || return 1
  IFS=$'\t' read -r observed_binding observed_source <<< "$binding"
  [ "$observed_binding" = "$PR_WORKFLOW_BINDING_OID" ] &&
    [ "$observed_source" = "$PR_WORKFLOW_SOURCE_REVISION" ] || {
    echo "Workflow binding changed before proof publication." >&2; return 1;
  }
  pr_operation_lock_owner_is_current "$canonical_repo_root" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID" || {
    echo "Operation custody changed before proof publication." >&2; return 1;
  }
)

require_proof_publication_hosted_state() (
  local pr="$1" expected="$2" candidate="$3" response observed
  # The existing GraphQL observation reports queue and auto-merge state directly;
  # its qualified REST fallback remains owned by the same reader.
  local MERGE_TRANSPORT=graphql MERGE_PRIOR_CI_REST_OBSERVATION=false MERGE_USE_PRIOR_CI_ADMIN=false
  local MERGE_ADMISSION_ACTIVE=false MERGE_OUTCOME_REF="" MERGE_OUTCOME_OID="" MERGE_OUTCOME_RECORD=""
  local MERGE_REPO="" MERGE_REPO_URL="" MERGE_REPO_HOST="" MERGE_REPO_NAME="" MERGE_ENTRY_OBSERVATION=""
  if has_worktree_merge_output .; then
    echo "Retained merge evidence must be reconciled before proof publication." >&2; return 1
  fi
  merge_outcome_init "$pr" || return 1
  [ -z "$MERGE_OUTCOME_OID" ] || {
    echo "A retained merge outcome blocks proof publication; use its reconciliation owner." >&2; return 1;
  }
  response=$(merge_read observe "$pr") || return 1
  # Check presence before the canonical projection: omitted GraphQL fields are
  # unknown, not an attestation that an automatic landing request is absent.
  printf '%s\n' "$response" | jq -e '.payload.data.repository.pullRequest |
    has("autoMergeRequest") and has("isInMergeQueue")' >/dev/null || return 1
  observed=$(merge_outcome_normalize "$response" "$pr") || return 1
  printf '%s\n' "$observed" | jq -e --arg expected "$expected" --arg candidate "$candidate" '
    .pr | .state == "OPEN" and .baseRefName == "main" and
    (.headRefOid == $expected or .headRefOid == $candidate) and
    .autoMergeRequest == null and .isInMergeQueue == false' >/dev/null || {
    echo "Proof publication requires the exact open head with no auto-merge or queue request." >&2; return 1;
  }
)

prepare_publish_for_proof() {
  local pr="$1" proof head lease observation publication_baseline
  local PREP_PUBLICATION_PURPOSE=proof PREP_PUBLICATION_PR="$pr" PREP_PUBLICATION_REVIEW_SNAPSHOT=""
  local PREP_PROOF_HOSTED_HEAD="" PREP_PROOF_REVIEW_OID="" PREP_PROOF_PENDING_FINDINGS=""
  enter_worktree "$pr" false true || return 1
  require_artifact .local/prep-context.env || return 1
  require_artifact .local/pr-meta.env || return 1
  if [ -f .local/gates.env ] && grep -q '^PENDING_CRABBOX_' .local/gates.env; then
    echo "Pending proof execution requires its existing reconciliation owner." >&2; return 1
  fi
  source .local/pr-meta.env || return 1
  source .local/prep-context.env || return 1
  [ "$(pr_git branch --show-current)" = "$(resolve_prep_branch_name "$pr")" ] || return 1
  proof=$(require_proof_publication_review "$pr") || return 1
  head=$(pr_git rev-parse HEAD) || return 1
  PREP_PROOF_HOSTED_HEAD=$(printf '%s\n' "$proof" | jq -er .expectedHostedHead) || return 1
  PREP_PROOF_REVIEW_OID=$(pr_git hash-object --no-filters .local/correction-review.json) || return 1
  PREP_PROOF_PENDING_FINDINGS=$(printf '%s\n' "$proof" | jq -er '[.pendingFindings[].id] | sort | join(",")') || return 1
  # Exact commit identity is the artifact producer's input. Neither an unsigned
  # override nor GitHub's same-tree GraphQL alias can satisfy this purpose.
  case "${OPENCLAW_PR_PUSH_MODE:-auto}" in auto|git) ;; *) echo "Proof publication requires exact Git transport." >&2; return 1 ;; esac
  [ "${OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH:-}" != 1 ] || { echo "Unsigned publication is unavailable for proof." >&2; return 1; }
  pr_git verify-commit "$head" >/dev/null 2>&1 || return 1
  # Reconciliation may advance the transport lease to HEAD. Keep signature
  # admission anchored to the review's original lease, including on a no-op.
  publication_baseline=$(require_proof_publication_review "$pr" proof-publication-baseline) || return 1
  verify_prep_commit_range_signed "$PREP_PROOF_HOSTED_HEAD" "$head" "$publication_baseline" || {
    echo "Proof publication requires a signed correction range from the reviewed hosted head." >&2; return 1;
  }
  resolve_prep_publication_target "$pr" "$head" || return 1
  lease="$PREP_PUBLICATION_LEASE_SHA"
  [ "$PREP_PUBLICATION_HEAD_SHA" = "$head" ] &&
    { [ "$lease" = "$PREP_PROOF_HOSTED_HEAD" ] || [ "$lease" = "$head" ]; } || {
    echo "Proof publication cannot substitute a hosted alias or different lease." >&2; return 1;
  }
  PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot "$pr" proof) || return 1
  observation=$(cat .local/pr-meta.json) || return 1
  verify_correction_publication_authority || return 1
  mark_pr_operation_side_effects_started || return 1
  push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$head" "$lease" .local/prepare-push-result.env "$observation" || return $?
  printf 'Published exact candidate %s for pending proof: %s\n' "$head" "$PREP_PROOF_PENDING_FINDINGS"
  echo "Publication only: NEEDS WORK and unresolved findings remain; fresh proof, READY review and ordinary gates are still required."
}

prepare_push() {
  local pr="$1"
  local observation="${2:-}" resume_run="${3:-}"
  local PREP_PUBLICATION_REVIEW_SNAPSHOT="" PREP_PUBLICATION_PR="$pr" PREP_PUBLICATION_ALLOW_PENDING=true PREP_PUBLICATION_PURPOSE=qualified
  PR_MAIN_SHA=""
  enter_worktree "$pr" false true || return 1
  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env
  if [ -n "$resume_run" ]; then
    resume_prepare_crabbox_gate "$pr" "$resume_run"
    return $?
  fi
  # Inspect retained intent before any main refresh, recovery or checkout.
  # grep, not rg: test harnesses run this guard on GitHub-hosted runners without ripgrep.
  if [ -f .local/gates.env ] && grep -q '^PENDING_CRABBOX_' .local/gates.env; then
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

  if [ -n "$PREP_PUBLICATION_REVIEW_SNAPSHOT" ]; then
    source .local/gates.env || return 1
    if [ "${GATES_MODE:-}" = github_pending ]; then
      # Sync uses the same verified local/hosted receipt as prepare-push.
      write_gates_env_stamp "$pr" "${DOCS_ONLY:-false}" "${CHANGELOG_REQUIRED:-false}" \
        github_pending "" "" "$prep_head_sha" "" "" "" "" || return 1
    fi
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
