#!/usr/bin/env bash
# vm-preflight.sh — Validate that the environment is ready for OpenClaw.
# Read-only: no modifications, no installs.
# Exit 0 if all checks pass, 1 if any fail.

set -uo pipefail

REQUIRED_NODE_FULL="22.12.0"
REQUIRED_PNPM_MAJOR=10

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { printf "${GREEN}[PASS]${RESET} %s\n" "$*"; }
fail() { printf "${RED}[FAIL]${RESET} %s\n" "$*"; }

failures=0

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  local IFS=.
  local i a=($1) b=($2)
  for ((i = 0; i < ${#b[@]}; i++)); do
    local av="${a[i]:-0}" bv="${b[i]:-0}"
    if ((av > bv)); then return 0; fi
    if ((av < bv)); then return 1; fi
  done
  return 0
}

printf "${BOLD}OpenClaw Preflight Checks${RESET}\n\n"

# 1. git
if command -v git &>/dev/null; then
  pass "git installed ($(git --version))"
else
  fail "git not found"
  failures=$((failures + 1))
fi

# 2. Node version
if command -v node &>/dev/null; then
  node_ver="$(node --version | sed 's/^v//')"
  if version_gte "$node_ver" "$REQUIRED_NODE_FULL"; then
    pass "node v$node_ver (>=$REQUIRED_NODE_FULL)"
  else
    fail "node v$node_ver is below required >=$REQUIRED_NODE_FULL"
    failures=$((failures + 1))
  fi
else
  fail "node not found"
  failures=$((failures + 1))
fi

# 3. pnpm version
if command -v pnpm &>/dev/null; then
  pnpm_ver="$(pnpm --version)"
  pnpm_major="${pnpm_ver%%.*}"
  if [[ "$pnpm_major" -ge "$REQUIRED_PNPM_MAJOR" ]]; then
    pass "pnpm $pnpm_ver (>=${REQUIRED_PNPM_MAJOR}.0.0)"
  else
    fail "pnpm $pnpm_ver is below required >=${REQUIRED_PNPM_MAJOR}.0.0"
    failures=$((failures + 1))
  fi
else
  fail "pnpm not found"
  failures=$((failures + 1))
fi

# 4. dist/ exists (build completed)
# Resolve relative to script location or cwd
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

if [[ -d "$repo_root/dist" ]]; then
  file_count=$(ls -1 "$repo_root/dist" | wc -l | tr -d ' ')
  pass "dist/ exists ($file_count files)"
else
  fail "dist/ directory not found — run 'pnpm build' first"
  failures=$((failures + 1))
fi

# 5. Security fixes present
if ls "$repo_root"/dist/exec-approvals-*.js &>/dev/null; then
  if grep -ql 'securityBlocked' "$repo_root"/dist/exec-approvals-*.js 2>/dev/null; then
    pass "Security fixes present (securityBlocked in exec-approvals)"
  else
    fail "securityBlocked not found in dist/exec-approvals-*.js — wrong branch?"
    failures=$((failures + 1))
  fi
else
  fail "dist/exec-approvals-*.js not found — build may be incomplete"
  failures=$((failures + 1))
fi

# Summary
printf "\n"
if [[ "$failures" -eq 0 ]]; then
  printf "${GREEN}${BOLD}All checks passed.${RESET}\n"
  exit 0
else
  printf "${RED}${BOLD}%d check(s) failed.${RESET}\n" "$failures"
  exit 1
fi
