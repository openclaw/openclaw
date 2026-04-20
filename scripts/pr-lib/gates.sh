normalize_prepare_gate_key() {
  local gate="$1"
  case "$gate" in
    build|check|test)
      printf '%s\n' "$gate"
      ;;
    *)
      echo "Unsupported gate '$gate'. Expected one of: build, check, test."
      exit 2
      ;;
  esac
}

prepare_gate_ack_file() {
  printf '.local/gates-ack.json\n'
}

prepare_ack_unrelated() {
  local pr="$1"
  local gate
  gate=$(normalize_prepare_gate_key "$2")
  local reason="$3"
  local scoped_verification="${4:-}"

  enter_worktree "$pr" false
  checkout_prep_branch "$pr"

  local head_sha
  head_sha=$(git rev-parse HEAD)
  local ack_file
  ack_file=$(prepare_gate_ack_file)
  mkdir -p .local
  if [ ! -f "$ack_file" ]; then
    printf '[]\n' > "$ack_file"
  fi

  local tmp_file
  tmp_file=$(mktemp)
  jq \
    --arg gate "$gate" \
    --arg head_sha "$head_sha" \
    --arg reason "$reason" \
    --arg scoped_verification "$scoped_verification" \
    --arg acknowledged_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '
      [ .[]
        | select(.gate != $gate or .head_sha != $head_sha)
      ] + [
        {
          gate: $gate,
          head_sha: $head_sha,
          reason: $reason,
          scoped_verification: $scoped_verification,
          acknowledged_at: $acknowledged_at
        }
      ]
    ' "$ack_file" > "$tmp_file"
  mv "$tmp_file" "$ack_file"

  echo "Recorded unrelated baseline gate acknowledgement."
  echo "gate=$gate"
  echo "head_sha=$head_sha"
  echo "reason=$reason"
  if [ -n "$scoped_verification" ]; then
    echo "scoped_verification=$scoped_verification"
  fi
  echo "wrote=$ack_file"
}

prepare_gate_ack_summary() {
  local gate="$1"
  local head_sha="$2"
  local ack_file
  ack_file=$(prepare_gate_ack_file)

  if [ ! -s "$ack_file" ]; then
    return 1
  fi

  jq -r \
    --arg gate "$gate" \
    --arg head_sha "$head_sha" \
    '
      first(
        .[]
        | select(.gate == $gate and .head_sha == $head_sha)
        | [(.reason // ""), (.scoped_verification // "")]
        | map(select(length > 0))
        | join(" | ")
      ) // empty
    ' "$ack_file"
}

prepare_gate_is_acknowledged_for_head() {
  local gate="$1"
  local head_sha="$2"
  local ack_file
  ack_file=$(prepare_gate_ack_file)

  if [ ! -s "$ack_file" ]; then
    return 1
  fi

  jq -e \
    --arg gate "$gate" \
    --arg head_sha "$head_sha" \
    'any(.[]; .gate == $gate and .head_sha == $head_sha)' \
    "$ack_file" >/dev/null
}

run_prepare_gate_with_ack() {
  local pr="$1"
  local gate="$2"
  local head_sha="$3"
  local label="$4"
  local log_file="$5"
  shift 5

  PREPARE_GATE_LAST_STATUS=""
  if prepare_gate_is_acknowledged_for_head "$gate" "$head_sha"; then
    PREPARE_GATE_LAST_STATUS="acknowledged_baseline"
    echo "$label acknowledged as unrelated baseline noise for head $head_sha"
    local ack_summary
    ack_summary=$(prepare_gate_ack_summary "$gate" "$head_sha" || true)
    if [ -n "$ack_summary" ]; then
      echo "ack=$ack_summary"
    fi
    return 0
  fi

  if run_quiet_logged "$label" "$log_file" "$@"; then
    PREPARE_GATE_LAST_STATUS="passed"
    return 0
  fi

  echo "To acknowledge this as unrelated baseline noise for the current prep head, run:"
  echo "  scripts/pr prepare-ack-unrelated $pr $gate \"reason\" \"scoped verification\""
  return 1
}

run_prepare_push_retry_gates() {
  local docs_only="${1:-false}"

  bootstrap_deps_if_needed
  run_quiet_logged "pnpm build (lease-retry)" ".local/lease-retry-build.log" pnpm build
  run_quiet_logged "pnpm check (lease-retry)" ".local/lease-retry-check.log" pnpm check
  if [ "$docs_only" != "true" ]; then
    if [ "${OPENCLAW_GATES_FULL_TEST:-}" = "1" ]; then
      run_quiet_logged "pnpm test (lease-retry)" ".local/lease-retry-test.log" pnpm test
    else
      run_quiet_logged "pnpm test --changed (lease-retry)" ".local/lease-retry-test.log" pnpm test -- --changed origin/main
    fi
  fi
}

prepare_gates() {
  local pr="$1"
  enter_worktree "$pr" false

  checkout_prep_branch "$pr"
  bootstrap_deps_if_needed
  require_artifact .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/pr-meta.env

  local changed_files
  changed_files=$(git diff --name-only origin/main...HEAD)
  local non_docs
  non_docs=$(printf '%s\n' "$changed_files" | while IFS= read -r path; do
    [ -n "$path" ] || continue
    if ! path_is_docsish "$path"; then
      printf '%s\n' "$path"
    fi
  done)

  local docs_only=false
  if [ -n "$changed_files" ] && [ -z "$non_docs" ]; then
    docs_only=true
  fi

  local changelog_required=false
  if changelog_required_for_changed_files "$changed_files"; then
    changelog_required=true
  fi

  local has_changelog_update=false
  if printf '%s\n' "$changed_files" | rg -q '^CHANGELOG\.md$'; then
    has_changelog_update=true
  fi

  local unsupported_changelog_fragments
  unsupported_changelog_fragments=$(printf '%s\n' "$changed_files" | rg '^changelog/fragments/' || true)
  if [ -n "$unsupported_changelog_fragments" ]; then
    echo "Unsupported changelog fragment files detected:"
    printf '%s\n' "$unsupported_changelog_fragments"
    echo "Move changelog fragment content into CHANGELOG.md and remove changelog/fragments files."
    exit 1
  fi

  if [ "$has_changelog_update" = "true" ]; then
    normalize_pr_changelog_entries "$pr"
  fi

  if [ "$has_changelog_update" = "true" ]; then
    local contrib="${PR_AUTHOR:-}"
    validate_changelog_merge_hygiene
    validate_changelog_entry_for_pr "$pr" "$contrib"
  elif [ "$changelog_required" = "true" ]; then
    echo "Changelog will be required before merge, but prepare no longer blocks on adding it now."
  else
    echo "Changelog not required for this changed-file set."
  fi

  local current_head
  current_head=$(git rev-parse HEAD)
  local previous_last_verified_head=""
  local previous_full_gates_head=""
  local previous_build_gate_status=""
  local previous_check_gate_status=""
  local previous_test_gate_status=""
  if [ -s .local/gates.env ]; then
    # shellcheck disable=SC1091
    source .local/gates.env
    previous_last_verified_head="${LAST_VERIFIED_HEAD_SHA:-}"
    previous_full_gates_head="${FULL_GATES_HEAD_SHA:-}"
    previous_build_gate_status="${BUILD_GATE_STATUS:-}"
    previous_check_gate_status="${CHECK_GATE_STATUS:-}"
    previous_test_gate_status="${TEST_GATE_STATUS:-}"
  fi

  local gates_mode="full"
  local reuse_gates=false
  local build_gate_status=""
  local check_gate_status=""
  local test_gate_status=""
  if [ "$docs_only" = "true" ] && [ -n "$previous_last_verified_head" ] && git merge-base --is-ancestor "$previous_last_verified_head" HEAD 2>/dev/null; then
    local delta_since_verified
    delta_since_verified=$(git diff --name-only "$previous_last_verified_head"..HEAD)
    if [ -z "$delta_since_verified" ] || file_list_is_docsish_only "$delta_since_verified"; then
      reuse_gates=true
    fi
  fi

  if [ "$reuse_gates" = "true" ]; then
    gates_mode="reused_docs_only"
    build_gate_status="${previous_build_gate_status:-reused_previous}"
    check_gate_status="${previous_check_gate_status:-reused_previous}"
    test_gate_status="${previous_test_gate_status:-reused_docs_only}"
    echo "Docs/changelog-only delta since last verified head $previous_last_verified_head; reusing prior gates."
  else
    run_prepare_gate_with_ack "$pr" build "$current_head" "pnpm build" ".local/gates-build.log" pnpm build
    build_gate_status="$PREPARE_GATE_LAST_STATUS"

    run_prepare_gate_with_ack "$pr" check "$current_head" "pnpm check" ".local/gates-check.log" pnpm check
    check_gate_status="$PREPARE_GATE_LAST_STATUS"

    if [ "$docs_only" = "true" ]; then
      gates_mode="docs_only"
      test_gate_status="skipped_docs_only"
      echo "Docs-only change detected with high confidence; skipping pnpm test."
    else
      local test_args=(pnpm test)
      if [ "${OPENCLAW_GATES_FULL_TEST:-}" != "1" ]; then
        test_args+=(-- --changed origin/main)
        gates_mode="changed"
        echo "Running pnpm test --changed origin/main (set OPENCLAW_GATES_FULL_TEST=1 to force full suite)."
      else
        gates_mode="full"
        echo "Running full pnpm test (OPENCLAW_GATES_FULL_TEST=1)."
      fi
      if [ -n "${OPENCLAW_VITEST_MAX_WORKERS:-}" ]; then
        run_prepare_gate_with_ack \
          "$pr" \
          test \
          "$current_head" \
          "pnpm test" \
          ".local/gates-test.log" \
          env OPENCLAW_VITEST_MAX_WORKERS="$OPENCLAW_VITEST_MAX_WORKERS" "${test_args[@]}"
      else
        run_prepare_gate_with_ack \
          "$pr" \
          test \
          "$current_head" \
          "pnpm test" \
          ".local/gates-test.log" \
          "${test_args[@]}"
      fi
      test_gate_status="$PREPARE_GATE_LAST_STATUS"
      previous_full_gates_head="$current_head"
    fi
  fi

  if [ "$build_gate_status" = "acknowledged_baseline" ] || [ "$check_gate_status" = "acknowledged_baseline" ] || [ "$test_gate_status" = "acknowledged_baseline" ]; then
    gates_mode="${gates_mode}_with_acknowledged_baseline"
  fi

  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    DOCS_ONLY "$docs_only" \
    CHANGELOG_REQUIRED "$changelog_required" \
    GATES_MODE "$gates_mode" \
    BUILD_GATE_STATUS "$build_gate_status" \
    CHECK_GATE_STATUS "$check_gate_status" \
    TEST_GATE_STATUS "$test_gate_status" \
    LAST_VERIFIED_HEAD_SHA "$current_head" \
    FULL_GATES_HEAD_SHA "${previous_full_gates_head:-}" \
    GATES_PASSED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/gates.env

  echo "docs_only=$docs_only"
  echo "changelog_required=$changelog_required"
  echo "gates_mode=$gates_mode"
  echo "build_gate_status=$build_gate_status"
  echo "check_gate_status=$check_gate_status"
  echo "test_gate_status=$test_gate_status"
  echo "wrote=.local/gates.env"
}
