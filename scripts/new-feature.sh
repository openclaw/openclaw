#!/bin/bash
set -euo pipefail

# new-feature.sh — Create a feature branch and scaffold an implementation log
#
# Usage: ./scripts/new-feature.sh [--type feat|cfg|dbg] <name>
# Example: ./scripts/new-feature.sh fix-auth-redirect
# Example: ./scripts/new-feature.sh --type dbg gateway-startup
#
# This will:
#   1. Ensure you're on main and it's clean
#   2. Create branch feature/<name>
#   3. Create _work/implementation_log/MMDDYY-HHMM-<type>-<name>.md from template

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/_work/implementation_log"
TEMPLATE="$LOG_DIR/_TEMPLATE.md"

LOG_TYPE="feat"

# Parse --type flag
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      LOG_TYPE="$2"
      if [[ "$LOG_TYPE" != "feat" && "$LOG_TYPE" != "cfg" && "$LOG_TYPE" != "dbg" ]]; then
        echo "ERROR: Invalid type '$LOG_TYPE'. Must be: feat, cfg, or dbg"
        exit 1
      fi
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

if [ $# -lt 1 ]; then
  echo "Usage: ./scripts/new-feature.sh [--type feat|cfg|dbg] <name>"
  echo "  Types: feat (default), cfg (config/settings), dbg (troubleshooting)"
  echo "Example: ./scripts/new-feature.sh fix-auth-redirect"
  echo "Example: ./scripts/new-feature.sh --type dbg gateway-startup"
  exit 1
fi

FEATURE_NAME="$1"
BRANCH_NAME="feature/$FEATURE_NAME"

cd "$REPO_ROOT"

# Check for clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Working tree is not clean. Commit or stash your changes first."
  exit 1
fi

# Check we're on main
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "WARNING: You're on '$CURRENT_BRANCH', not 'main'."
  read -rp "Switch to main before branching? [Y/n] " answer
  if [ "${answer,,}" != "n" ]; then
    git checkout main
  fi
fi

# Create the feature branch
echo "Creating branch: $BRANCH_NAME"
git checkout -b "$BRANCH_NAME"

# Generate the log file
TIMESTAMP="$(date +%m%d%y-%H%M)"
LOG_FILE="$LOG_DIR/${TIMESTAMP}-${LOG_TYPE}-${FEATURE_NAME}.md"

mkdir -p "$LOG_DIR"

if [ -f "$TEMPLATE" ]; then
  # Copy template and fill in known values
  sed \
    -e "s/<Name>/${FEATURE_NAME}/g" \
    -e "s/YYYY-MM-DD HH:MM/$(date '+%Y-%m-%d %H:%M')/g" \
    -e "s/feat | cfg | dbg/${LOG_TYPE}/g" \
    -e "s|feature/<name>|${BRANCH_NAME}|g" \
    "$TEMPLATE" > "$LOG_FILE"
else
  # Fallback if template is missing
  cat > "$LOG_FILE" <<EOF
# Implementation Log: ${FEATURE_NAME}

**Date started:** $(date '+%Y-%m-%d %H:%M')
**Type:** ${LOG_TYPE}
**Branch:** \`${BRANCH_NAME}\`
**Status:** In Progress
**Date completed:** —

---

## Goal

## Desired Outcome

## Plan

## Progress

## Testing

## Files Changed

## Notes
EOF
fi

echo ""
echo "=== Feature setup complete ==="
echo "Branch:  $BRANCH_NAME"
echo "Log:     $LOG_FILE"
echo ""
echo "Next steps:"
echo "  1. Edit the implementation log with your plan"
echo "  2. Implement the change"
echo "  3. Test: pnpm build && pnpm check && pnpm test"
echo "  4. Push: git push -u origin $BRANCH_NAME"
echo "  5. Open PR: gh pr create"
