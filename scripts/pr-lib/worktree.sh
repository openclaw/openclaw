# shellcheck source=scripts/pr-lib/github.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)/github.sh" || return 1

# shellcheck source=scripts/pr-lib/host-tools.sh
source "${BASH_SOURCE[0]%/*}/host-tools.sh" || return 1

# Shell-local operation state, never inherited freshness from the environment.
unset PR_MAIN_SHA
PR_MAIN_SHA=""

repo_root() {
  # The entrypoint freezes this identity before a linked wrapper can delete
  # its source directory. Post-removal checks must use the same owner.
  if [ -n "${canonical_repo_root:-}" ]; then
    printf '%s\n' "$canonical_repo_root"
    return
  fi
  # Resolve canonical repository root from git common-dir so wrappers work
  # the same from main checkout or any linked worktree.
  local base_dir
  local common_git_dir
  base_dir="${script_parent_dir:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

  if common_git_dir=$(pr_git -C "$base_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    (cd "$(dirname "$common_git_dir")" && pwd)
    return
  fi

  # Fallback for environments where git common-dir is unavailable.
  (cd "$base_dir/.." && pwd)
}

ensure_gh_api_auth() {
  # Retain GraphQL here: a relay's REST /user may identify its caller instead of
  # the mutation writer. REST is not an equivalent authentication preflight.
  local response exit_code=0
  response=$(pr_gh_plain api graphql -f 'query=query { viewer { login } }' --include 2>&1) || exit_code=$?
  if [ "$exit_code" -eq 75 ] || [ "$exit_code" -eq 77 ]; then
    printf '%s\n' "$response" >&2
    return 1
  fi
  printf '%s' "$response" | node "$(dirname "${BASH_SOURCE[0]}")/gh-api-preflight.mjs" "$exit_code"
}

ensure_full_pr_worktree_checkout() {
  local sparse_checkout
  # An unset key (exit 1) is normal; other Git failures must not skip materialization.
  sparse_checkout=$(pr_git config --bool core.sparseCheckout 2>/dev/null) || [ "$?" -eq 1 ] || return 1
  if [ "$sparse_checkout" = "true" ]; then
    # Prepare gates build the whole repository. Inherited sparse settings can
    # omit tracked transitive inputs and turn healthy PRs into false failures.
    pr_git sparse-checkout disable
  fi
}

refuse_review_transition() {
  local pr="$1"
  local reason="$2"
  echo "Refusing scripts/pr transition for PR #$pr: $reason" >&2
  pr_git status --short >&2
  return 1
}

# Foreground pipelines join Git readers and propagate failures through pipefail;
# process substitutions can outlive a successful guard and discard reader failures.
require_no_foreign_untracked() {
  local pr="$1"
  local file
  pr_git ls-files --others --exclude-standard -z |
    while IFS= read -r -d '' file; do
      case "$file" in .local|.local/*) continue ;; esac
      refuse_review_transition "$pr" "untracked files are not owned by scripts/pr."
      return 1
    done
}

require_no_ignored_transition_paths() {
  local pr="$1"
  local source="$2"
  local target="$3"
  local file
  # Keep ls-files' literal subtree matching: check-ignore on a directory misses
  # ignored descendants that restore would delete. Bound argv; skip empty diffs.
  pr_git diff --name-only --no-renames -z "$source" "$target" |
    while IFS= read -r -d '' file; do
      case "$file" in
        .local|.local/*)
          refuse_review_transition "$pr" "the journaled transition touches the reserved .local artifact namespace."
          return 1
          ;;
      esac
      printf ':(literal)%s\0' "$file"
      # A file or symlink ancestor would also be replaced; ordinary directories
      # may contain unrelated ignored data and must not widen the query.
      while [[ "$file" == */* ]]; do
        file=${file%/*}
        if [ -L "$file" ] || { [ -e "$file" ] && [ ! -d "$file" ]; }; then
          printf ':(literal)%s\0' "$file"
        fi
      done
    done |
    xargs -0 -r -s 32768 "${OPENCLAW_PR_GIT:-${GIT_EXEC:-git}}" ls-files --others --ignored --exclude-standard -z -- |
    while IFS= read -r -d '' file; do
      refuse_review_transition "$pr" "ignored file '$file' would be overwritten by the journaled transition."
      return 1
    done
}

validate_review_transition_state() {
  local pr="$1"
  local source="$2"
  local target="$3"
  local current
  current=$(pr_git rev-parse HEAD)
  if { [ "$current" != "$source" ] && [ "$current" != "$target" ]; } ||
    [ -n "$(pr_git ls-files -u)" ]
  then
    refuse_review_transition "$pr" "the journaled transition state is ambiguous."
    return 1
  fi
  require_no_ignored_transition_paths "$pr" "$source" "$target" || return 1

  node "$(dirname "${BASH_SOURCE[0]}")/review-transition-state.mjs" "$source" "$target" || {
    refuse_review_transition "$pr" "the index or working tree contains unowned transition state."
    return 1
  }
}

write_review_transition_journal() {
  local pr="$1"
  local source="$2"
  local target="$3"
  local mode="$4"
  local branch="$5"
  mkdir -p .local
  local journal=.local/review-transition.json
  local pending
  pending=$(mktemp "$journal.XXXXXX") || return 1
  if jq -cn --argjson pr "$pr" --arg source "$source" --arg target "$target" \
    --arg mode "$mode" --arg branch "$branch" \
    '{version:1,pr:$pr,source:$source,target:$target,mode:$mode,branch:(if $mode == "branch" then $branch else null end)}' \
    >"$pending" && mv "$pending" "$journal"
  then
    return 0
  fi
  rm -f "$pending"
  return 1
}

recover_review_transition() {
  local pr="$1"
  local journal=.local/review-transition.json
  [ -e "$journal" ] || return 0

  local fields source target mode branch
  fields=$(jq -er --argjson pr "$pr" '
    select(type == "object" and (keys | sort) == ["branch","mode","pr","source","target","version"])
    | select(.version == 1 and .pr == $pr)
    | select((.source | type == "string" and test("^[0-9a-f]{40}$")) and (.target | type == "string" and test("^[0-9a-f]{40}$")))
    | select((.mode == "detached" and .branch == null) or (.mode == "branch" and (.branch | type == "string")))
    | [.source,.target,.mode,(.branch // "")] | @tsv
  ' "$journal" 2>/dev/null) || {
    refuse_review_transition "$pr" "the transition journal is invalid."
    return 1
  }
  IFS=$'\t' read -r source target mode branch <<<"$fields"
  if ! GIT_NO_LAZY_FETCH=1 pr_git cat-file -e "$source^{commit}" 2>/dev/null ||
    ! GIT_NO_LAZY_FETCH=1 pr_git cat-file -e "$target^{commit}" 2>/dev/null ||
    { [ "$mode" = "branch" ] && [ "$branch" != "temp/pr-$pr" ]; }
  then
    refuse_review_transition "$pr" "the transition journal names an invalid endpoint or branch."
    return 1
  fi

  validate_review_transition_state "$pr" "$source" "$target" || return 1
  # Restore can write files before committing its index. Rebuild the validated
  # source index so replay also owns source-only files left after index deletion.
  pr_git read-tree "$source" || return 1
  if ! pr_git diff --quiet "$source" "$target"; then
    pr_git diff --name-only --no-renames -z "$source" "$target" |
      pr_git --literal-pathspecs restore --source="$target" --staged --worktree \
        --pathspec-from-file=- --pathspec-file-nul || return 1
  fi
  if [ "$(pr_git write-tree)" != "$(pr_git rev-parse "$target^{tree}")" ] || ! pr_git diff --quiet; then
    refuse_review_transition "$pr" "the tracked tree did not reach the journaled target."
    return 1
  fi
  if [ "$mode" = "branch" ]; then
    pr_git checkout -B "$branch" "$target" || return 1
  else
    pr_git checkout --detach "$target" || return 1
  fi

  local actual_branch
  actual_branch=$(pr_git branch --show-current)
  if [ "$(pr_git rev-parse HEAD)" != "$target" ] || ! pr_git diff --quiet || ! pr_git diff --cached --quiet ||
    { [ "$mode" = "branch" ] && [ "$actual_branch" != "$branch" ]; } ||
    { [ "$mode" = "detached" ] && [ -n "$actual_branch" ]; } ||
    ! require_no_foreign_untracked "$pr"
  then
    refuse_review_transition "$pr" "the journaled transition did not complete cleanly."
    return 1
  fi
  rm -f "$journal"
}

checkout_pr_worktree_target() {
  local pr="$1"
  local target_ref="$2"
  local branch="${3:-}"
  recover_review_transition "$pr" || return 1
  if [ -n "$(pr_git ls-files -u)" ] || ! pr_git diff --quiet || ! pr_git diff --cached --quiet ||
    ! require_no_foreign_untracked "$pr"
  then
    refuse_review_transition "$pr" "foreign state blocks a new transition."
    return 1
  fi

  local source target mode=detached
  source=$(pr_git rev-parse HEAD) || return 1
  target=$(pr_git rev-parse "$target_ref^{commit}") || return 1
  require_no_ignored_transition_paths "$pr" "$source" "$target" || return 1
  [ -z "$branch" ] || mode=branch
  write_review_transition_journal "$pr" "$source" "$target" "$mode" "$branch" || return 1
  recover_review_transition "$pr"
}

fetch_canonical_ref() {
  local refspec="$1" root source git_dir promisor filter=""
  shift
  root=$(repo_root) || return 1
  source=$(pr_git -C "$root" remote get-url origin) || return 1
  git_dir=$(pr_git rev-parse --absolute-git-dir) || return 1
  # Resolve relative URLs at the canonical root; ignore worktree origin/refmaps.
  # Other PRs and ordinary fetches own shared refs and the root FETCH_HEAD.
  # Automatic maintenance can prune unrelated worktree metadata, even on fetch.
  set -- fetch --no-auto-maintenance --no-tags --refmap= "$@" "$source" "$refspec"
  promisor=$(pr_git -C "$root" config --bool remote.origin.promisor) || [ "$?" -eq 1 ] || return 1
  if [ "$promisor" = true ]; then
    filter=$(pr_git -C "$root" config --get remote.origin.partialclonefilter) || [ "$?" -eq 1 ] || return 1
    if [ -n "$filter" ]; then
      # Literal URLs lose origin's filter; --filter would persist a new remote.
      # Project the canonical promisor settings only for this fetch.
      set -- "--config-env=remote.$source.promisor=PR_CANONICAL_FETCH_PROMISOR" \
        "--config-env=remote.$source.partialclonefilter=PR_CANONICAL_FETCH_FILTER" "$@"
    fi
  fi
  PR_CANONICAL_FETCH_PROMISOR="$promisor" PR_CANONICAL_FETCH_FILTER="$filter" \
    pr_git -C "$root" --git-dir="$git_dir" "$@"
}

fetch_canonical_main() {
  if [ -n "${1:-}" ]; then
    fetch_canonical_ref "+refs/heads/main:$1" --no-write-fetch-head
  else
    fetch_canonical_ref refs/heads/main
  fi
}

fetch_pr_head() {
  local pr="$1" expected_sha="$2" destination="${3:-}"
  if ! [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "PR head acquisition requires a full lowercase commit SHA for #$pr." >&2
    return 1
  fi
  case "$destination" in
    ""|"refs/heads/pr-$pr"|"refs/heads/pr-$pr-verify") ;;
    *) echo "Invalid PR head acquisition destination for #$pr: $destination" >&2; return 1 ;;
  esac

  local fields=headRefName,headRefOid,headRepository,headRepositoryOwner
  local before after observed_sha before_identity after_identity refspec fetched_sha
  before=$(read_pr_view_json "$pr" "$fields") || return 1
  observed_sha=$(pr_view_string_field "$before" headRefOid "$pr") || return 1
  pr_view_string_field "$before" headRefName "$pr" >/dev/null || return 1
  if [ "$observed_sha" != "$expected_sha" ]; then
    echo "PR head changed before acquisition (expected $expected_sha, live $observed_sha). Re-run review-init." >&2
    return 1
  fi
  before_identity=$(printf '%s\n' "$before" | jq -cS '{headRefName,headRefOid,headRepository,headRepositoryOwner}') || return 1
  refspec="$expected_sha"
  [ -z "$destination" ] || refspec="+$expected_sha:$destination"
  # GitHub's pull/head projection can lag live PR metadata and the branch.
  # Fetch immutable source bytes without overwriting the operation's main checkpoint.
  fetch_canonical_ref "$refspec" --no-write-fetch-head || return 1
  fetched_sha=$(GIT_NO_LAZY_FETCH=1 pr_git rev-parse --verify "${destination:-$expected_sha}^{commit}") || return 1
  if [ "$fetched_sha" != "$expected_sha" ]; then
    echo "PR head changed while fetching it (expected $expected_sha, fetched $fetched_sha)." >&2
    return 1
  fi
  after=$(read_pr_view_json "$pr" "$fields") || return 1
  after_identity=$(printf '%s\n' "$after" | jq -cS '{headRefName,headRefOid,headRepository,headRepositoryOwner}') || return 1
  if [ "$after_identity" != "$before_identity" ]; then
    echo "PR head changed during acquisition for #$pr. Re-run review-init." >&2
    return 1
  fi
}

refresh_main_snapshot() {
  # The PR lock owns this worktree's FETCH_HEAD, not the shared origin/main ref.
  # Capture immediately; PR-head acquisition leaves this checkpoint unchanged.
  PR_MAIN_SHA=""
  local sha
  fetch_canonical_main || return 1
  sha=$(pr_git rev-parse --verify 'FETCH_HEAD^{commit}') || return 1
  PR_MAIN_SHA="$sha"
}

provision_pr_worktree() {
  local root="$1" pr="$2" seed_sha="$3" provisioner_dir
  provisioner_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P) || return 1
  # Runtime code and workspace aliases follow the wrapper's selected trust anchor.
  # Pass current shell lock facts; the adapter consumes the owner's live predicate.
  (
    # The trusted wrapper pins installed packages; caller module-dir overrides
    # must not redirect this source loader or reconcile its dependency links.
    unset PNPM_CONFIG_MODULES_DIR pnpm_config_modules_dir npm_config_modules_dir
    TSX_TSCONFIG_PATH="$provisioner_dir/../../tsconfig.json" \
      node --import "$provisioner_dir/../tsx.mjs" "$provisioner_dir/worktree-provision.mts" \
        "$root" "$pr" "$seed_sha" "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID"
  ) || return 1
}

enter_worktree() {
  # OR-list callers disable errexit throughout this function; guard required steps explicitly.
  local pr="$1"
  local reset_to_main="${2:-false}"
  local invoke_cwd
  invoke_cwd="$PWD"
  local root
  root=$(repo_root) || return 1

  if [ "$invoke_cwd" != "$root" ]; then
    echo "Detected non-root invocation cwd=$invoke_cwd, using canonical root $root"
  fi

  cd "$root" || return 1
  ensure_gh_api_auth || { PR_MAIN_SHA=""; return 1; }
  # Fetch can launch helpers and mutate Git state even when it fails; leave validation first.
  mark_pr_operation_side_effects_started || return 1

  local dir="$root/.worktrees/pr-$pr"
  local resolved_parent resolved_dir state registration initialized_sha=""
  state=$(pr_worktree_state "$dir" "" entry) || return $?
  resolved_dir=$(printf '%s\n' "$state" | jq -r '.path') || return $?
  registration=$(worktree_registration_state "$resolved_dir") || return $?

  if [ "$registration" != registered ] ||
    ! printf '%s\n' "$state" | jq -e '.present' >/dev/null; then
    if [ "$registration" = registered ] ||
      printf '%s\n' "$state" | jq -e '.present or .admin != ""' >/dev/null; then
      echo "Removing exact stale PR worktree .worktrees/pr-$pr"
    fi
    remove_worktree_if_present "$dir" || return $?
    # Cold bootstrap needs one extra fetch before private FETCH_HEAD exists.
    # Initialize fully before the next network wait so interruption is retryable.
    # The PR lock owns this existing temp branch, not shared origin/main or FETCH_HEAD.
    PR_MAIN_SHA=""
    fetch_canonical_main "refs/heads/temp/pr-$pr" || return 1
    local seed_sha
    seed_sha=$(GIT_NO_LAZY_FETCH=1 pr_git -C "$root" rev-parse --verify "refs/heads/temp/pr-$pr^{commit}") || return 1
    provision_pr_worktree "$root" "$pr" "$seed_sha" || return 1
    resolved_parent=$(resolve_existing_dir_path "$(dirname "$dir")") || return 1
    resolved_dir="$resolved_parent/pr-$pr"
    initialized_sha=$(pr_git -C "$dir" rev-parse --verify HEAD) || return 1
    state=$(pr_worktree_state "$dir" "" entry) || return $?
    registration=$(worktree_registration_state "$resolved_dir") || return $?
    [ "$registration" = registered ] || return 1
  fi

  cd "$resolved_dir" || return 1

  # Containment, not repair: every mutation below runs against ambient cwd, so
  # prove Git resolves it to this worktree before any branch moves. A directory
  # that is not a worktree lets discovery escape up into the shared canonical
  # checkout, where a sibling session's branch would be clobbered.
  local actual_toplevel actual_identity expected_identity
  actual_toplevel=$(resolve_existing_dir_path "$(pr_git rev-parse --path-format=absolute --show-toplevel 2>/dev/null)" 2>/dev/null || true)
  actual_identity=$(pr_git rev-parse --path-format=absolute --git-dir --git-common-dir) || return $?
  expected_identity=$(printf '%s\n' "$state" | jq -r '.admin, .common') || return $?
  if [ "$actual_toplevel" != "$resolved_dir" ] || [ "$actual_identity" != "$expected_identity" ]; then
    echo "Refusing scripts/pr operation for PR #$pr: expected worktree $resolved_dir, Git resolved ${actual_toplevel:-no repository}; scripts/pr refuses to mutate the shared canonical checkout." >&2
    return 1
  fi

  [ -n "$PR_MAIN_SHA" ] || refresh_main_snapshot || return 1
  recover_review_transition "$pr" || return 1
  ensure_full_pr_worktree_checkout || return 1
  # Explicit resets still validate foreign state, even when the seed matches.
  # Otherwise a new temp branch needs a transition only if main moved.
  if [ "$reset_to_main" = true ] ||
    { [ -n "$initialized_sha" ] && [ "$initialized_sha" != "$PR_MAIN_SHA" ]; }; then
    checkout_pr_worktree_target "$pr" "$PR_MAIN_SHA" "temp/pr-$pr" || return 1
  fi
  mkdir -p .local
}

pr_meta_json() {
  local pr="$1"
  local metadata files expected_file_count actual_file_count head_before head_after head_after_json
  local repo_json repo_nwo repo_url identity_filter identity_before identity_after
  repo_json=$(pr_gh_plain repo view --json nameWithOwner,url) || return 1
  if ! repo_nwo=$(printf '%s\n' "$repo_json" | jq -er '.nameWithOwner | select(type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))') ||
    ! repo_url=$(printf '%s\n' "$repo_json" | jq -er --arg repo "$repo_nwo" '.url | select(type == "string" and test("^https://[A-Za-z0-9.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") and endswith("/" + $repo))'); then
    echo "Invalid base repository identity for PR #$pr." >&2
    return 1
  fi
  # Pin the base repository, not the fork's headRepository. Keep the exact
  # observed base/head pair; neither a local main ref nor a newer snapshot is a substitute.
  identity_filter='
    select(.number == $pr and .url == ($repo_url + "/pull/" + ($pr | tostring)))
    | select(all(.baseRefOid, .headRefOid; type == "string" and test("^[0-9a-f]{40}$")))
    | select(all(.baseRefName, .headRefName; type == "string" and length > 0))
    | {number,url,baseRefOid,headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner}'
  metadata=$(GH_REPO="$repo_nwo" read_pr_view_json "$pr" "number,title,state,isDraft,author,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,url,body,labels,assignees,changedFiles,additions,deletions,statusCheckRollup,files") || return 1
  head_before=$(pr_view_string_field "$metadata" "headRefOid" "$pr" "Retry review initialization.") || return 1
  if ! identity_before=$(printf '%s\n' "$metadata" | jq -ceS --argjson pr "$pr" --arg repo_url "$repo_url" "$identity_filter"); then
    echo "Invalid PR identity for #$pr: expected $repo_url/pull/$pr and complete base/head OIDs and refs." >&2
    return 1
  fi
  if ! expected_file_count=$(printf '%s\n' "$metadata" | jq -er '.changedFiles | if type == "number" and . >= 0 and . == floor then . else error("invalid changed file count") end' 2>/dev/null); then
    echo "Invalid PR metadata for #$pr: changedFiles must be a non-negative integer." >&2
    return 1
  fi

  # The REST adapter collects all file pages; unavailable data is never an empty diff.
  if ! printf '%s\n' "$metadata" | jq -e '
    def count: type == "number" and . >= 0 and . == floor;
    .changedFiles as $count | .files
    | type == "array" and length <= $count
      and all(.[]; (.path | type == "string" and length > 0)
        and (.additions | count) and (.deletions | count))
      and (map(.path) | length == (unique | length))
  ' >/dev/null 2>&1; then
    echo "Invalid PR file metadata for #$pr: files must be an explicit array of unique valid entries consistent with changedFiles; null or missing files are unavailable." >&2
    return 1
  fi
  files=$(printf '%s\n' "$metadata" | jq -c '.files') || return 1

  head_after_json=$(GH_REPO="$repo_nwo" read_pr_view_json "$pr" "number,url,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner") || return 1
  head_after=$(pr_view_string_field "$head_after_json" "headRefOid" "$pr" "Retry review initialization.") || return 1
  if [ "$head_after" != "$head_before" ]; then
    echo "PR head changed while collecting file metadata for #$pr (started at $head_before, ended at $head_after). Retry review initialization." >&2
    return 1
  fi
  if ! identity_after=$(printf '%s\n' "$head_after_json" | jq -ceS --argjson pr "$pr" --arg repo_url "$repo_url" "$identity_filter") ||
    [ "$identity_after" != "$identity_before" ]; then
    echo "PR base/head or repository identity changed or became unavailable while collecting file metadata for #$pr. Retry review initialization." >&2
    return 1
  fi

  if ! actual_file_count=$(
    printf '%s\n' "$files" | jq -er '
      def count: type == "number" and . >= 0 and . == floor;
      if type == "array" and all(.[];
          (.path | type == "string" and length > 0)
          and (.additions | count) and (.deletions | count)
          and (.changeType | type == "string" and length > 0))
        and (map(.path) | length == (unique | length))
      then length else error("invalid or duplicate file entries") end'
  ); then
    echo "Invalid paginated PR file metadata for #$pr: expected unique valid file entries." >&2
    return 1
  fi
  if [ "$actual_file_count" -ne "$expected_file_count" ]; then
    echo "Incomplete PR file metadata for #$pr: expected $expected_file_count changed files, received $actual_file_count from paginated REST." >&2
    return 1
  fi

  printf '%s\n%s\n' "$metadata" "$files" | jq -cs '.[0] + {files: .[1]}'
}

write_pr_meta_files() {
  local json="$1"

  printf '%s\n' "$json" > .local/pr-meta.json

  # Security: shell-escape all values with printf %q to prevent command injection
  # via malicious branch names containing $() or backticks. See GHSA-xxxx-xxxx-xxxx.
  local pr_number pr_url pr_author pr_base pr_head pr_head_sha
  local pr_head_repo pr_head_repo_url pr_head_owner pr_head_repo_name
  pr_number=$(printf '%s\n' "$json" | jq -r .number)
  pr_url=$(printf '%s\n' "$json" | jq -r .url)
  pr_author=$(printf '%s\n' "$json" | jq -r .author.login)
  pr_base=$(printf '%s\n' "$json" | jq -r .baseRefName)
  pr_head=$(printf '%s\n' "$json" | jq -r .headRefName)
  pr_head_sha=$(printf '%s\n' "$json" | jq -r .headRefOid)
  pr_head_repo=$(printf '%s\n' "$json" | jq -r .headRepository.nameWithOwner)
  pr_head_repo_url=$(printf '%s\n' "$json" | jq -r '.headRepository.url // ""')
  pr_head_owner=$(printf '%s\n' "$json" | jq -r '.headRepositoryOwner.login // ""')
  pr_head_repo_name=$(printf '%s\n' "$json" | jq -r '.headRepository.name // ""')

  printf '%s=%q\n' \
    PR_NUMBER "$pr_number" \
    PR_URL "$pr_url" \
    PR_AUTHOR "$pr_author" \
    PR_BASE "$pr_base" \
    PR_HEAD "$pr_head" \
    PR_HEAD_SHA "$pr_head_sha" \
    PR_HEAD_REPO "$pr_head_repo" \
    PR_HEAD_REPO_URL "$pr_head_repo_url" \
    PR_HEAD_OWNER "$pr_head_owner" \
    PR_HEAD_REPO_NAME "$pr_head_repo_name" \
    > .local/pr-meta.env
}

list_pr_worktrees() {
  local root
  root=$(repo_root)
  cd "$root"

  local dir
  local found=false
  for dir in .worktrees/pr-*; do
    [ -d "$dir" ] || continue
    found=true
    local pr
    if ! pr=$(pr_number_from_worktree_dir "$dir"); then
      printf 'UNKNOWN\t%s\tUNKNOWN\t(unparseable)\t\n' "$dir"
      continue
    fi
    local info
    info=$(pr_gh pr view "$pr" --json state,title,url --jq '[.state, .title, .url] | @tsv') || {
      [ "$?" -ne 75 ] || return 1
      info=$'UNKNOWN\t(unavailable)\t'
    }
    printf '%s\t%s\t%s\n' "$pr" "$dir" "$info"
  done

  if [ "$found" = "false" ]; then
    echo "No PR worktrees found."
  fi
}

gc_pr_worktrees() {
  local dry_run="${1:-false}"
  local root
  root=$(repo_root)
  cd "$root"

  local dir
  local removed=0
  for dir in .worktrees/pr-*; do
    [ -d "$dir" ] || continue
    local pr
    if ! pr=$(pr_number_from_worktree_dir "$dir"); then
      echo "skipping $dir (could not parse PR number)"
      continue
    fi
    local lock_status=0
    try_acquire_pr_operation_lock "$pr" || lock_status=$?
    if [ "$lock_status" -ne 0 ]; then
      if [ "$lock_status" -eq 1 ]; then
        echo "skipping $dir (PR #$pr has an active scripts/pr operation)"
      elif [ -n "$PR_OPERATION_LOCK_BLOCKED_OID" ]; then
        echo "skipping $dir (PR #$pr operation lock is $PR_OPERATION_LOCK_BLOCKED_REASON)"
        print_pr_operation_lock_recovery_guidance "$pr"
      else
        echo "skipping $dir (PR #$pr operation lock state is indeterminate)"
      fi
      continue
    fi
    local state
    state=$(pr_gh pr view "$pr" --json state --jq .state) || {
      [ "$?" -ne 75 ] || { release_pr_operation_lock; return 1; }
      state=UNKNOWN
    }
    case "$state" in
      MERGED|CLOSED)
        if ! require_worktree_cleanup_evidence "$dir"; then
          echo "skipping $dir (merge evidence preserved)"
        elif [ "$dry_run" = "true" ]; then
          if remove_worktree_if_present "$dir" true; then
            echo "would remove $dir (PR #$pr state=$state)"
            removed=$((removed + 1))
          else
            echo "skipping $dir (cleanup incomplete)"
          fi
        elif cleanup_pr_worktree "$dir"; then
          echo "removed $dir (PR #$pr state=$state)"
          removed=$((removed + 1))
        else
          echo "skipping $dir (cleanup incomplete)"
        fi
        ;;
    esac
    release_pr_operation_lock
  done

  if [ "$removed" -eq 0 ]; then
    if [ "$dry_run" = "true" ]; then
      echo "No merged/closed PR worktrees eligible for removal."
    else
      echo "No merged/closed PR worktrees removed."
    fi
  fi
}

pr_number_from_worktree_dir() {
  local dir="$1"
  local basename=${dir##*/}
  local token=${basename#pr-}
  [ "$basename" != "$token" ] || return 1
  is_canonical_pr_number "$token" || return 1
  printf '%s\n' "$token"
}
