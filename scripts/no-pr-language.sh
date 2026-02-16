#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGETS=(
  CONTRIBUTING.md
  README.md
  real-dispatch-agile-package/README.md
  real-dispatch-agile-package/03-Delivery/00-Release-Gates.md
  real-dispatch-agile-package/03-Delivery/03-PR-Plan.md
  real-dispatch-agile-package/03-Delivery/Current-Sprint.md
  .github/workflows/ci.yml
  .github/workflows/install-smoke.yml
  .github/workflows/workflow-sanity.yml
)

BAD_PATTERN='[Pp]ull [Rr]equest|[Pp]ull-[Rr]equest|[Pp]ull_[Rr]equest|[Mm]erge [Rr]equest|\\bPR title\\b|\\bPR template\\b|\\bPR plan\\b|\\bPR-Plan\\b|\\bPR-by-PR\\b'

FAIL=0

for file in "${TARGETS[@]}"; do
  if [ ! -f "$file" ]; then
    continue
  fi

  matches=$(grep -nE "$BAD_PATTERN" "$file" || true)
  if [ -n "$matches" ]; then
    echo "PR-language policy violation in $file:"
    echo "$matches"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "Refactor the above files to use file-handoff terminology."
  exit 1
fi

echo "no-pr-language: PASS"
