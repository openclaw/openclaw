#!/usr/bin/env bash
#
# Comments on a GitHub issue with a list of potential duplicates.
# Usage: ./comment-on-duplicates.sh --base-issue 123 --potential-duplicates 456 789 101
#

set -euo pipefail

REPO="openclaw/openclaw"
BASE_ISSUE=""
DUPLICATES=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --base-issue)
      BASE_ISSUE="$2"
      shift 2
      ;;
    --potential-duplicates)
      shift
      while [[ $# -gt 0 && ! "$1" =~ ^-- ]]; do
        DUPLICATES+=("$1")
        shift
      done
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Validate base issue
if [[ -z "$BASE_ISSUE" ]]; then
  echo "Error: --base-issue is required" >&2
  exit 1
fi

if ! [[ "$BASE_ISSUE" =~ ^[0-9]+$ ]]; then
  echo "Error: --base-issue must be a number, got: $BASE_ISSUE" >&2
  exit 1
fi

# Validate duplicates
if [[ ${#DUPLICATES[@]} -eq 0 ]]; then
  echo "Error: --potential-duplicates requires at least one issue number" >&2
  exit 1
fi

if [[ ${#DUPLICATES[@]} -gt 3 ]]; then
  echo "Error: --potential-duplicates accepts at most 3 issues" >&2
  exit 1
fi

for dup in "${DUPLICATES[@]}"; do
  if ! [[ "$dup" =~ ^[0-9]+$ ]]; then
    echo "Error: duplicate issue must be a number, got: $dup" >&2
    exit 1
  fi
done

# Validate that base issue exists
if ! gh issue view "$BASE_ISSUE" --repo "$REPO" &>/dev/null; then
  echo "Error: issue #$BASE_ISSUE does not exist in $REPO" >&2
  exit 1
fi

# Validate that all duplicate issues exist
for dup in "${DUPLICATES[@]}"; do
  if ! gh issue view "$dup" --repo "$REPO" &>/dev/null; then
    echo "Error: issue #$dup does not exist in $REPO" >&2
    exit 1
  fi
done

# Build comment body
COUNT=${#DUPLICATES[@]}
if [[ $COUNT -eq 1 ]]; then
  HEADER="Found 1 possible duplicate issue:"
else
  HEADER="Found $COUNT possible duplicate issues:"
fi

BODY="$HEADER"$'\n\n'
INDEX=1
for dup in "${DUPLICATES[@]}"; do
  BODY+="$INDEX. https://github.com/$REPO/issues/$dup"$'\n'
  ((INDEX++))
done

BODY+=$'\n'"This issue will be automatically closed as a duplicate in 3 days."$'\n\n'
BODY+="- If your issue is a duplicate, please close it and 👍 the existing issue instead"$'\n'
BODY+="- To prevent auto-closure, 👎 this comment"$'\n\n'
BODY+="🤖 Generated with [Codex](https://openai.com/codex)"

# Post the comment
gh issue comment "$BASE_ISSUE" --repo "$REPO" --body "$BODY"

echo "Posted duplicate comment on issue #$BASE_ISSUE"
