#!/usr/bin/env bash
# Post-task checks for the Ralph loop.
#
# Runs after the agent exits 0. Verifies that the iteration left the tree
# in a valid state: a commit was made, only allowed paths changed, the
# task status was updated, and STATE.md was appended.
#
# Exits 0 if the iteration's output is acceptable.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

fail() { echo "post-task: FAIL: $*" >&2; exit 1; }
ok() { echo "post-task: ok: $*"; }

# 1. A commit should have been made on this branch this iteration
#    (either a task-done commit, a blocked commit, or a no-eligible-tasks
#    update which is allowed to be commit-less)
last_commit_ts=$(git log -1 --format=%ct)
now=$(date +%s)
diff=$((now - last_commit_ts))
if [[ $diff -gt 3600 ]]; then
    echo "post-task: WARN: last commit is $diff seconds old; iteration may have been no-op" >&2
fi

# 2. Working tree must be clean under the loop scope
dirty=$(git status --porcelain docs/octopus-orchestrator/ src/octo/ 2>/dev/null || true)
if [[ -n "$dirty" ]]; then
    fail "working tree dirty under loop scope after iteration:"$'\n'"$dirty"
fi
ok "working tree clean after iteration"

# 3. Last commit must touch only allowed paths
last_commit_files=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null || true)
if [[ -n "$last_commit_files" ]]; then
    while IFS= read -r file; do
        case "$file" in
            src/octo/*) ;;
            docs/octopus-orchestrator/TASKS.md) ;;
            docs/octopus-orchestrator/STATE.md) ;;
            docs/octopus-orchestrator/BLOCKED.md) ;;
            docs/octopus-orchestrator/SESSION-LOG.md) ;;
            *)
                fail "last commit touched disallowed path: $file"
                ;;
        esac
    done <<< "$last_commit_files"
    ok "last commit touched only allowed paths"
fi

# 4. If last commit message does not start with "octo:" warn (not fail;
#    humans may commit interleaved)
last_msg=$(git log -1 --format=%s)
if [[ "$last_msg" != octo:* ]]; then
    echo "post-task: WARN: last commit message not prefixed 'octo:': $last_msg" >&2
fi

# 5. STATE.md should have been appended in this iteration (or explicitly marked no-op)
if ! git diff-tree --no-commit-id --name-only -r HEAD | grep -q "STATE.md"; then
    echo "post-task: WARN: STATE.md not in last commit" >&2
fi

exit 0
