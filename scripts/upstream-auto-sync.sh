#!/usr/bin/env bash
set -euo pipefail

# Idempotent upstream sync script for QVerisBot fork.
#
# Usage:
#   bash scripts/upstream-auto-sync.sh
#
# Optional env overrides:
#   UPSTREAM_REMOTE=upstream
#   UPSTREAM_URL=https://github.com/openclaw/openclaw.git
#   BASE_BRANCH=main
#   SYNC_BRANCH=sync/upstream-YYYY-MM-DD

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/openclaw/openclaw.git}"
BASE_BRANCH="${BASE_BRANCH:-main}"
TODAY="$(date +"%Y-%m-%d")"
SYNC_BRANCH="${SYNC_BRANCH:-sync/upstream-$TODAY}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

ensure_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "Not inside a git repository."
  fi
}

ensure_clean_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    die "Working tree is not clean. Commit/stash changes before sync."
  fi
}

ensure_no_in_progress_ops() {
  if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    die "A merge is already in progress."
  fi
  if git rev-parse -q --verify REBASE_HEAD >/dev/null 2>&1; then
    die "A rebase is already in progress."
  fi
  if [[ -d .git/rebase-apply || -d .git/rebase-merge ]]; then
    die "A rebase is already in progress."
  fi
}

ensure_remote() {
  if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    local existing_url
    existing_url="$(git remote get-url "$UPSTREAM_REMOTE")"
    if [[ "$existing_url" != "$UPSTREAM_URL" ]]; then
      die "Remote '$UPSTREAM_REMOTE' exists with different URL: $existing_url"
    fi
  else
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  fi
}

# ---------------------------------------------------------------------------
# Post-merge: QVerisBot fork-specific patches
#
# These patches are automatically re-applied after every upstream merge
# because upstream may overwrite them. Each patch is idempotent.
# ---------------------------------------------------------------------------

apply_fork_patches() {
  echo "==> Applying QVerisBot fork patches"

  local changed=0

  # --- Patch 1: Force defaultChoice to "local" for all bundled extensions ---
  # Reason: QVerisBot bundles all extensions in the npm package. The upstream
  # default "npm" tries to download from @openclaw/* which doesn't work for
  # the @qverisai scope. "local" uses the bundled path instead.
  echo "    [patch] extensions/*/package.json: defaultChoice → local"
  for pkg in "$REPO_ROOT"/extensions/*/package.json; do
    if [[ ! -f "$pkg" ]]; then
      continue
    fi
    if grep -q '"defaultChoice": "npm"' "$pkg" 2>/dev/null; then
      # Use a portable sed in-place edit (macOS + GNU compatible)
      if sed --version >/dev/null 2>&1; then
        # GNU sed
        sed -i 's/"defaultChoice": "npm"/"defaultChoice": "local"/' "$pkg"
      else
        # BSD/macOS sed
        sed -i '' 's/"defaultChoice": "npm"/"defaultChoice": "local"/' "$pkg"
      fi
      echo "      fixed: $(basename "$(dirname "$pkg")")/package.json"
      changed=1
    fi
  done

  # --- Patch 2: Ensure openclaw workspace shim exists ---
  # Reason: extensions depend on "openclaw@workspace:*" but the root package
  # is "@qverisai/qverisbot". The shim at packages/openclaw/ re-exports it.
  local shim_dir="$REPO_ROOT/packages/openclaw"
  if [[ ! -f "$shim_dir/package.json" ]]; then
    echo "    [patch] packages/openclaw: creating workspace shim"
    mkdir -p "$shim_dir"
    cat > "$shim_dir/package.json" <<'SHIM_PKG'
{
  "name": "openclaw",
  "version": "0.0.0-workspace",
  "private": true,
  "type": "module",
  "dependencies": {
    "@qverisai/qverisbot": "workspace:*"
  },
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "default": "./index.js"
    },
    "./plugin-sdk": {
      "types": "./plugin-sdk.d.ts",
      "default": "./plugin-sdk.js"
    }
  }
}
SHIM_PKG
    echo 'export * from "@qverisai/qverisbot";' > "$shim_dir/index.js"
    echo 'export * from "@qverisai/qverisbot/plugin-sdk";' > "$shim_dir/plugin-sdk.js"
    echo 'export * from "@qverisai/qverisbot";' > "$shim_dir/index.d.ts"
    echo 'export * from "@qverisai/qverisbot/plugin-sdk";' > "$shim_dir/plugin-sdk.d.ts"
    changed=1
  fi

  if [[ $changed -eq 1 ]]; then
    echo "    [patch] staging fork patches"
    git add -A
    git commit -m "chore: re-apply QVerisBot fork patches after upstream sync" --no-verify || true
  else
    echo "    [patch] no patches needed"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "==> Preflight checks"
ensure_git_repo
ensure_no_in_progress_ops
ensure_clean_tree
ensure_remote

echo "==> Fetch remotes"
git fetch origin --prune
git fetch "$UPSTREAM_REMOTE" --prune

if ! git show-ref --verify --quiet "refs/remotes/origin/$BASE_BRANCH"; then
  die "Missing origin/$BASE_BRANCH. Run fetch and verify base branch."
fi
if ! git show-ref --verify --quiet "refs/remotes/$UPSTREAM_REMOTE/$BASE_BRANCH"; then
  die "Missing $UPSTREAM_REMOTE/$BASE_BRANCH. Verify upstream remote/branch."
fi

echo "==> Checkout sync branch: $SYNC_BRANCH"
if git show-ref --verify --quiet "refs/heads/$SYNC_BRANCH"; then
  git checkout "$SYNC_BRANCH"
else
  git checkout -b "$SYNC_BRANCH" "origin/$BASE_BRANCH"
fi

if git merge-base --is-ancestor "$UPSTREAM_REMOTE/$BASE_BRANCH" HEAD; then
  echo "==> Already up to date: HEAD already contains $UPSTREAM_REMOTE/$BASE_BRANCH"
  exit 0
fi

echo "==> Merge $UPSTREAM_REMOTE/$BASE_BRANCH into $SYNC_BRANCH"
if ! git merge --no-ff --no-edit "$UPSTREAM_REMOTE/$BASE_BRANCH"; then
  echo
  echo "Merge has conflicts. Resolve them, then run:"
  echo "  git add <resolved-files>"
  echo "  git commit"
  echo
  echo "After resolving conflicts, re-run this script or manually run:"
  echo "  bash scripts/upstream-auto-sync.sh --post-merge-only"
  echo
  echo "Conflicted files:"
  git diff --name-only --diff-filter=U || true
  exit 1
fi

# Apply fork-specific patches after successful merge
apply_fork_patches

echo
echo "==> Sync complete on branch: $SYNC_BRANCH"
echo
echo "Next steps:"
echo "  pnpm install"
echo "  pnpm build"
echo "  pnpm check"
echo "  pnpm test:pack:smoke        # verify npm pack + install (optional)"
