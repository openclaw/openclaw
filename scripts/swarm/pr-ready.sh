#!/usr/bin/env bash
set -euo pipefail
PR="${1:?PR number required}"

FILES=$(gh pr view "$PR" --json files --jq '.files[].path')
if echo "$FILES" | grep -E '\.(tsx|jsx|css|scss|html|vue)$' >/dev/null; then
  BODY=$(gh pr view "$PR" --json body --jq '.body')
  if ! echo "$BODY" | grep -Eiq '(screenshot|截图|image)' ; then
    echo "UI change detected but screenshot evidence missing"
    exit 2
  fi
fi

echo "PR gate passed"
