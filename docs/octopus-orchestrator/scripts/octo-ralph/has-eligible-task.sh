#!/usr/bin/env bash
# Returns 0 and prints the id of the first eligible task (ready + all deps done).
# Returns 1 if no eligible task exists.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
TASKS="$REPO_ROOT/docs/octopus-orchestrator/TASKS.md"

if [[ ! -f "$TASKS" ]]; then
    echo "has-eligible-task: TASKS.md not found" >&2
    exit 1
fi

# Two-pass awk:
#   Pass 1: build id->status and id->deps maps
#   Pass 2 (END): find the first ready task whose deps are all done
awk '
# Header line: capture task id, reset per-task state
/^## M[0-9][0-9]*-[0-9][0-9]*/ {
    # Flush previous task
    if (current_id != "") {
        statuses[current_id] = current_status
        depmap[current_id] = current_deps
        order[n_tasks++] = current_id
    }
    current_id = $2
    current_status = ""
    current_deps = ""
    next
}

/^\*\*Status:\*\*/ {
    current_status = $2
    next
}

/^\*\*Depends on:\*\*/ {
    # Collect everything after "Depends on:"
    for (i = 3; i <= NF; i++) {
        tok = $i
        gsub(",", "", tok)
        if (tok == "—" || tok == "-" || tok == "") continue
        current_deps = current_deps " " tok
    }
    next
}

END {
    # Flush last task
    if (current_id != "") {
        statuses[current_id] = current_status
        depmap[current_id] = current_deps
        order[n_tasks++] = current_id
    }

    # Find first ready task whose deps are all done
    for (i = 0; i < n_tasks; i++) {
        id = order[i]
        if (statuses[id] != "ready") continue

        deps_str = depmap[id]
        eligible = 1
        if (deps_str != "") {
            n = split(deps_str, deps_arr, " ")
            for (j = 1; j <= n; j++) {
                d = deps_arr[j]
                if (d == "") continue
                if (statuses[d] != "done") { eligible = 0; break }
            }
        }
        if (eligible) {
            print id
            exit 0
        }
    }
    exit 1
}
' "$TASKS"
