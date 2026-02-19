#!/usr/bin/env bash
#
# sync-upstream.sh — Merge upstream OpenClaw changes into the MABOS fork.
#
# This script:
#   1. Fetches the latest upstream/main
#   2. Merges it into the current branch
#   3. Re-applies MABOS branding (the ~5 file edits)
#   4. Rebuilds and runs tests
#   5. Reports success or failure
#
# Usage:
#   bash mabos/scripts/sync-upstream.sh
#
# For CI, this can be run on a schedule (weekly).
# If the merge fails, it exits with code 1 — handle manually.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "=== MABOS Upstream Sync ==="
echo "  Branch: $BRANCH"
echo "  Date:   $(date -u '+%Y-%m-%d %H:%M UTC')"
echo ""

# ── 1. Fetch upstream ──
echo "[sync] Fetching upstream..."
git fetch upstream

UPSTREAM_HEAD="$(git rev-parse upstream/main)"
LOCAL_HEAD="$(git rev-parse HEAD)"
echo "  Upstream HEAD: ${UPSTREAM_HEAD:0:12}"
echo "  Local HEAD:    ${LOCAL_HEAD:0:12}"

if [ "$UPSTREAM_HEAD" = "$LOCAL_HEAD" ]; then
  echo "[sync] Already up to date. Nothing to do."
  exit 0
fi

# ── 2. Merge ──
echo ""
echo "[sync] Merging upstream/main..."
if ! git merge upstream/main --no-edit; then
  echo ""
  echo "[sync] MERGE CONFLICT detected."
  echo "  The conflict is likely in one of the ~5 upstream files MABOS modifies."
  echo "  Resolve conflicts manually, then run:"
  echo "    bash mabos/scripts/rebrand.sh"
  echo "    pnpm build && pnpm test:fast"
  echo ""
  echo "  Conflict files:"
  git diff --name-only --diff-filter=U 2>/dev/null || true
  exit 1
fi

echo "[sync] Merge successful."

# ── 3. Re-apply branding ──
echo ""
echo "[sync] Re-applying MABOS branding..."
bash mabos/scripts/rebrand.sh

# ── 4. Build + Test ──
echo ""
echo "[sync] Building..."
if ! pnpm build; then
  echo "[sync] BUILD FAILED after merge. Review the merge diff."
  exit 1
fi

echo ""
echo "[sync] Running tests..."
if ! pnpm test:fast; then
  echo "[sync] TESTS FAILED after merge. Review the failing tests."
  exit 1
fi

# ── 5. Also build + test MABOS extension ──
echo ""
echo "[sync] Building MABOS extension..."
cd extensions/mabos
if ! pnpm build; then
  echo "[sync] MABOS EXTENSION BUILD FAILED."
  exit 1
fi

echo ""
echo "[sync] Running MABOS tests..."
if ! pnpm test; then
  echo "[sync] MABOS TESTS FAILED."
  exit 1
fi

cd "$REPO_ROOT"

# ── Done ──
NEW_HEAD="$(git rev-parse HEAD)"
echo ""
echo "=== Sync Complete ==="
echo "  Previous HEAD: ${LOCAL_HEAD:0:12}"
echo "  New HEAD:      ${NEW_HEAD:0:12}"
echo "  Upstream HEAD: ${UPSTREAM_HEAD:0:12}"
echo ""
echo "  All builds pass. All tests pass."
echo "  Push when ready: git push origin $BRANCH"
