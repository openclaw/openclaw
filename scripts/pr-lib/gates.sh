run_hosted_prepare_gates() {
  local pr="$1"
  local current_head="$2"
  local changelog_only="$3"
  local remote_head
  remote_head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  if [ "$remote_head" != "$current_head" ]; then
    echo "PR head changed before hosted gate verification (expected $current_head, got $remote_head). Re-run prepare-init."
    return 1
  fi

  local repo
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  local args=(
    scripts/verify-pr-hosted-gates.mjs
    --repo "$repo"
    --sha "$current_head"
    --output ".local/gates-hosted-checks.json"
  )
  if [ "$changelog_only" = "true" ]; then
    args+=(--changelog-only)
  fi
  run_quiet_logged "exact-head hosted CI/Testbox gates" ".local/gates-hosted-checks.log" node "${args[@]}"
}

run_prepare_push_retry_gates() {
  local docs_only="${1:-false}"

  if [ "${OPENCLAW_TESTBOX:-}" = "1" ]; then
    echo "A lease retry changed the prepared head, so its exact-head hosted evidence no longer applies."
    echo "Stop here, wait for CI/Testbox on the pushed head, then re-run prepare-run."
    return 1
  fi

  bootstrap_deps_if_needed
  run_quiet_logged "pnpm build (lease-retry)" ".local/lease-retry-build.log" pnpm build
  run_quiet_logged "pnpm check (lease-retry)" ".local/lease-retry-check.log" pnpm check
  if [ "$docs_only" != "true" ]; then
    run_quiet_logged "pnpm test (lease-retry)" ".local/lease-retry-test.log" pnpm test
  fi
}

prepare_gates() {
  local pr="$1"
  enter_worktree "$pr" false

  checkout_prep_branch "$pr"
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
  local changelog_only=false
  if [ "$changed_files" = "CHANGELOG.md" ]; then
    changelog_only=true
  fi

  local changelog_required=false
  if changelog_required_for_changed_files "$changed_files"; then
    changelog_required=true
  fi

  local has_changelog_update=false
  local unsupported_changelog_fragments=""
  local changed_path
  while IFS= read -r changed_path; do
    [ -n "$changed_path" ] || continue
    case "$changed_path" in
      CHANGELOG.md)
        has_changelog_update=true
        ;;
      changelog/fragments/*)
        unsupported_changelog_fragments="${unsupported_changelog_fragments}${changed_path}"$'\n'
        ;;
    esac
  done <<<"$changed_files"
  if [ -n "$unsupported_changelog_fragments" ]; then
    echo "Unsupported changelog fragment files detected:"
    printf '%s\n' "$unsupported_changelog_fragments"
    echo "Move changelog fragment content into CHANGELOG.md and remove changelog/fragments files."
    exit 1
  fi

  if [ "$has_changelog_update" = "true" ]; then
    normalize_pr_changelog_entries "$pr"
    validate_changelog_attribution_policy
  fi

  if [ "$changelog_required" = "true" ]; then
    local contrib="${PR_AUTHOR:-}"
    validate_changelog_merge_hygiene
    validate_changelog_entry_for_pr "$pr" "$contrib"
  else
    echo "Changelog not required for this changed-file set."
  fi

  local current_head
  current_head=$(git rev-parse HEAD)
  local previous_last_verified_head=""
  local previous_full_gates_head=""
  if [ -s .local/gates.env ]; then
    # shellcheck disable=SC1091
    source .local/gates.env
    previous_last_verified_head="${LAST_VERIFIED_HEAD_SHA:-}"
    previous_full_gates_head="${FULL_GATES_HEAD_SHA:-}"
  fi

  local gates_mode="full"
  local hosted_gates_head=""
  local reuse_gates=false
  if [ "${OPENCLAW_TESTBOX:-}" != "1" ] && [ "$docs_only" = "true" ] && [ -n "$previous_last_verified_head" ] && git merge-base --is-ancestor "$previous_last_verified_head" HEAD 2>/dev/null; then
    local delta_since_verified
    delta_since_verified=$(git diff --name-only "$previous_last_verified_head"..HEAD)
    if [ -z "$delta_since_verified" ] || file_list_is_docsish_only "$delta_since_verified"; then
      reuse_gates=true
    fi
  fi

  if [ "${OPENCLAW_TESTBOX:-}" = "1" ]; then
    gates_mode="hosted_exact_head"
    if [ "$changelog_only" = "true" ]; then
      run_quiet_logged "git diff --check" ".local/gates-diff-check.log" git diff --check origin/main...HEAD
    fi
    run_hosted_prepare_gates "$pr" "$current_head" "$changelog_only"
    hosted_gates_head="$current_head"
  elif [ "$reuse_gates" = "true" ]; then
    gates_mode="reused_docs_only"
    echo "Docs/changelog-only delta since last verified head $previous_last_verified_head; reusing prior gates."
  else
    bootstrap_deps_if_needed
    run_quiet_logged "pnpm build" ".local/gates-build.log" pnpm build
    run_quiet_logged "pnpm check" ".local/gates-check.log" pnpm check

    if [ "$docs_only" = "true" ]; then
      gates_mode="docs_only"
      echo "Docs-only change detected with high confidence; skipping pnpm test."
    else
      gates_mode="full"
      if [ -n "${OPENCLAW_VITEST_MAX_WORKERS:-}" ]; then
        echo "Running pnpm test with OPENCLAW_VITEST_MAX_WORKERS=$OPENCLAW_VITEST_MAX_WORKERS."
        run_quiet_logged \
          "pnpm test" \
          ".local/gates-test.log" \
          env OPENCLAW_VITEST_MAX_WORKERS="$OPENCLAW_VITEST_MAX_WORKERS" pnpm test
      else
        echo "Running pnpm test with host-aware scheduling defaults."
        run_quiet_logged "pnpm test" ".local/gates-test.log" pnpm test
      fi
      previous_full_gates_head="$current_head"
    fi
  fi

  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    DOCS_ONLY "$docs_only" \
    CHANGELOG_REQUIRED "$changelog_required" \
    GATES_MODE "$gates_mode" \
    LAST_VERIFIED_HEAD_SHA "$current_head" \
    FULL_GATES_HEAD_SHA "${previous_full_gates_head:-}" \
    HOSTED_GATES_HEAD_SHA "$hosted_gates_head" \
    GATES_PASSED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/gates.env

  echo "docs_only=$docs_only"
  echo "changelog_only=$changelog_only"
  echo "changelog_required=$changelog_required"
  echo "gates_mode=$gates_mode"
  echo "wrote=.local/gates.env"
}
