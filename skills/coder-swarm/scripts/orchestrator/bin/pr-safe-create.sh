#!/bin/bash
# pr-safe-create.sh — fork-safe wrapper around `gh pr create`
#
# Always targets the fork (origin) by default, not upstream.
# Set SWARM_PR_TARGET=upstream to override.
#
# Usage: pr-safe-create.sh [gh pr create options...]
#
# Env:
#   SWARM_PR_TARGET=upstream   Allow targeting upstream instead of origin fork.
#
# Guardrail: if upstream remote is openclaw/openclaw and SWARM_PR_TARGET is not
# "upstream", the script refuses and prints a clear error.

set -euo pipefail

SWARM_PR_TARGET="${SWARM_PR_TARGET:-origin}"

# Parse owner/repo from a git remote URL (HTTPS or SSH).
# Handles:
#   https://github.com/owner/repo.git
#   git@github.com:owner/repo.git
parse_github_repo() {
    local url="$1"
    local repo
    repo=$(echo "$url" | sed -E 's|.*github\.com[/:]([^/]+/[^/.]+)(\.git)?$|\1|')
    if [[ "$repo" == "$url" ]]; then
        # sed returned the input unchanged — no match
        echo ""
    else
        echo "$repo"
    fi
}

command -v gh >/dev/null 2>&1 || { echo "ERROR: gh not found; cannot create PR" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git not found" >&2; exit 1; }

# Resolve origin remote
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || true)
if [[ -z "$ORIGIN_URL" ]]; then
    echo "ERROR: no 'origin' remote found in this repository" >&2
    exit 1
fi

ORIGIN_REPO=$(parse_github_repo "$ORIGIN_URL")
if [[ -z "$ORIGIN_REPO" ]]; then
    echo "ERROR: cannot parse GitHub owner/repo from origin URL: $ORIGIN_URL" >&2
    exit 1
fi

# Resolve upstream remote (may not exist)
UPSTREAM_URL=$(git remote get-url upstream 2>/dev/null || true)
UPSTREAM_REPO=""
if [[ -n "$UPSTREAM_URL" ]]; then
    UPSTREAM_REPO=$(parse_github_repo "$UPSTREAM_URL")
fi

# Fork-safety: if upstream exists and differs from origin, enforce default behaviour
if [[ -n "$UPSTREAM_REPO" && "$UPSTREAM_REPO" != "$ORIGIN_REPO" ]]; then
    if [[ "$SWARM_PR_TARGET" != "upstream" ]]; then
        # Hard guardrail: never accidentally PR to the main openclaw repo
        if [[ "$UPSTREAM_REPO" == "openclaw/openclaw" ]]; then
            echo "ERROR: Upstream remote is openclaw/openclaw." >&2
            echo "       Refusing to create a PR to the upstream repo by default." >&2
            echo "       To target upstream intentionally, set SWARM_PR_TARGET=upstream and re-run." >&2
            exit 1
        fi
        echo "NOTE: upstream ($UPSTREAM_REPO) differs from origin ($ORIGIN_REPO)." >&2
        echo "      Targeting fork (origin) as default. Set SWARM_PR_TARGET=upstream to override." >&2
    fi
fi

# Choose target
if [[ "$SWARM_PR_TARGET" == "upstream" && -n "$UPSTREAM_REPO" ]]; then
    TARGET_REPO="$UPSTREAM_REPO"
else
    TARGET_REPO="$ORIGIN_REPO"
fi

echo "==> Creating PR targeting repo: $TARGET_REPO" >&2
exec gh pr create --repo "$TARGET_REPO" "$@"
