if [ -n "${OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT:-}" ]; then
  pr_gh_snapshot_root=$(cd "$OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT" && pwd -P) || return 1
  pr_gh_source_scripts=$(cd "${BASH_SOURCE[0]%/*}/.." && pwd -P) || return 1
  if [ "$pr_gh_source_scripts" != "$pr_gh_snapshot_root/scripts" ]; then
    # The locator supplies addressing only. Verify the entire executable closure
    # before handoff, including real directories so Node cannot follow a new import root.
    for pr_gh_snapshot_path in scripts scripts/pr-lib scripts/lib; do
      if [ ! -d "$pr_gh_snapshot_root/$pr_gh_snapshot_path" ] ||
        [ -L "$pr_gh_snapshot_root/$pr_gh_snapshot_path" ]; then
        echo "Refusing unverified scripts/pr GitHub helper snapshot." >&2
        return 1
      fi
    done
    for pr_gh_snapshot_path in pr-lib/github.sh pr-lib/github.mjs pr-lib/gh-api-preflight.mjs lib/plain-gh.mjs lib/direct-run.mjs; do
      if [ ! -f "$pr_gh_snapshot_root/scripts/$pr_gh_snapshot_path" ] ||
        [ -L "$pr_gh_snapshot_root/scripts/$pr_gh_snapshot_path" ] ||
        ! cmp -s "$pr_gh_source_scripts/$pr_gh_snapshot_path" "$pr_gh_snapshot_root/scripts/$pr_gh_snapshot_path"; then
        echo "Refusing unverified scripts/pr GitHub helper snapshot." >&2
        return 1
      fi
    done
    source "$pr_gh_snapshot_root/scripts/pr-lib/github.sh"
    return $?
  fi
fi
unset pr_gh_snapshot_root pr_gh_source_scripts pr_gh_snapshot_path

pr_gh_run() (
  local route="$1" filter="" filtered=0
  shift
  local args=()
  case "${1:-}:${2:-}" in
    pr:view|repo:view)
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --jq)
            [ "$#" -ge 2 ] || { echo "scripts/pr --jq requires a filter." >&2; return 2; }
            filter="$2"; filtered=1; shift 2 ;;
          --jq=*) filter="${1#--jq=}"; filtered=1; shift ;;
          *) args+=("$1"); shift ;;
        esac
      done
      ;;
    *) args=("$@") ;;
  esac
  if [ "$filtered" -eq 1 ]; then
    # jq is a wrapper prerequisite; preserve the API owner's failure through the filter.
    set -o pipefail
    node "${BASH_SOURCE[0]%/*}/github.mjs" "$route" "${args[@]}" | jq -r "$filter"
  else
    node "${BASH_SOURCE[0]%/*}/github.mjs" "$route" "${args[@]}"
  fi
)

pr_gh() { pr_gh_run read "$@"; }

pr_gh_plain() { pr_gh_run "${pr_gh_quota_route:-plain}" "$@"; }

pr_gh_quota_read() {
  local pr_gh_quota_route=plain-quota
  pr_gh_plain "$@"
}

pr_gh_quota_exhausted() {
  printf '%s\n' "$1" | jq -e '. == {graphqlQuotaExhausted:true}' >/dev/null 2>&1
}

pr_gh_writer_login() {
  pr_gh_plain writer-login "$@"
}
