#!/usr/bin/env bash
# Install pre-commit hook that blocks commits from the default checkout.
# The default checkout must stay as a clean origin/main mirror.
# All write work must happen in isolated worktrees.

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

# Determine hooks directory (respect core.hooksPath if set)
HOOKS_DIR="$(git config core.hooksPath 2>/dev/null || echo ".git/hooks")"

# If hooksPath is relative, make it absolute from repo root
if [[ "$HOOKS_DIR" != /* ]]; then
  HOOKS_DIR="$ROOT_DIR/$HOOKS_DIR"
fi

mkdir -p "$HOOKS_DIR"

HOOK_FILE="$HOOKS_DIR/default-checkout-guard"

cat > "$HOOK_FILE" << 'GUARD_EOF'
#!/usr/bin/env bash
# Default checkout pollution guard.
# Blocks commits from the default checkout (main branch at repo root).
# Write work must happen in isolated worktrees.
#
# Bypass: set DEFAULT_CHECKOUT_ALLOW_COMMIT=1 for controlled sync/release work.

set -euo pipefail

if [[ "${DEFAULT_CHECKOUT_ALLOW_COMMIT:-}" == "1" ]]; then
  exit 0
fi

BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")"

# Only guard the main branch at the repo root (the default mirror checkout)
if [[ "$BRANCH" != "main" ]]; then
  exit 0
fi

# Check if we're in a worktree (worktrees have their own .git file, not dir)
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || echo ".git")"
if [[ -f "$GIT_DIR" ]]; then
  # This is a worktree, allow commits
  exit 0
fi

# Check for readonly fence
FENCE_FILE="$(git rev-parse --show-toplevel)/.default-checkout-fence"
if [[ -f "$FENCE_FILE" ]]; then
  echo "❌ DEFAULT CHECKOUT READONLY FENCE IS ACTIVE" >&2
  echo "The default checkout is locked. Use:" >&2
  echo "  node scripts/default-checkout-readonly-fence.mjs unlock" >&2
  echo "to temporarily allow writes." >&2
  exit 1
fi

echo "⚠️  DEFAULT CHECKOUT POLLUTION GUARD" >&2
echo "" >&2
echo "You are trying to commit directly to the default checkout (main)." >&2
echo "The default checkout must stay as a clean origin/main mirror." >&2
echo "" >&2
echo "Options:" >&2
echo "  1. Use an isolated worktree: scripts/worktree-start.sh <task-slug>" >&2
echo "  2. Bypass for controlled sync: DEFAULT_CHECKOUT_ALLOW_COMMIT=1 git commit ..." >&2
echo "" >&2
echo "If this is intentional (sync/release work), re-run with the bypass." >&2
exit 1
GUARD_EOF

chmod +x "$HOOK_FILE"

# Now integrate with the existing pre-commit hook chain
# Check if there's already a pre-commit hook
PRE_COMMIT="$HOOKS_DIR/pre-commit"

if [[ -f "$PRE_COMMIT" ]]; then
  # Check if guard is already sourced
  if grep -q "default-checkout-guard" "$PRE_COMMIT" 2>/dev/null; then
    echo "✓ Default checkout guard already installed in pre-commit hook"
  else
    # Prepend guard call to existing pre-commit
    TEMP_FILE=$(mktemp)
    {
      head -1 "$PRE_COMMIT"  # shebang
      echo ""
      echo '# Default checkout pollution guard (auto-installed)'
      echo "\"$HOOK_FILE\""
      echo ""
      tail -n +2 "$PRE_COMMIT"
    } > "$TEMP_FILE"
    mv "$TEMP_FILE" "$PRE_COMMIT"
    chmod +x "$PRE_COMMIT"
    echo "✓ Default checkout guard added to existing pre-commit hook"
  fi
else
  echo "✓ Default checkout guard installed at $HOOK_FILE"
  echo "  (no existing pre-commit hook found; create one that calls this guard)"
fi

echo ""
echo "Installed at: $HOOK_FILE"
echo "Hooks dir:    $HOOKS_DIR"
