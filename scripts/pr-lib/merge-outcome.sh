# shellcheck source=scripts/pr-lib/github.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)/github.sh" || return 1

# The local outcome outlives the process lock and all disposable prepare artifacts.
# These private commits retain the actual head/main/landed objects as parents;
# textual OIDs in a blob alone would not keep historical proof alive through GC.
merge_outcome_stop() {
  echo "Merge outcome: $*" >&2
  local ref_state=unavailable ref_status=0 root capture_state=unavailable captures=true
  if GIT_NO_LAZY_FETCH=1 pr_git symbolic-ref -q "$MERGE_OUTCOME_REF" >/dev/null 2>&1 ||
    GIT_NO_LAZY_FETCH=1 pr_git show-ref --verify --quiet "$MERGE_OUTCOME_REF" 2>/dev/null; then
    ref_state=present
  else
    ref_status=$?
    [ "$ref_status" -ne 1 ] || ref_state=absent
  fi
  if root=$(repo_root) && [ -d "$root" ]; then
    local worktree="$root/.worktrees/pr-${MERGE_OUTCOME_REF##*/}"
    if [ ! -e "$worktree" ] || { [ -r "$worktree/.local" ] && [ -x "$worktree/.local" ]; }; then
      capture_state=absent
      if [ -e "$worktree/.local/merge-output.log" ] || [ -L "$worktree/.local/merge-output.log" ]; then
        capture_state=present
      fi
      if ! has_worktree_merge_output "$worktree"; then captures=false; fi
    fi
  fi
  printf 'Local outcome ref %s: %s\nLegacy .local/merge-output.log: %s\n' \
    "$MERGE_OUTCOME_REF" "$ref_state" "$capture_state" >&2
  if [ "${MERGE_ADMISSION_ACTIVE:-false}" = true ] && [ "$ref_state" = absent ] &&
    [ "$capture_state" = absent ] && [ "$captures" = false ]; then
    echo "Confirmed pre-dispatch abort: no merge request was sent by this attempt. Next: lock-recover, then rerun merge-run (use the exact lock-recover command after verifying no child tools remain)." >&2
  else
    echo 'Next: investigate; see scripts/AGENTS.md merge-outcome doctrine and `scripts/pr merge-recover`. No automatic merge retry.' >&2
  fi
  return 1
}

# This runs only after rejection. REST and local merge-tree output explain the
# failure; neither replaces the pinned observation or grants dispatch authority.
merge_outcome_diagnose() {
  local pr="$1" observed="$2" expected="${3:-null}" status_expected="${4:-}" mergeable_expected="${5:-}"
  local head="${PREP_HEAD_SHA:-}" rest main rest_status=0
  [ -n "$head" ] || head=$(printf '%s\n' "${MERGE_OUTCOME_RECORD:-null}" | jq -r '.head // empty')
  printf '%s\n' "$observed" | jq -r --arg head "$head" --argjson expected "$expected" \
    --argjson recovery "${recovery_record:-null}" --arg status "$status_expected" --arg mergeable "$mergeable_expected" '
    def mismatch($field; $actual; $wanted):
      if $actual != $wanted then "Merge precondition \($field): observed=\($actual|tojson); expected=\($wanted|tojson)" else empty end;
    . as $actual |
    (if $expected == null then {pr:{state:"OPEN",headRefOid:$head,baseRefName:"main",isDraft:false,
      mergeable:(if .pr.mergeable == "CONFLICTING" then "MERGEABLE|UNKNOWN" else .pr.mergeable end),
      autoMergeRequest:null,isInMergeQueue:false}} |
      if $recovery == null then . else .pr.id=$recovery.prId end
     else $expected end |
     if $status == "" then . else .pr.mergeStateStatus=$status end |
     if $mergeable == "" then . else .pr.mergeable=$mergeable end) as $wanted |
    (if $wanted | has("main") then mismatch("main"; $actual.main; $wanted.main) else empty end),
    ($wanted.pr | to_entries[] | mismatch(.key; $actual.pr[.key]; .value))
  ' >&2 || true
  rest=$(pr_gh_plain api --hostname "$MERGE_REPO_HOST" "repos/$MERGE_REPO_NAME/pulls/$pr" \
    --jq '{mergeable,mergeable_state}' 2>&1) || rest_status=$?
  # Preserve bounded quota diagnostics while keeping other raw API errors private.
  if [ "$rest_status" -eq 75 ] || [ "$rest_status" -eq 77 ]; then
    printf '%s\n' "$rest" >&2
  fi
  if [ "$rest_status" -eq 0 ] &&
    printf '%s\n' "$rest" | jq -e 'has("mergeable") and (.mergeable == null or (.mergeable|type) == "boolean") and (.mergeable_state|type) == "string"' >/dev/null 2>&1; then
    printf '%s\n' "$rest" | jq -r --arg pr "$pr" \
      '"REST pulls/\($pr): mergeable=\(.mergeable|tojson); mergeable_state=\(.mergeable_state|tojson) (diagnostic only)"' >&2
  else
    rest=null
    echo "REST pulls/$pr: mergeable/mergeable_state unavailable (diagnostic only)" >&2
  fi
  if printf '%s\n' "$observed" | jq -e --argjson rest "$rest" \
    '.pr.mergeStateStatus == "DIRTY" or .pr.mergeable == "CONFLICTING" or $rest.mergeable_state == "dirty"' >/dev/null; then
    main=$(printf '%s\n' "$observed" | jq -r '.main // empty')
    GIT_NO_LAZY_FETCH=1 node --input-type=module -e '
      import { spawnSync } from "node:child_process";
      const [main, head] = process.argv.slice(1);
      const git = (args) => spawnSync(process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git", args, { encoding: "utf8", timeout: 5000 });
      if ([main, head].every((oid) => /^[0-9a-f]{40}$/.test(oid) && git(["cat-file", "-e", `${oid}^{commit}`]).status === 0)) {
        const result = git(["merge-tree", "--write-tree", "--name-only", "--no-messages", main, head]);
        const paths = result.status === 1 ? result.stdout.trim().split("\n").slice(1).filter(Boolean) : [];
        if (paths.length) {
          for (const path of paths) console.error(`Conflicting path: ${path}`);
          process.exit(0);
        }
      }
      console.error("Conflicts exist; conflicting paths unavailable from the local main/prepared-head comparison.");
    ' -- "$main" "$head" || echo "Conflicts exist; local path diagnostics unavailable." >&2
  fi
  return 0
}

merge_outcome_repo_identity() {
  # Historical outcomes contain node IDs and CLI adapters' numeric database IDs.
  # Remote initialization binds either shape to the authoritative repository.
  jq -ce '
    . as $repo | select((.id | (type == "string" and length > 0) or type == "number") and
      (.nameWithOwner | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
      (.url | test("^https://[A-Za-z0-9.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") and endswith("/" + $repo.nameWithOwner)))
  '
}

merge_outcome_init() {
  local pr="$1" authority identities
  is_canonical_pr_number "$pr" || return 1
  MERGE_OUTCOME_REF="refs/openclaw/pr-merge-outcomes/$pr"
  pr_observe "$pr" || return 1
  MERGE_ENTRY_OBSERVATION="$PR_OBSERVATION"
  authority=$(printf '%s\n' "$MERGE_ENTRY_OBSERVATION" | jq -ce '.baseRepository' |
    merge_outcome_repo_identity) || { merge_outcome_stop "invalid authoritative repository identity"; return 1; }
  MERGE_REPO_URL=$(printf '%s\n' "$authority" | jq -r .url)
  MERGE_REPO_HOST="${MERGE_REPO_URL#https://}"
  MERGE_REPO_HOST="${MERGE_REPO_HOST%%/*}"
  MERGE_REPO_NAME=$(printf '%s\n' "$authority" | jq -r .nameWithOwner)
  identities=$(printf '%s\n' "$authority" | jq -ce '
    select((.id | type == "string" and length > 0) and
      (.databaseId | type == "number" and . > 0 and floor == .)) |
    [{id,nameWithOwner,url},{id:.databaseId,nameWithOwner,url}]
  ') || { merge_outcome_stop "invalid authoritative repository identity"; return 1; }
  merge_outcome_load_local "$pr" || return 1
  if [ -n "$MERGE_OUTCOME_OID" ]; then
    # Keep the historical object unchanged across recovery's exact provenance check.
    MERGE_REPO=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -ce --argjson identities "$identities" '
      .repo | select(. == $identities[0] or . == $identities[1])
    ') || { merge_outcome_stop "retained repository identity does not match authoritative repository"; return 1; }
    MERGE_TRANSPORT=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r '.transport // "graphql"') || return 1
  else
    MERGE_REPO=$(printf '%s\n' "$identities" | jq -c '.[0]') || return 1
  fi
}

# Cleanup validates retained proof locally (Git 2.45+ prevents lazy fetch). Admission also
# supplies the freshly resolved repository identity; local validity is not reconciliation.
merge_outcome_load_local() {
  local pr="$1" expected_repo="${2:-null}"
  is_canonical_pr_number "$pr" || return 1
  MERGE_OUTCOME_REF="refs/openclaw/pr-merge-outcomes/$pr"
  MERGE_OUTCOME_OID=""
  MERGE_OUTCOME_RECORD=""
  if GIT_NO_LAZY_FETCH=1 pr_git symbolic-ref -q "$MERGE_OUTCOME_REF" >/dev/null 2>&1; then
    merge_outcome_stop "symbolic outcome ref; inspect without deleting it"
    return 1
  fi
  local ref_status=0
  if MERGE_OUTCOME_OID=$(GIT_NO_LAZY_FETCH=1 pr_git rev-parse --verify "$MERGE_OUTCOME_REF" 2>/dev/null); then
    local parents retained
    [ "$(GIT_NO_LAZY_FETCH=1 pr_git cat-file -t "$MERGE_OUTCOME_OID")" = commit ] || { merge_outcome_stop "outcome ref is not a commit"; return 1; }
    MERGE_OUTCOME_RECORD=$(GIT_NO_LAZY_FETCH=1 pr_git show "$MERGE_OUTCOME_OID:outcome.json" | jq -ce \
      --argjson repo "$expected_repo" --argjson pr "$pr" '
      def oid: type == "string" and test("^[0-9a-f]{40}$");
      def attempt: type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
      def recovery:
        if has("recovery") then . as $record | .recovery |
          type == "object" and
          (((keys - ["preDispatchRefusal"]) == ["actor","attempt","outcome","reason"]) or
           ((keys - ["preDispatchRefusal"]) == ["actor","attempt","outcome","reason","replacementHead"] and
            (.replacementHead | oid) and .replacementHead == $record.head)) and
          (if has("preDispatchRefusal") then (.preDispatchRefusal | type == "object") else true end) and
          (.outcome | oid) and (.attempt | attempt) and
          (.actor | type == "string" and length > 0) and .reason == "explicit-operator-recovery"
        else true end;
      select(.version == 1 and ($repo == null or .repo == $repo) and .pr == $pr and .base == "main" and
        (.prId | type == "string" and length > 0) and (.head | oid) and (.main | oid) and
        (if has("localHead") then (.localHead | oid) else true end) and
        (.attempt | attempt) and recovery and
        (if has("cancellation") then .accepted == true and .route == "auto" and
          (.cancellation | keys == ["actor","outcome","state"] and (.outcome | oid) and
            (.actor | type == "string" and length > 0) and (.state | IN("requested","confirmed")))
         else true end) and
        (if has("legacyRefusal") then (has("recovery") | not) and (.legacyRefusal |
          keys == ["actor","files","head","kind","preparedBase"] and
          .kind == "gh-2.98-pre-dispatch-refusal" and (.actor | type == "string" and length > 0) and
          (.head | oid) and (.preparedBase | oid) and
          (.files | keys == ["gates.env","merge-output.log","prep.env","prep.md"] and all(.[]; oid)))
         else true end) and
        (.method == "squash" or .method == "merge" or .method == "rebase") and
        (.route == "immediate" or .route == "admin" or .route == "auto" or .route == "queue") and
        (if has("transport") then .transport == "rest" and .method == "squash" and .route == "immediate" else true end) and
        (.accepted | type == "boolean") and
        (if .phase == "intent" then .landed == null else
          (.phase == "merged" or .phase == "commenting" or .phase == "commented" or .phase == "complete") and (.landed | oid) end))
    ') || { merge_outcome_stop "corrupt or mismatched retained record"; return 1; }
    printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c .repo | merge_outcome_repo_identity >/dev/null || {
      merge_outcome_stop "invalid retained repository identity"; return 1;
    }
    parents=$(GIT_NO_LAZY_FETCH=1 pr_git cat-file commit "$MERGE_OUTCOME_OID" | awk 'NF == 0 {exit} $1 == "parent" {printf "%s ", $2}') || return 1
    for retained in $(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r '[.head,.main,.landed,.localHead,.legacyRefusal.head,.legacyRefusal.preparedBase] | .[] | select(. != null)'); do
      case " $parents " in *" $retained "*) ;; *) merge_outcome_stop "record does not retain required commit $retained"; return 1 ;; esac
      GIT_NO_LAZY_FETCH=1 pr_git cat-file -e "$retained^{commit}" || { merge_outcome_stop "required historical commit $retained is unavailable"; return 1; }
    done
    if printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e 'has("legacyRefusal")' >/dev/null; then
      local name expected actual
      while IFS=$'\t' read -r name expected; do
        actual=$(GIT_NO_LAZY_FETCH=1 pr_git rev-parse "$MERGE_OUTCOME_OID:legacy-refusal/$name") || return 1
        [ "$actual" = "$expected" ] && [ "$(GIT_NO_LAZY_FETCH=1 pr_git cat-file -t "$actual")" = blob ] || {
          merge_outcome_stop "legacy refusal bytes are not retained"; return 1;
        }
      done < <(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r '.legacyRefusal.files | to_entries[] | [.key,.value] | @tsv')
    fi
    local local_head head local_tree head_tree
    local_head=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r '.localHead // empty') || return 1
    if [ -n "$local_head" ]; then
      head=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .head) || return 1
      local_tree=$(GIT_NO_LAZY_FETCH=1 pr_git rev-parse "$local_head^{tree}") || return 1
      head_tree=$(GIT_NO_LAZY_FETCH=1 pr_git rev-parse "$head^{tree}") || return 1
      [ "$local_tree" = "$head_tree" ] || { merge_outcome_stop "local and hosted prepared trees differ"; return 1; }
    fi
    if printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e 'has("recovery")' >/dev/null; then
      retained=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .recovery.outcome)
      if ! GIT_NO_LAZY_FETCH=1 pr_git merge-base --is-ancestor "$retained" "$MERGE_OUTCOME_OID" ||
        ! GIT_NO_LAZY_FETCH=1 pr_git show "$retained:outcome.json" | jq -e --argjson next "$MERGE_OUTCOME_RECORD" '
          .phase == "intent" and
          ((.accepted == false and (.route == "immediate" or
             (.route == "auto" and $next.recovery.preDispatchRefusal != null))) or
           (.accepted == true and .route == "auto" and .cancellation.state == "confirmed")) and
          .repo == $next.repo and .pr == $next.pr and .prId == $next.prId and
          .base == $next.base and .method == $next.method and .attempt == $next.recovery.attempt and
          $next.route == "immediate" and (.head == $next.head or $next.recovery.replacementHead == $next.head)
        ' >/dev/null; then
        merge_outcome_stop "invalid or unretained operator recovery provenance"; return 1
      fi
    fi
    if printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e '.recovery.preDispatchRefusal != null' >/dev/null; then
      local qualified_refusal original
      retained=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .recovery.outcome)
      original=$(GIT_NO_LAZY_FETCH=1 pr_git show "$retained:outcome.json") || return 1
      qualified_refusal=$(node "${BASH_SOURCE[0]%/*}/merge-pre-dispatch-refusal.mjs" "git:$MERGE_OUTCOME_OID" "$retained" "$original") || return 1
      [ "$qualified_refusal" = "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.recovery.preDispatchRefusal')" ] || {
        merge_outcome_stop "invalid retained pre-dispatch qualification"; return 1;
      }
    fi
    if printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e 'has("cancellation")' >/dev/null; then
      retained=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .cancellation.outcome)
      if ! GIT_NO_LAZY_FETCH=1 pr_git merge-base --is-ancestor "$retained" "$MERGE_OUTCOME_OID" ||
        ! GIT_NO_LAZY_FETCH=1 pr_git show "$retained:outcome.json" | jq -e --argjson next "$MERGE_OUTCOME_RECORD" '
          .phase == "intent" and .accepted == true and .route == "auto" and (has("cancellation") | not) and
          .repo == $next.repo and .pr == $next.pr and .prId == $next.prId and
          .base == $next.base and .head == $next.head and .main == $next.main and
          .method == $next.method and .attempt == $next.attempt
        ' >/dev/null; then
        merge_outcome_stop "invalid or unretained auto cancellation provenance"; return 1
      fi
    fi
  else
    GIT_NO_LAZY_FETCH=1 pr_git show-ref --verify --quiet "$MERGE_OUTCOME_REF" 2>/dev/null || ref_status=$?
    [ "$ref_status" -eq 1 ] || { merge_outcome_stop "unreadable outcome ref"; return 1; }
  fi
}

merge_outcome_write() {
  local record="$1" blob tree next parent entries capture
  shift
  mark_pr_operation_side_effects_started || return 1
  local parents=()
  for parent in $(printf '%s\n' "$record" | jq -r '[.head,.main,.landed,.localHead,.legacyRefusal.head,.legacyRefusal.preparedBase] | unique | .[] | select(. != null)'); do
    parents+=(-p "$parent")
  done
  [ -z "$MERGE_OUTCOME_OID" ] || parents+=(-p "$MERGE_OUTCOME_OID")
  blob=$(printf '%s\n' "$record" | pr_git hash-object -w --stdin) || return 1
  entries=$(printf '100644 blob %s\toutcome.json\n' "$blob")
  local capture_entries="" legacy_tree
  # Keep imported legacy proof in every successor tree; it is a factual refusal,
  # never a synthetic historical intent. Only the current CAS admits a dispatch.
  for capture in "$@"; do
    [ -f "$capture" ] && [ ! -L "$capture" ] || { merge_outcome_stop "cannot retain non-regular capture $capture"; return 1; }
    blob=$(pr_git hash-object -w --no-filters -- "$capture") || return 1
    if printf '%s\n' "$record" | jq -e 'has("legacyRefusal")' >/dev/null &&
      [ "$blob" != "$(printf '%s\n' "$record" | jq -r --arg name "${capture##*/}" '.legacyRefusal.files[$name]')" ]; then
      merge_outcome_stop "legacy evidence changed before retention"; return 1
    fi
    capture_entries+="$(printf '100644 blob %s\t%s' "$blob" "${capture##*/}")"$'\n'
  done
  if printf '%s\n' "$record" | jq -e 'has("legacyRefusal")' >/dev/null; then
    if [ -n "$MERGE_OUTCOME_OID" ]; then
      legacy_tree=$(GIT_NO_LAZY_FETCH=1 pr_git rev-parse "$MERGE_OUTCOME_OID:legacy-refusal") || return 1
    else
      legacy_tree=$(printf '%s' "$capture_entries" | pr_git mktree) || return 1
    fi
    entries+=$'\n'"$(printf '040000 tree %s\tlegacy-refusal' "$legacy_tree")"
  elif [ -n "$capture_entries" ]; then
    entries+=$'\n'"${capture_entries%$'\n'}"
  fi
  if printf '%s\n' "$record" | jq -e '.recovery.preDispatchRefusal != null' >/dev/null; then
    local refusal_tree refusal_entries="" refusal_name refusal_blob expected_blob
    if [ -n "$MERGE_OUTCOME_OID" ] && GIT_NO_LAZY_FETCH=1 pr_git cat-file -e "$MERGE_OUTCOME_OID:pre-dispatch-refusal" 2>/dev/null; then
      refusal_tree=$(GIT_NO_LAZY_FETCH=1 pr_git rev-parse "$MERGE_OUTCOME_OID:pre-dispatch-refusal") || return 1
    else
      [ -n "${MERGE_REFUSAL_DIRECTORY:-}" ] || { merge_outcome_stop "missing qualified refusal evidence"; return 1; }
      while IFS=$'\t' read -r refusal_name expected_blob; do
        capture="$MERGE_REFUSAL_DIRECTORY/$refusal_name"
        [ -f "$capture" ] && [ ! -L "$capture" ] || return 1
        refusal_blob=$(pr_git hash-object -w --no-filters -- "$capture") || return 1
        [ "$refusal_blob" = "$expected_blob" ] || { merge_outcome_stop "refusal evidence changed before retention"; return 1; }
        refusal_entries+="$(printf '100644 blob %s\t%s' "$refusal_blob" "$refusal_name")"$'\n'
      done < <(printf '%s\n' "$record" | jq -r '.recovery.preDispatchRefusal.files | to_entries[] | [.key,.value] | @tsv')
      refusal_tree=$(printf '%s' "$refusal_entries" | pr_git mktree) || return 1
    fi
    entries+=$'\n'"$(printf '040000 tree %s\tpre-dispatch-refusal' "$refusal_tree")"
  fi
  tree=$(printf '%s\n' "$entries" | pr_git mktree) || return 1
  next=$(printf 'Native PR merge outcome\n' | pr_git -c commit.gpgsign=false commit-tree "$tree" "${parents[@]}") || return 1
  if pr_git symbolic-ref -q "$MERGE_OUTCOME_REF" >/dev/null 2>&1 ||
    ! pr_git update-ref --no-deref "$MERGE_OUTCOME_REF" "$next" "${MERGE_OUTCOME_OID:-$(pr_operation_lock_zero_oid)}"; then
    merge_outcome_stop "outcome owner changed; preserved successor, no dispatch or completion action"
    return 1
  fi
  MERGE_OUTCOME_OID="$next"
  MERGE_OUTCOME_RECORD="$record"
}

merge_rest() {
  local mode="$1" pr="$2" repo="${MERGE_REPO:-}"
  shift 2
  if [ "$mode" = observe ] && [ "${MERGE_ADMISSION_ACTIVE:-false}" = true ] && [ "${MERGE_USE_CRABBOX_ADMIN_BYPASS:-false}" = false ]; then
    mode=observe-admission
  fi
  [ -n "$repo" ] || repo=$(pr_gh_plain repo view --json id,nameWithOwner,url) || return 1
  node "${BASH_SOURCE[0]%/*}/merge-rest.mjs" "$mode" "$repo" "$pr" "$@"
}

merge_outcome_dispatch_squash() (
  set -o pipefail
  local payload
  # Match gh's noninteractive --squash --body-file payload. Omit the headline:
  # GitHub owns the default, including repository settings and the PR suffix.
  payload=$(printf '%s\n%s\n' "$MERGE_OUTCOME_RECORD" "$1" | jq -cse '
    .[1] as $body | .[0] |
    select(.phase == "intent" and .accepted == false and .method == "squash" and
      .route == "immediate" and (.transport // "graphql") == "graphql") |
    {query:"mutation PullRequestMerge($input:MergePullRequestInput!){mergePullRequest(input:$input){clientMutationId}}",
     variables:{input:{pullRequestId:.prId,expectedHeadOid:.head,mergeMethod:"SQUASH",
       commitBody:($body.base64 | @base64d)}}}
  ') || return 1
  printf '%s\n' "$payload" | pr_gh_plain api graphql --hostname "$MERGE_REPO_HOST" --input -
)

merge_read() {
  local mode="$1" pr="$2" repo="${3:-${MERGE_REPO_URL:-}}" first="${MERGE_TRANSPORT:-rest}" second response status query checks_err checks_error
  if [ "$first" = rest ]; then second=graphql; else second=rest; fi
  local transport
  for transport in "$first" "$second"; do
    status=0
    if [ "$transport" = rest ]; then
      response=$(merge_rest "$mode" "$pr") || return 1
      if printf '%s\n' "$response" | jq -e '. == {restUnavailable:true}' >/dev/null 2>&1; then
        continue
      fi
    else
      case "$mode" in
        checks)
          checks_err=$(mktemp) || return 1
          local checks_args=(pr checks "$pr" --required --json name,bucket,state)
          [ -z "$repo" ] || checks_args+=(--repo "$repo")
          response=$(pr_gh_quota_read "${checks_args[@]}" 2>"$checks_err") || status=$?
          checks_error=$(cat "$checks_err")
          rm -f "$checks_err"
          # gh reports an empty required set with exit 1. Normalize only this
          # invocation's exact diagnostic, independently of prior REST output.
          if [ "$status" -eq 1 ]; then
            case "$checks_error" in
              "no required checks reported on the '"*"' branch")
                response='[]'; status=0; checks_error="" ;;
            esac
          fi
          [ -z "$checks_error" ] || printf '%s\n' "$checks_error" >&2
          ;;
        observe)
          query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id databaseId url nameWithOwner ref(qualifiedName:"refs/heads/main"){target{oid}} pullRequest(number:$number){id number url state headRefOid baseRefName isDraft mergeCommit{oid} autoMergeRequest{mergeMethod} isInMergeQueue isMergeQueueEnabled mergeable mergeStateStatus}}}'
          ;;
        preview)
          query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid author{login __typename} isMergeQueueEnabled viewerMergeBodyText(mergeType:SQUASH) viewerMergeHeadlineText(mergeType:SQUASH)}}}'
          ;;
        *) return 2 ;;
      esac
      if [ "$mode" != checks ]; then
        response=$(pr_gh_quota_read api graphql --hostname "$MERGE_REPO_HOST" -H 'Cache-Control: max-age=0' \
          -f owner="${MERGE_REPO_NAME%/*}" -f name="${MERGE_REPO_NAME#*/}" -F number="$pr" \
          -f "query=$query") || return 1
      fi
      [ "$status" -eq 0 ] || [ "$status" -eq 8 ] || return "$status"
      if pr_gh_quota_exhausted "$response"; then continue; fi
    fi
    printf '%s\n' "$response" | jq -c --arg transport "$transport" '{transport:$transport,payload:.}' || return 1
    return "$status"
  done
  echo "Neither GitHub transport can provide $mode evidence; preserve any retained request for reconciliation." >&2
  return 1
}

merge_outcome_read_remote() {
  local response
  response=$(merge_read observe "$1") || return 1
  printf '%s\n' "$response" | jq -ce --argjson repo "$MERGE_REPO" --argjson pr "$1" '
    .transport as $transport | .payload |
    def oid: type == "string" and test("^[0-9a-f]{40}$");
    select(.errors == null) | . as $response | .data.repository |
    # Initialization binds the retained typed ID to the authoritative pair. Recheck
    # that identity along with the exact name and URL on every remote observation.
    select(.url == $repo.url and .nameWithOwner == $repo.nameWithOwner and
      ($repo.id == .id or $repo.id == .databaseId) and (.ref.target.oid | oid)) |
    {main:.ref.target.oid, pr:(.pullRequest |
      {id,number,url,state,headRefOid,baseRefName,isDraft,mergeCommit,autoMergeRequest,
       isInMergeQueue,isMergeQueueEnabled,mergeable,mergeStateStatus})} +
      {transport:$transport} + (if $transport == "rest" then {restPolicy:$response.restPolicy} else {} end) |
    select(.pr.number == $pr and (.pr.id | type == "string" and length > 0) and
      .pr.url == ($repo.url + "/pull/" + ($pr|tostring)) and
      (.pr.headRefOid | oid) and
      (.pr.baseRefName | type == "string" and length > 0) and
      (.pr.isDraft | type == "boolean") and (.pr.isInMergeQueue | type == "boolean") and
      (.pr.isMergeQueueEnabled | type == "boolean") and
      (.pr.mergeable == "MERGEABLE" or .pr.mergeable == "CONFLICTING" or .pr.mergeable == "UNKNOWN") and
      (.pr.mergeStateStatus | type == "string" and length > 0) and (.pr | has("autoMergeRequest")) and
      (.pr.autoMergeRequest == null or (.pr.autoMergeRequest.mergeMethod | IN("SQUASH","MERGE","REBASE"))) and
      (.pr | has("mergeCommit")) and
      (if .pr.state == "MERGED" then (.pr.mergeCommit.oid | oid) else
        (.pr.state == "OPEN" or .pr.state == "CLOSED") and .pr.mergeCommit == null end))
  '
}

merge_outcome_require_main() {
  local oid="$1"
  # Fetch immutable objects only. Do not replace a pinned observation with the
  # moving origin/main tracking ref or FETCH_HEAD.
  if ! GIT_NO_LAZY_FETCH=1 pr_git cat-file -e "$oid^{commit}" 2>/dev/null; then
    pr_git fetch --no-tags --no-write-fetch-head "$MERGE_REPO_URL" "$oid" || { merge_outcome_stop "cannot fetch authoritative main $oid"; return 1; }
  fi
  GIT_NO_LAZY_FETCH=1 pr_git cat-file -e "$oid^{commit}"
}

merge_outcome_observe() {
  MERGE_OBSERVATION=$(merge_outcome_read_remote "$1") || {
    merge_outcome_stop "PR/main metadata: observed=unavailable or invalid; expected=authoritative valid snapshot"; return 1;
  }
  MERGE_TRANSPORT=$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r '.transport') || return 1
  merge_outcome_require_main "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)"
}

merge_outcome_stable() {
  local reread main
  reread=$(merge_outcome_read_remote "$1") || {
    merge_outcome_stop "observation reread: observed=unavailable or invalid; expected=authoritative PR/main metadata"; return 1;
  }
  # Ordinary admission pins the head; GitHub applies it to the current base. Keep
  # the main used for local tree proof and intent while rechecking every PR fact.
  if [ "${MERGE_ADMISSION_ACTIVE:-false}" = true ] && [ "${MERGE_USE_CRABBOX_ADMIN_BYPASS:-false}" = false ]; then
    reread=$(printf '%s\n' "$reread" | jq -c --arg main "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)" '.main=$main') || return 1
  fi
  [ "$reread" = "$MERGE_OBSERVATION" ] && return 0
  # Both APIs bind the same PR/main facts. Compare REST policy evidence whenever
  # both reads support it; GraphQL admission relies on GitHub's policy enforcement.
  if printf '%s\n' "$reread" | jq -e --argjson observed "$MERGE_OBSERVATION" '
    .transport != $observed.transport and
    del(.transport,.restPolicy) == ($observed | del(.transport,.restPolicy))
  ' >/dev/null; then
    MERGE_OBSERVATION="$reread"
    MERGE_TRANSPORT=$(printf '%s\n' "$reread" | jq -r '.transport') || return 1
    return 0
  fi
  # Only finish an already-proven MERGED receipt; this never admits a future merge.
  # Keep both snapshots pinned: later forward work cannot restart historical proof.
  if printf '%s\n' "$reread" | jq -e --argjson observed "$MERGE_OBSERVATION" '
    .pr.state == "MERGED" and .pr == $observed.pr
  ' >/dev/null; then
    main=$(printf '%s\n' "$reread" | jq -r .main)
    merge_outcome_require_main "$main" || return 1
    pr_git merge-base --is-ancestor "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)" "$main" && return 0
  fi
  printf 'Merge stability observation: %s\nMerge stability reread: %s\n' \
    "$MERGE_OBSERVATION" "$reread" >&2
  merge_outcome_diagnose "$1" "$reread" "$MERGE_OBSERVATION"
  merge_outcome_stop "PR or main changed during observation; rerun for read-only reconciliation if intent exists"
}

merge_outcome_reconcile() {
  local pr="$1" head state landed method route parent source_base tree phase
  merge_outcome_observe "$pr" || return 1
  head=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .head)
  if ! printf '%s\n' "$MERGE_OBSERVATION" | jq -e --argjson record "$MERGE_OUTCOME_RECORD" '
    .pr.id == $record.prId and .pr.headRefOid == $record.head and .pr.baseRefName == $record.base
  ' >/dev/null; then
    merge_outcome_stop "PR identity/head/base drift from the retained attempt"; return 1
  fi
  state=$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .pr.state)
  phase=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .phase)
  if [ "$state" != MERGED ]; then
    merge_outcome_stable "$pr" || return 1
    if [ "$phase" = intent ] && [ "$state" = OPEN ] &&
      printf '%s\n' "$MERGE_OBSERVATION" | jq -e '.pr.isInMergeQueue or .pr.autoMergeRequest != null' >/dev/null; then
      echo "AUTO/QUEUE PENDING for PR #$pr; not merged. Retained expected head $head; no re-arm, cancellation, or immediate fallback."
      echo "Run scripts/pr merge-run $pr again to reconcile only; inspect GitHub queue/auto status if it does not complete."
      [ "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .accepted)" = true ] && return 0
    fi
    merge_outcome_stop "prior dispatch unresolved (state=$state, phase=$phase); OPEN, process death, head changes, and elapsed time do not prove non-execution"
    return 1
  fi
  landed=$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .pr.mergeCommit.oid)
  pr_git merge-base --is-ancestor "$landed" "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)" || {
    merge_outcome_stop "reported landed commit is unavailable or not reachable from authoritative main"; return 1;
  }
  method=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .method)
  route=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .route)
  local merge_inputs=()
  if [ "$method" = rebase ] || [ "$route" = queue ]; then
    # A rebase's final parent can be a rewritten prefix; queue policy can rebase
    # regardless of requested method. Anchor the whole source delta at its fork,
    # not recorded main (which may already contain a cherry-picked prefix).
    source_base=$(pr_git merge-base --all "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .main)" "$head") &&
      [[ "$source_base" =~ ^[0-9a-f]{40}$ ]] || {
      merge_outcome_stop "require one source fork base between retained main/head for $method/$route; base missing, unavailable, or ambiguous"; return 1;
    }
    merge_inputs=(--merge-base="$source_base" "$landed" "$head")
  else
    parent=$(pr_git rev-parse "$landed^1") || return 1
    if [ "$method" = merge ] && ! pr_git merge-base --is-ancestor "$head" "$landed"; then
      merge_outcome_stop "landed merge does not retain prepared-head ancestry"; return 1
    fi
    merge_inputs=("$parent" "$head")
  fi
  tree=$(pr_git merge-tree --write-tree "${merge_inputs[@]}") || {
    merge_outcome_stop "cannot reconstruct $method/$route landed tree at $landed"; return 1;
  }
  [ "$tree" = "$(pr_git rev-parse "$landed^{tree}")" ] || {
    merge_outcome_stop "landed tree does not match the prepared source ($method/$route)"; return 1;
  }
  merge_outcome_stable "$pr" || return 1
  if [ "$phase" = intent ]; then
    merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c --arg landed "$landed" '.phase="merged" | .landed=$landed')" || return 1
  elif [ "$landed" != "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .landed)" ]; then
    merge_outcome_stop "remote merge receipt differs from the retained receipt"; return 1
  fi
  if [ "$method" = squash ] && [ "$route" != queue ] && [ "$tree" = "$(pr_git rev-parse "$parent^{tree}")" ]; then
    echo "Warning: recorded squash has no net change at its landed parent ($landed). Inspect main/PR history; receipt retained, no resubmission or automatic revert." >&2
  fi
  echo "MERGED exact attempted head $head as $landed; receipt retained at $MERGE_OUTCOME_REF."
}

merge_outcome_cancel_auto() {
  local pr="$1" expected_oid="$2" actor root capture
  if [ "$expected_oid" != "$MERGE_OUTCOME_OID" ] ||
    ! printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e '
      .phase == "intent" and .accepted == true and .route == "auto"
    ' >/dev/null; then
    merge_outcome_stop "auto cancellation requires the exact retained accepted auto intent"; return 1
  fi
  merge_outcome_observe "$pr" || return 1
  if [ "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .pr.state)" = MERGED ]; then
    merge_outcome_resume "$pr"
    return
  fi
  if ! printf '%s\n' "$MERGE_OBSERVATION" | jq -e --argjson record "$MERGE_OUTCOME_RECORD" '
    .pr.id == $record.prId and .pr.headRefOid == $record.head and .pr.baseRefName == $record.base and
    .pr.state == "OPEN" and .pr.isInMergeQueue == false and .pr.isMergeQueueEnabled == false and
    (if $record | has("cancellation") then true else
       .pr.autoMergeRequest.mergeMethod == ($record.method | ascii_upcase) end)
  ' >/dev/null; then
    merge_outcome_stop "auto cancellation requires the original open PR/head/base and matching non-queue request"; return 1
  fi
  if ! printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e 'has("cancellation")' >/dev/null; then
    actor=$(pr_gh_writer_login "$MERGE_REPO_HOST") || return 1
    [ -n "$actor" ] || return 1
    local captures=()
    root=$(repo_root) || return 1
    for capture in "$root/.worktrees/pr-$pr/.local/merge-output.log" "$root/.worktrees/pr-$pr"/.local/merge-output.*.log; do
      [ -e "$capture" ] || [ -L "$capture" ] || continue
      [ -f "$capture" ] && [ ! -L "$capture" ] || { merge_outcome_stop "cannot retain non-regular capture $capture"; return 1; }
      captures+=("$capture")
    done
    merge_outcome_stable "$pr" || return 1
    # Retain cancellation before dispatch. A lost reply is observation-only on retry.
    merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c --arg actor "$actor" --arg outcome "$expected_oid" \
      '.cancellation={actor:$actor,outcome:$outcome,state:"requested"}')" ${captures[@]+"${captures[@]}"} || return 1
    pr_gh_plain api graphql --hostname "$MERGE_REPO_HOST" \
      -f "id=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .prId)" \
      -f 'query=mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}' ||
      echo "Auto cancellation response uncertain; reconciling without another cancellation request." >&2
    merge_outcome_observe "$pr" || return 1
    if [ "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .pr.state)" = MERGED ]; then
      merge_outcome_resume "$pr"
      return
    fi
  fi
  if ! printf '%s\n' "$MERGE_OBSERVATION" | jq -e --argjson record "$MERGE_OUTCOME_RECORD" '
    .pr.id == $record.prId and .pr.headRefOid == $record.head and .pr.baseRefName == $record.base and
    .pr.state == "OPEN" and .pr.autoMergeRequest == null and
    .pr.isInMergeQueue == false and .pr.isMergeQueueEnabled == false
  ' >/dev/null; then
    merge_outcome_stop "auto cancellation unresolved; preserve the retained attempt, do not replace the head or repeat cancellation"; return 1
  fi
  merge_outcome_stable "$pr" || return 1
  if [ "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .cancellation.state)" != confirmed ]; then
    merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.cancellation.state="confirmed"')" || return 1
  fi
  echo "Auto cancellation confirmed for PR #$pr; no merge requested. Retained outcome: $MERGE_OUTCOME_OID"
  echo "Repair, review, and prepare the intended head before explicit merge-recover with this outcome OID."
}

merge_outcome_find_comment() {
  local pr="$1" comments marker matches
  MERGE_COMPLETION_COMMENT_URL=""
  marker="<!-- openclaw-merge:$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .attempt) -->"
  comments=$(pr_gh_plain issue-comments "$MERGE_REPO_NAME" "$MERGE_REPO_HOST" "$pr") || return 1
  matches=$(printf '%s\n' "$comments" | jq -ce --arg marker "$marker" \
    '[.[][] | select(.body | contains($marker))] | if length <= 1 then . else error("ambiguous completion marker") end') || return 1
  if [ "$matches" != '[]' ]; then
    MERGE_COMPLETION_COMMENT_URL=$(printf '%s\n' "$matches" | jq -er '.[0].html_url | select(type == "string" and length > 0)') || return 1
  fi
}

merge_outcome_comment_body() {
  local pr="$1" head landed method route label
  head=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .head) || return 1
  landed=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .landed) || return 1
  method=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .method) || return 1
  route=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .route) || return 1
  case "$route:$method" in
    admin:*) label="admin squash with trusted Crabbox infrastructure proof" ;;
    queue:*) label="merge queue (requested $method)" ;;
    auto:*) label="squash auto-merge" ;;
    immediate:merge) label="merge commit" ;;
    *) label="$method" ;;
  esac
  printf 'Merged via %s.\n\n- Prepared head SHA: [%s](%s/pull/%s/commits/%s)\n- Landed commit: [%s](%s/commit/%s)' \
    "$label" "$head" "$MERGE_REPO_URL" "$pr" "$head" "$landed" "$MERGE_REPO_URL" "$landed"
}

merge_outcome_post_comment() {
  local pr="$1" body="$2" response comment_status=0
  body+=$'\n\n'"<!-- openclaw-merge:$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .attempt) -->"
  # Persist intent before POST: an interrupted or lost reply is lookup-only on recovery.
  merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commenting"')" || return 1
  # Use the successful receipt observation's transport. Never replay a lost write
  # response through the other API; the retained marker owns reconciliation.
  if [ "${MERGE_TRANSPORT:-rest}" = graphql ]; then
    response=$(pr_gh_plain api graphql --hostname "$MERGE_REPO_HOST" \
      -f subject="$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .prId)" -f "body=$body" \
      -f 'query=mutation($subject:ID!,$body:String!){addComment(input:{subjectId:$subject,body:$body}){commentEdge{node{url}}}}') || comment_status=$?
    MERGE_COMPLETION_COMMENT_URL=$(printf '%s\n' "$response" | jq -er 'select(.errors == null) | .data.addComment.commentEdge.node.url | select(type == "string" and length > 0)') || comment_status=1
  else
    MERGE_COMPLETION_COMMENT_URL=$(pr_gh_plain api --hostname "$MERGE_REPO_HOST" --method POST \
      "repos/$MERGE_REPO_NAME/issues/$pr/comments" --raw-field "body=$body" --jq '.html_url // empty') || comment_status=$?
  fi
  if [ "$comment_status" -ne 0 ] ||
    [ -z "$MERGE_COMPLETION_COMMENT_URL" ]; then
    echo "Merge confirmed; completion comment outcome uncertain. No second POST or cleanup. Run scripts/pr merge-run $pr for read-only reconciliation."
    return 1
  fi
  merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commented"')"
}

merge_outcome_head_branch() {
  local pr="$1" head_json
  head_json=$(pr_gh_plain pr view "$pr" --repo "$MERGE_REPO_URL" --json headRefOid,headRefName,headRepository,headRepositoryOwner) || return 1
  MERGE_HEAD_REF=$(printf '%s\n' "$head_json" | jq -er --arg head "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .head)" \
    'select(.headRefOid == $head) | .headRefName | select(type == "string" and length > 0)') || return 1
  MERGE_HEAD_REPO=$(printf '%s\n' "$head_json" | jq -er '.headRepositoryOwner.login + "/" + .headRepository.name | select(test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))') || return 1
  pr_git check-ref-format "refs/heads/$MERGE_HEAD_REF"
}

merge_outcome_require_cleanup_absent() {
  local pr="$1" root worktrees branch ref_status=0
  root=$(repo_root) || return 1
  worktrees=$(pr_git worktree list --porcelain) || return 1
  if [ -e "$root/.worktrees/pr-$pr" ] || [ -L "$root/.worktrees/pr-$pr" ] ||
    printf '%s\n' "$worktrees" | grep -Fxq "worktree $root/.worktrees/pr-$pr"; then
    echo "Completion requires the native worktree to be absent; inspect its ownership before cleanup." >&2
    return 1
  fi
  merge_outcome_head_branch "$pr" || return 1
  for branch in "temp/pr-$pr" "pr-$pr" "pr-$pr-prep"; do
    ref_status=0
    pr_git show-ref --verify --quiet "refs/heads/$branch" || ref_status=$?
    [ "$ref_status" -eq 1 ] || { echo "Completion requires local branch $branch to be absent; no deletion attempted." >&2; return 1; }
  done
  ref_status=0
  pr_git ls-remote --exit-code --refs "https://$MERGE_REPO_HOST/$MERGE_HEAD_REPO.git" "refs/heads/$MERGE_HEAD_REF" >/dev/null || ref_status=$?
  [ "$ref_status" -eq 2 ] || { echo "Completion requires authoritative remote branch absence; no deletion attempted." >&2; return 1; }
}

merge_complete() {
  local pr="$1" expected_oid="$2" phase body
  local MERGE_OUTCOME_REF MERGE_OUTCOME_OID MERGE_OUTCOME_RECORD MERGE_REPO
  local MERGE_REPO_URL MERGE_REPO_HOST MERGE_REPO_NAME MERGE_OBSERVATION MERGE_ENTRY_OBSERVATION
  local MERGE_HEAD_REF MERGE_HEAD_REPO MERGE_COMPLETION_COMMENT_URL
  merge_outcome_init "$pr" || return 1
  if [ "$MERGE_OUTCOME_OID" != "$expected_oid" ] ||
    ! printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e '.phase != "intent"' >/dev/null; then
    merge_outcome_stop "completion requires the exact verified merge receipt; reconcile pending intent first"
    return 1
  fi
  merge_outcome_reconcile "$pr" || return 1
  phase=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .phase) || return 1
  if [ "$phase" = complete ]; then
    echo "merge-complete already complete for PR #$pr; no side effects."
    return 0
  fi
  # Delayed completion only observes cleanup; it never deletes recreated resources.
  merge_outcome_require_cleanup_absent "$pr" || return 1
  if [ "$phase" = merged ] && [ "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .route)" = admin ]; then
    echo "Admin completion requires its original landing audit before a first comment; preserve the receipt for owner review." >&2
    return 1
  fi
  merge_outcome_find_comment "$pr" || return 1
  if [ -n "$MERGE_COMPLETION_COMMENT_URL" ]; then
    merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commented"')" || return 1
  elif [ "$phase" = merged ]; then
    body=$(merge_outcome_comment_body "$pr") || return 1
    merge_outcome_post_comment "$pr" "$body" || return 1
  else
    echo "Completion comment is missing or uncertain; no second POST. Inspect the recorded attempt marker." >&2
    return 1
  fi
  merge_outcome_require_cleanup_absent "$pr" || return 1
  merge_outcome_stable "$pr" || return 1
  merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="complete"')" || return 1
  echo "merge-complete complete for PR #$pr"
  echo "completion comment: $MERGE_COMPLETION_COMMENT_URL"
}

merge_outcome_resume() {
  local pr="$1" phase MERGE_COMPLETION_COMMENT_URL
  merge_outcome_reconcile "$pr" || return 1
  phase=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .phase)
  [ "$phase" != intent ] || return 0
  if [ "$phase" = commenting ]; then
    # Absence never permits a second POST: the first response may have been lost.
    if merge_outcome_find_comment "$pr" && [ -n "$MERGE_COMPLETION_COMMENT_URL" ]; then
      echo "Completion comment observed: $MERGE_COMPLETION_COMMENT_URL"
      merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commented"')" || return 1
    fi
  fi
  if [ "$phase" = complete ]; then
    echo "merge-run already complete for PR #$pr; no side effects."
  else
    echo "Merge confirmed; completion pending. Recovery does not repeat comment POST or cleanup. Inspect the completion marker in PR comments and any remaining .worktrees/pr-$pr/local branches; verify their ownership before manual cleanup."
    echo "After cleanup, explicitly finalize: scripts/pr merge-complete $pr $MERGE_OUTCOME_OID --confirmed-operator-completion"
  fi
}
