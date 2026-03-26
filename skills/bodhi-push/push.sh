#!/usr/bin/env bash
# bodhi-push — commit everything and push in safe 1000-commit batches
# Usage: ./push.sh "commit message" [remote] [branch]

set -euo pipefail

REPO="/home/bodhi/openbodhi"
MSG="${1:-chore: auto-commit by bodhi-push}"
REMOTE="${2:-origin}"
BRANCH="${3:-main}"

cd "$REPO"

# --- 1. Stage and commit ---
git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit."
else
  git commit -m "$MSG"
  echo "Committed: $MSG"
fi

# --- 2. Check if remote is reachable ---
if ! git ls-remote "$REMOTE" &>/dev/null; then
  echo "Remote '$REMOTE' not reachable (no SSH key or HTTPS creds). Aborting push."
  echo "Set up SSH key or HTTPS token and retry."
  exit 1
fi

# --- 3. Push in 1000-commit batches (GitHub 2GB limit safety) ---
STEP_COMMITS=$(git log --oneline --reverse "refs/heads/$BRANCH" | awk 'NR % 1000 == 0 {print $1}')

if [ -n "$STEP_COMMITS" ]; then
  echo "Pushing in batches..."
  while IFS= read -r sha; do
    echo "  → pushing up to $sha"
    git push "$REMOTE" "+${sha}:refs/heads/${BRANCH}"
  done <<< "$STEP_COMMITS"
fi

# --- 4. Final push (remaining commits) ---
# Use --force-with-lease for safety (won't overwrite unexpected remote changes)
git push "$REMOTE" "$BRANCH" || git push --force-with-lease "$REMOTE" "$BRANCH"
echo "✅ Push complete → $REMOTE/$BRANCH"
