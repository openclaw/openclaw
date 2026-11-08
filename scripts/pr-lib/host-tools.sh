# Standalone lock/recovery shells also use the wrapper's selected executable.
pr_git() { "${OPENCLAW_PR_GIT:-${GIT_EXEC:-git}}" "$@"; }

pr_remote_branch_sha() {
  local remote_refs remote_sha
  # Git patterns match ref tails. Only successful, exact observations authorize
  # publication or cleanup; transport/parse failures must never prove absence.
  remote_refs=$(pr_git ls-remote --exit-code --heads "$1" "refs/heads/$2") || return $?
  remote_sha=$(printf '%s\n' "$remote_refs" | awk -v ref="refs/heads/$2" '$2 == ref {print $1}') || return 1
  [ -n "$remote_sha" ] || return 2
  printf '%s\n' "$remote_sha"
}

pr_run_bounded() (
  set +e
  set -m
  "$@" &
  local tool_pid=$! timer_pid result
  (/bin/sleep 10; kill -KILL -- "-$tool_pid" 2>/dev/null) &
  timer_pid=$!
  wait "$tool_pid" 2>/dev/null
  result=$?
  kill -KILL -- "-$timer_pid" 2>/dev/null
  wait "$timer_pid" 2>/dev/null
  exit "$result"
)
