#!/usr/bin/env bash
# Authored by: cc (Claude Code) | 2026-03-13
# Autonomous agent loop: issue -> branch -> implement -> test -> PR
# Usage: scripts/run-issue.sh <issue-number> [--dry-run]
#
# Requires: gh, claude CLI, pnpm, git
# Models: Haiku for decomposition/summarization, Sonnet for implementation

set -euo pipefail

ISSUE_NUMBER="${1:?Usage: scripts/run-issue.sh <issue-number> [--dry-run]}"
DRY_RUN="${2:-}"
MAX_RETRIES=3
REPO="openclaw/openclaw"

# --- Helpers ---

log() { printf "\033[1;34m[run-issue]\033[0m %s\n" "$1"; }
err() { printf "\033[1;31m[run-issue]\033[0m %s\n" "$1" >&2; }

haiku() {
  claude --model claude-haiku-4-5 --print "$@"
}

sonnet() {
  claude --model claude-sonnet-4-5 --print "$@"
}

verify_build() {
  log "Verifying build..."
  if ! pnpm build 2>&1 | tail -5; then
    err "Build failed"
    return 1
  fi
  log "Build OK"
}

verify_lint() {
  log "Verifying lint..."
  if ! pnpm check 2>&1 | tail -5; then
    err "Lint failed"
    return 1
  fi
  log "Lint OK"
}

verify_tests() {
  log "Running tests..."
  if ! pnpm test 2>&1 | tail -10; then
    err "Tests failed"
    return 1
  fi
  log "Tests OK"
}

# --- Step 1: Fetch issue ---

log "Fetching issue #${ISSUE_NUMBER}..."
ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json title,body,labels)
ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r .title)
ISSUE_BODY=$(echo "$ISSUE_JSON" | jq -r .body)

if [ -z "$ISSUE_TITLE" ] || [ "$ISSUE_TITLE" = "null" ]; then
  err "Could not fetch issue #${ISSUE_NUMBER}"
  exit 1
fi

log "Issue: $ISSUE_TITLE"

# --- Step 2: Create branch ---

SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 40)
BRANCH="feature/${ISSUE_NUMBER}-${SLUG}"

log "Creating branch: $BRANCH"
if [ "$DRY_RUN" != "--dry-run" ]; then
  git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
fi

# --- Step 3: Decompose with Haiku ---

log "Decomposing issue into implementation steps..."
PLAN=$(haiku "You are decomposing a GitHub issue into implementation steps for the OpenClaw repo (TypeScript/ESM, pnpm, Vitest).

Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}
${ISSUE_BODY}

Return a numbered list of concrete implementation steps. Each step should:
- Name the file(s) to create or modify
- Describe the specific change (not vague)
- Be independently verifiable with pnpm build

Keep it to 3-7 steps. Do not include setup or PR creation steps.")

log "Plan:"
echo "$PLAN"
echo ""

if [ "$DRY_RUN" = "--dry-run" ]; then
  log "Dry run complete. Plan above."
  exit 0
fi

# --- Step 4: Implement each step with Sonnet ---

STEP_COUNT=$(echo "$PLAN" | grep -c "^[0-9]" || echo "0")
log "Implementing ${STEP_COUNT} steps..."

CONTEXT="You are implementing a change in the OpenClaw repo (TypeScript/ESM).
Read docs/repo-map.json first for file layout.

Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

Implementation plan:
${PLAN}

"

for step_num in $(seq 1 "$STEP_COUNT"); do
  STEP_LINE=$(echo "$PLAN" | grep "^${step_num}\." | head -1)
  log "Step ${step_num}/${STEP_COUNT}: ${STEP_LINE}"

  RETRY=0
  while [ "$RETRY" -lt "$MAX_RETRIES" ]; do
    sonnet "${CONTEXT}

Implement step ${step_num}: ${STEP_LINE}

Output diff-only for modified files, full content for new files.
Follow OpenClaw conventions: strict TypeScript, no any, Oxlint-clean."

    if verify_build; then
      break
    fi

    RETRY=$((RETRY + 1))
    if [ "$RETRY" -lt "$MAX_RETRIES" ]; then
      log "Retrying step ${step_num} (attempt $((RETRY + 1))/${MAX_RETRIES})..."
      BUILD_ERRORS=$(pnpm build 2>&1 | tail -20)
      sonnet "${CONTEXT}

Step ${step_num} build failed. Fix these errors:
${BUILD_ERRORS}

Return diff-only fixes."
    else
      err "Step ${step_num} failed after ${MAX_RETRIES} attempts. Aborting."
      exit 1
    fi
  done
done

# --- Step 5: Full verification ---

log "Running full verification..."

if ! verify_lint; then
  log "Attempting lint auto-fix..."
  pnpm format:fix 2>&1 | tail -5
  if ! verify_lint; then
    err "Lint issues remain after auto-fix. Manual intervention needed."
    exit 1
  fi
fi

if ! verify_tests; then
  log "Attempting test fix with Sonnet..."
  TEST_OUTPUT=$(pnpm test 2>&1 | tail -50)
  SUMMARY=$(haiku "Summarize these test failures. For each: file, test name, expected vs actual.

${TEST_OUTPUT}")

  sonnet "${CONTEXT}

Tests failed after implementation. Fix these failures:
${SUMMARY}

Return diff-only fixes for the failing tests or source code."

  if ! verify_tests; then
    err "Tests still failing after fix attempt. Manual intervention needed."
    exit 1
  fi
fi

# --- Step 6: Commit and PR ---

log "All checks passed. Creating PR..."

scripts/committer "$(echo "$ISSUE_TITLE" | head -c 72) (#${ISSUE_NUMBER})" .

git push -u origin "$BRANCH"

PR_BODY=$(cat <<EOF
## Summary

Implements #${ISSUE_NUMBER}: ${ISSUE_TITLE}

### Implementation Steps
${PLAN}

## Test Plan

- [x] \`pnpm build\` passes
- [x] \`pnpm check\` passes
- [x] \`pnpm test\` passes
- [ ] Manual verification of feature behavior

---
*Automated by \`scripts/run-issue.sh\`*
EOF
)

PR_URL=$(gh pr create \
  --repo "$REPO" \
  --title "$(echo "$ISSUE_TITLE" | head -c 72)" \
  --body "$PR_BODY" \
  --head "$BRANCH")

log "PR created: $PR_URL"
