# Trusted native callers only. scripts/pr's component inventory materializes
# this owner and the helper before any PR checkout or write-capable execution.
request_prepared_ci() {
  [ "${GATES_MODE:-}" = github_pending ] || return 0
  local pr="$1" head="$2" record repo base
  record=$(read_pr_observation "$pr") || return 1
  repo=$(printf '%s\n' "$record" | jq -er '.baseRepository.nameWithOwner') || return 1
  base=$(printf '%s\n' "$record" | jq -er '.baseRefOid') || return 1
  # The CLI rereads live identity and policy; no local or PR-supplied policy is authority.
  # prep.env was already saved, so a failed/uncertain request retains publication custody.
  node "$script_parent_dir/ci-readiness.mjs" request \
    --repo "$repo" --pr "$pr" --head "$head" --base "$base"
}
