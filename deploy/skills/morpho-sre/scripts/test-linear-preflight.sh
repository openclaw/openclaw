#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-linear-preflight.sh
source "${SCRIPT_DIR}/lib-linear-preflight.sh"

PASS_COUNT=0
LOOKUP_MODE="all_ok"
LOOKUP_CALLS_FILE="$(mktemp)"
trap 'rm -f "$LOOKUP_CALLS_FILE"' EXIT

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  [[ "$expected" == "$actual" ]] || fail "$msg (expected: $expected; got: $actual)"
}

linear_lookup() {
  printf '1\n' >>"$LOOKUP_CALLS_FILE"
  local kind="$1"
  local name="$2"

  case "$LOOKUP_MODE" in
    api_down)
      return 2
      ;;
    missing_required)
      if [[ "$kind" == "project" ]]; then
        return 3
      fi
      ;;
    missing_optional)
      if [[ "$kind" == "label" && "$name" == "Security" ]]; then
        return 3
      fi
      ;;
  esac

  case "$kind:$name" in
    team:Platform) printf 'team-1\n' ;;
    project:\[PLATFORM\]\ Backlog) printf 'project-1\n' ;;
    user:florian) printf 'user-1\n' ;;
    label:Bug) printf 'label-bug\n' ;;
    label:Monitoring) printf 'label-monitoring\n' ;;
    label:ai-ready) printf 'label-ai-ready\n' ;;
    label:Security) printf 'label-security\n' ;;
    label:Alerting) printf 'label-alerting\n' ;;
    label:Devops) printf 'label-devops\n' ;;
    label:Technical\ debt) printf 'label-tech-debt\n' ;;
    label:Improvement) printf 'label-improvement\n' ;;
    *) return 3 ;;
  esac
}

reset_case() {
  : >"$LOOKUP_CALLS_FILE"
  LOOKUP_MODE="all_ok"
  linear_preflight_reset_cache
  LINEAR_PREFLIGHT_RETRY_SECONDS=300
  LINEAR_PREFLIGHT_TEAM_NAME="Platform"
  LINEAR_PREFLIGHT_PROJECT_NAME="[PLATFORM] Backlog"
  LINEAR_PREFLIGHT_ASSIGNEE_NAME="florian"
  LINEAR_PREFLIGHT_REQUIRED_LABELS="Bug|Monitoring"
  LINEAR_PREFLIGHT_OPTIONAL_LABELS="ai-ready|Security|Alerting"
}

lookup_calls() {
  wc -l <"$LOOKUP_CALLS_FILE" | tr -d ' '
}

reset_case
linear_preflight_run 1000
assert_eq "true" "$LINEAR_AVAILABLE" "preflight available"
assert_eq "team-1" "$LINEAR_PREFLIGHT_TEAM_ID" "team id"
assert_eq "project-1" "$LINEAR_PREFLIGHT_PROJECT_ID" "project id"
assert_eq "user-1" "$LINEAR_PREFLIGHT_ASSIGNEE_ID" "assignee id"
assert_eq "label-bug|label-monitoring" "$LINEAR_PREFLIGHT_REQUIRED_LABEL_IDS" "required labels"
pass "resolve required entities"

reset_case
LOOKUP_MODE="missing_required"
linear_preflight_run 1000
assert_eq "false" "$LINEAR_AVAILABLE" "missing required sets unavailable"
[[ "$LINEAR_PREFLIGHT_LAST_ERROR" == *"project"* ]] || fail "missing required project error"
pass "missing required entity degrades"

reset_case
LOOKUP_MODE="missing_optional"
linear_preflight_run 1000
assert_eq "true" "$LINEAR_AVAILABLE" "optional missing should not block"
[[ "$LINEAR_PREFLIGHT_WARNINGS" == *"Security"* ]] || fail "missing optional warning"
pass "missing optional label warning"

reset_case
LOOKUP_MODE="api_down"
linear_preflight_run 1000
assert_eq "false" "$LINEAR_AVAILABLE" "api unavailable degrades"
pass "api unavailable graceful degradation"

reset_case
LOOKUP_MODE="api_down"
linear_preflight_run 1000
CALLS_AFTER_FIRST="$(lookup_calls)"
linear_preflight_run 1100
assert_eq "$CALLS_AFTER_FIRST" "$(lookup_calls)" "retry throttle within 5m"
linear_preflight_run 1405
[[ "$(lookup_calls)" -gt "$CALLS_AFTER_FIRST" ]] || fail "retry should happen after throttle window"
pass "retry throttle"

reset_case
linear_preflight_run 1000
CALLS_CACHED="$(lookup_calls)"
linear_preflight_run 1020
assert_eq "$CALLS_CACHED" "$(lookup_calls)" "cache valid for pod lifetime"
pass "cache valid for pod lifetime"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
