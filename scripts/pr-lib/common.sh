require_artifact() {
  local path="$1"
  if [ ! -s "$path" ]; then
    echo "Missing required artifact: $path"
    exit 1
  fi
}

path_is_docsish() {
  local path="$1"
  case "$path" in
    CHANGELOG.md|AGENTS.md|CLAUDE.md|README*.md|docs/*|*.md|*.mdx|mintlify.json|docs.json)
      return 0
      ;;
  esac
  return 1
}

path_is_testish() {
  local path="$1"
  case "$path" in
    *__tests__/*|*.test.*|*.spec.*|test/*|tests/*)
      return 0
      ;;
  esac
  return 1
}

path_is_maintainer_workflow_only() {
  local path="$1"
  case "$path" in
    .agents/*|scripts/pr|scripts/pr-*|docs/subagent.md)
      return 0
      ;;
  esac
  return 1
}

file_list_is_docsish_only() {
  local files="$1"
  local saw_any=false
  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    saw_any=true
    if ! path_is_docsish "$path"; then
      return 1
    fi
  done <<<"$files"

  [ "$saw_any" = "true" ]
}

changelog_required_for_changed_files() {
  local files="$1"
  local saw_any=false
  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    saw_any=true
    if path_is_docsish "$path" || path_is_testish "$path" || path_is_maintainer_workflow_only "$path"; then
      continue
    fi
    return 0
  done <<<"$files"

  if [ "$saw_any" = "false" ]; then
    return 1
  fi

  return 1
}

print_review_stdout_summary() {
  require_artifact .local/review.md
  require_artifact .local/review.json

  local recommendation
  recommendation=$(jq -r '.recommendation // ""' .local/review.json)
  local finding_count
  finding_count=$(jq '[.findings[]?] | length' .local/review.json)

  echo "review summary:"
  echo "recommendation: $recommendation"
  echo "findings: $finding_count"
  cat .local/review.md
}

print_relevant_log_excerpt() {
  local log_file="$1"
  if [ ! -s "$log_file" ]; then
    echo "(no output captured)"
    return 0
  fi

  local filtered_log
  filtered_log=$(mktemp)
  if rg -n -i 'error|err|failed|fail|fatal|panic|exception|TypeError|ReferenceError|SyntaxError|ELIFECYCLE|ERR_' "$log_file" >"$filtered_log"; then
    echo "Relevant log lines:"
    tail -n 120 "$filtered_log"
  else
    echo "No focused error markers found; showing last 120 lines:"
    tail -n 120 "$log_file"
  fi
  rm -f "$filtered_log"
}

print_unrelated_gate_failure_guidance() {
  local label="$1"
  case "$label" in
    pnpm\ build*|pnpm\ check*|pnpm\ test*)
      cat <<'EOF_GUIDANCE'
If this local gate failure already reproduces on latest origin/main and is clearly unrelated to the PR:
- treat it as baseline repo noise
- document it explicitly
- report the scoped verification that validates the PR itself
- do not use this to ignore plausibly related failures
EOF_GUIDANCE
      ;;
  esac
}

run_quiet_logged() {
  local label="$1"
  local log_file="$2"
  shift 2

  mkdir -p .local
  if "$@" >"$log_file" 2>&1; then
    echo "$label passed"
    return 0
  fi

  echo "$label failed (log: $log_file)"
  print_relevant_log_excerpt "$log_file"
  print_unrelated_gate_failure_guidance "$label"
  return 1
}

bootstrap_deps_if_needed() {
  if [ ! -x node_modules/.bin/vitest ]; then
    run_quiet_logged "pnpm install --frozen-lockfile" ".local/bootstrap-install.log" pnpm install --frozen-lockfile
  fi
}

wait_for_pr_head_sha() {
  local pr="$1"
  local expected_sha="$2"
  local max_attempts="${3:-6}"
  local sleep_seconds="${4:-2}"

  local attempt
  for attempt in $(seq 1 "$max_attempts"); do
    local observed_sha
    observed_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
    if [ "$observed_sha" = "$expected_sha" ]; then
      return 0
    fi

    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep "$sleep_seconds"
    fi
  done

  return 1
}

is_author_email_merge_error() {
  local msg="$1"
  printf '%s\n' "$msg" | rg -qi 'author.?email|email.*associated|associated.*email|invalid.*email'
}

merge_author_email_candidates() {
  local reviewer="$1"
  local reviewer_id="$2"

  local gh_email
  gh_email=$(gh api user --jq '.email // ""' 2>/dev/null || true)
  local git_email
  git_email=$(git config user.email 2>/dev/null || true)

  printf '%s\n' \
    "$gh_email" \
    "$git_email" \
    "${reviewer_id}+${reviewer}@users.noreply.github.com" \
    "${reviewer}@users.noreply.github.com" | awk 'NF && !seen[$0]++'
}
