#!/usr/bin/env bash
# Pre-task checks for the Ralph loop.
#
# Exits 0 if safe to start a task. Non-zero if anything looks wrong.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

fail() { echo "pre-task: FAIL: $*" >&2; exit 1; }
ok() { echo "pre-task: ok: $*"; }

# 1. Branch must be octopus-orchestrator
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "octopus-orchestrator" ]]; then
    fail "must be on octopus-orchestrator branch, currently on '$current_branch'"
fi
ok "branch is octopus-orchestrator"

# 2. Working tree clean under docs/octopus-orchestrator/ and src/octo/
#    (other paths may be dirty from unrelated in-flight work and are not our concern)
dirty=$(git status --porcelain docs/octopus-orchestrator/ src/octo/ 2>/dev/null || true)
if [[ -n "$dirty" ]]; then
    fail "working tree dirty under docs/octopus-orchestrator/ or src/octo/ — clean up before loop can continue:"$'\n'"$dirty"
fi
ok "working tree clean in loop scope"

# 3. Required tools
for tool in git node npm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        fail "required tool missing: $tool"
    fi
done
ok "required tools present"

# tmux is required from M1-10 onwards — warn but do not fail pre-M1-10
if ! command -v tmux >/dev/null 2>&1; then
    echo "pre-task: WARN: tmux not installed — M1-10 and later will fail" >&2
fi

# sqlite3 is required from M1-01 onwards
if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "pre-task: WARN: sqlite3 not installed — M1-01 and later will fail" >&2
fi

# 4. OpenClaw availability
if ! command -v openclaw >/dev/null 2>&1; then
    fail "openclaw CLI not found in PATH"
fi
ok "openclaw CLI present"

# 5. Loop state files exist
for f in docs/octopus-orchestrator/PROMPT.md \
         docs/octopus-orchestrator/TASKS.md \
         docs/octopus-orchestrator/STATE.md \
         docs/octopus-orchestrator/BLOCKED.md; do
    if [[ ! -f "$f" ]]; then
        fail "required loop file missing: $f"
    fi
done
ok "loop files present"

exit 0
