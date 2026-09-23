# Standalone lock/recovery shells also use the wrapper's selected executable.
pr_git() { "${OPENCLAW_PR_GIT:-${GIT_EXEC:-git}}" "$@"; }

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
