#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/autofix-pr.sh"

extract_function() {
  local fn="$1"
  sed -n "/^${fn}()[[:space:]]*{/,/^}/p" "$SCRIPT_PATH"
}

fail() {
  echo "FAIL: $*"
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  [[ "$expected" == "$actual" ]] || fail "$msg (expected: '$expected'; got: '$actual')"
}

PR_TITLE_PREFIX="[OPENCLAW-SRE]"
eval "$(extract_function ensure_pr_title_prefix)"

assert_eq "[OPENCLAW-SRE] Fix flaky auth fallback" \
  "$(ensure_pr_title_prefix "Fix flaky auth fallback")" \
  "adds prefix for plain title"
echo "PASS: adds prefix for plain title"

assert_eq "[OPENCLAW-SRE] Fix flaky auth fallback" \
  "$(ensure_pr_title_prefix "[OPENCLAW-SRE] Fix flaky auth fallback")" \
  "keeps already-prefixed title stable"
echo "PASS: keeps already-prefixed title stable"

assert_eq "[OPENCLAW-SRE] Fix flaky auth fallback" \
  "$(ensure_pr_title_prefix " [openclaw-sre]   Fix flaky auth fallback ")" \
  "normalizes mixed-case prefix and trims whitespace"
echo "PASS: normalizes mixed-case prefix and whitespace"

assert_eq "[OPENCLAW-SRE]" \
  "$(ensure_pr_title_prefix "   ")" \
  "empty title normalizes to prefix only"
echo "PASS: empty title => prefix only"

echo "All autofix-pr title prefix tests passed."
