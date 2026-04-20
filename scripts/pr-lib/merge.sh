is_mainline_drift_critical_path_for_merge() {
  local path="$1"
  case "$path" in
    package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|.oxlintrc.json|.oxfmtrc.json|tsconfig.json|tsconfig.*.json|vitest.config.ts|vitest.*.config.ts|scripts/*|.github/workflows/*)
      return 0
      ;;
  esac
  return 1
}

print_file_list_with_limit() {
  local label="$1"
  local file_path="$2"
  local limit="${3:-12}"

  if [ ! -s "$file_path" ]; then
    return 0
  fi

  local count
  count=$(wc -l < "$file_path" | tr -d ' ')
  echo "$label ($count):"
  sed -n "1,${limit}p" "$file_path" | sed 's/^/  - /'
  if [ "$count" -gt "$limit" ]; then
    echo "  ... +$((count - limit)) more"
  fi
}

mainline_drift_requires_sync() {
  local prep_head_sha="$1"

  require_artifact .local/pr-meta.json

  if ! git cat-file -e "${prep_head_sha}^{commit}" 2>/dev/null; then
    echo "Mainline drift relevance: prep head $prep_head_sha is missing locally; require sync."
    return 0
  fi

  local delta_file
  local pr_files_file
  local overlap_file
  local critical_file
  delta_file=$(mktemp)
  pr_files_file=$(mktemp)
  overlap_file=$(mktemp)
  critical_file=$(mktemp)

  git diff --name-only "${prep_head_sha}..origin/main" | sed '/^$/d' | sort -u > "$delta_file"
  jq -r '.files[]?.path // empty' .local/pr-meta.json | sed '/^$/d' | sort -u > "$pr_files_file"
  comm -12 "$delta_file" "$pr_files_file" > "$overlap_file" || true

  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if is_mainline_drift_critical_path_for_merge "$path"; then
      printf '%s\n' "$path" >> "$critical_file"
    fi
  done < "$delta_file"

  local delta_count
  local overlap_count
  local critical_count
  delta_count=$(wc -l < "$delta_file" | tr -d ' ')
  overlap_count=$(wc -l < "$overlap_file" | tr -d ' ')
  critical_count=$(wc -l < "$critical_file" | tr -d ' ')

  if [ "$delta_count" -eq 0 ]; then
    echo "Mainline drift relevance: unable to enumerate drift files; require sync."
    rm -f "$delta_file" "$pr_files_file" "$overlap_file" "$critical_file"
    return 0
  fi

  # When overlapping files or critical infra drift exist, check for actual merge
  # conflicts first. Overlapping files != merge conflicts; Git can auto-merge
  # in many cases, so only block when real conflicts are present.
  if [ "$overlap_count" -gt 0 ] || [ "$critical_count" -gt 0 ]; then
    local merge_base
    merge_base=$(git merge-base "$prep_head_sha" origin/main 2>/dev/null || true)
    if [ -n "$merge_base" ]; then
      local conflict_count
      conflict_count=$(git merge-tree "$merge_base" "$prep_head_sha" origin/main 2>/dev/null | grep -c "^<<<<<<<" || true)
      if [ "$conflict_count" -eq 0 ]; then
        echo "Mainline drift relevance: overlapping files detected but no merge conflicts; safe to merge without sync."
        print_file_list_with_limit "Mainline files overlapping PR touched files" "$overlap_file"
        print_file_list_with_limit "Mainline files touching merge-critical infrastructure" "$critical_file"
        rm -f "$delta_file" "$pr_files_file" "$overlap_file" "$critical_file"
        return 1
      fi
      echo "Mainline drift relevance: $conflict_count merge conflict(s) detected; sync required before merge."
    else
      echo "Mainline drift relevance: unable to compute merge base; sync required before merge."
    fi
    print_file_list_with_limit "Mainline files overlapping PR touched files" "$overlap_file"
    print_file_list_with_limit "Mainline files touching merge-critical infrastructure" "$critical_file"
    rm -f "$delta_file" "$pr_files_file" "$overlap_file" "$critical_file"
    return 0
  fi

  echo "Mainline drift relevance: no overlap with PR files and no critical infra drift."
  print_file_list_with_limit "Mainline-only drift files" "$delta_file"
  rm -f "$delta_file" "$pr_files_file" "$overlap_file" "$critical_file"
  return 1
}

merge_verify() {
  local pr="$1"
  enter_worktree "$pr" false

  require_artifact .local/prep.env
  # shellcheck disable=SC1091
  source .local/prep.env
  verify_prep_branch_matches_prepared_head "$pr" "$PREP_HEAD_SHA"

  local json
  json=$(pr_meta_json "$pr")
  local is_draft
  is_draft=$(printf '%s\n' "$json" | jq -r .isDraft)
  if [ "$is_draft" = "true" ]; then
    echo "PR is draft."
    exit 1
  fi
  local pr_head_sha
  pr_head_sha=$(printf '%s\n' "$json" | jq -r .headRefOid)

  if [ "$pr_head_sha" != "$PREP_HEAD_SHA" ]; then
    echo "PR head changed after prepare (expected $PREP_HEAD_SHA, got $pr_head_sha)."
    echo "Re-run prepare to refresh prep artifacts and gates: scripts/pr-prepare run $pr"
    echo "Note: docs/changelog-only follow-ups reuse prior gate results automatically."

    git fetch origin "pull/$pr/head" >/dev/null 2>&1 || true
    if git cat-file -e "${PREP_HEAD_SHA}^{commit}" 2>/dev/null && git cat-file -e "${pr_head_sha}^{commit}" 2>/dev/null; then
      echo "HEAD delta (expected...current):"
      git log --oneline --left-right "${PREP_HEAD_SHA}...${pr_head_sha}" | sed 's/^/  /' || true
    else
      echo "HEAD delta unavailable locally (could not resolve one of the SHAs)."
    fi
    exit 1
  fi

  gh pr checks "$pr" --required --watch --fail-fast >.local/merge-checks-watch.log 2>&1 || true
  local checks_json
  local checks_err_file
  checks_err_file=$(mktemp)
  checks_json=$(gh pr checks "$pr" --required --json name,bucket,state 2>"$checks_err_file" || true)
  rm -f "$checks_err_file"
  if [ -z "$checks_json" ]; then
    checks_json='[]'
  fi
  local required_count
  required_count=$(printf '%s\n' "$checks_json" | jq 'length')
  if [ "$required_count" -eq 0 ]; then
    echo "No required checks configured for this PR."
  fi
  printf '%s\n' "$checks_json" | jq -r '.[] | "\(.bucket)\t\(.name)\t\(.state)"'

  local failed_required
  failed_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="fail")] | length')
  local pending_required
  pending_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="pending")] | length')

  if [ "$failed_required" -gt 0 ]; then
    echo "Required checks are failing."
    exit 1
  fi

  if [ "$pending_required" -gt 0 ]; then
    echo "Required checks are still pending."
    exit 1
  fi

  git fetch origin main
  git fetch origin "pull/$pr/head:pr-$pr" --force
  if ! git merge-base --is-ancestor origin/main "pr-$pr"; then
    echo "PR branch is behind main."
    if mainline_drift_requires_sync "$PREP_HEAD_SHA"; then
      echo "Merge verify failed: mainline drift is relevant to this PR; run scripts/pr prepare-sync-head $pr before merge."
      exit 1
    fi
    echo "Merge verify: continuing without prep-head sync because behind-main drift is unrelated."
  fi

  echo "merge-verify passed for PR #$pr"
}

refresh_merge_prep_metadata() {
  local pr="$1"
  local prep_head_sha="$2"
  local pushed_from_sha="$3"
  local contrib="$4"

  local contrib_id
  contrib_id=$(gh api "users/$contrib" --jq .id)
  local coauthor_email="${contrib_id}+${contrib}@users.noreply.github.com"

  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    PR_AUTHOR "$contrib" \
    PR_URL "${PR_URL:-}" \
    PR_HEAD "$PR_HEAD" \
    PR_HEAD_SHA_BEFORE "$pushed_from_sha" \
    PREP_HEAD_SHA "$prep_head_sha" \
    COAUTHOR_EMAIL "$coauthor_email" \
    > .local/prep.env
}

run_merge_changelog_with_diagnostics() {
  local changelog_result=""
  if ! changelog_result=$(ensure_pr_changelog_entry "$@"); then
    if [ -n "$changelog_result" ]; then
      printf '%s\n' "$changelog_result" >&2
    fi
    return 1
  fi

  printf '%s\n' "$changelog_result"
}

normalize_merge_changelog_section() {
  local raw_section="${1:-Changes}"
  local normalized
  normalized=$(printf '%s' "$raw_section" | tr '[:upper:]' '[:lower:]')

  case "$normalized" in
    fixes|fix)
      printf '%s\n' "Fixes"
      ;;
    changes|change|enhancement|feature)
      printf '%s\n' "Changes"
      ;;
    *)
      echo "Unsupported changelog section override: $raw_section"
      exit 1
      ;;
  esac
}

resolve_merge_changelog_section() {
  local pr_json="$1"

  # 1. 环境变量显式覆写（最高优先级）
  if [ -n "${OPENCLAW_PR_CHANGELOG_SECTION:-}" ]; then
    normalize_merge_changelog_section "$OPENCLAW_PR_CHANGELOG_SECTION"
    return 0
  fi

  local label_names
  label_names=$(printf '%s\n' "$pr_json" | jq -r '.labels[]?.name // empty' | tr '[:upper:]' '[:lower:]')

  # 2. 标签明确为 bug/fix 系列 → Fixes
  if printf '%s\n' "$label_names" | rg -q '(^|[-_[:space:]])(bug|fix|bugfix|hotfix)([-_[:space:]]|$)'; then
    printf '%s\n' "Fixes"
    return 0
  fi

  # 3. 标签明确为 feature/enhancement → Changes
  if printf '%s\n' "$label_names" | rg -q '(^|[-_[:space:]])(feature|enhancement)([-_[:space:]]|$)'; then
    printf '%s\n' "Changes"
    return 0
  fi

  # 4. 标签没有分类信号时 fallback 到 PR 标题的 Conventional Commits 前缀
  #    仓库里大量 PR 只打 size: * 一类无关标签、靠标题 `fix:`/`feat:` 表达分类
  local pr_title_lower
  pr_title_lower=$(printf '%s\n' "$pr_json" | jq -r '.title // empty' | tr '[:upper:]' '[:lower:]')
  if [ -n "$pr_title_lower" ]; then
    # `fix`, `fix:`, `fix(scope):`, `fix!:`, `bugfix(...)`, `hotfix ...` 都视为 Fixes
    if printf '%s\n' "$pr_title_lower" | rg -q '^(fix|bugfix|hotfix)([[:space:]]*[(:!])'; then
      printf '%s\n' "Fixes"
      return 0
    fi
    if printf '%s\n' "$pr_title_lower" | rg -q '^(feat|feature|enhance|enhancement)([[:space:]]*[(:!])'; then
      printf '%s\n' "Changes"
      return 0
    fi
  fi

  # 5. 兜底默认
  printf '%s\n' "Changes"
}

write_merge_prep_log_entry() {
  local changelog_status="$1"
  cat >> .local/prep.md <<EOF_PREP
- Merge-stage changelog status: $changelog_status.
- Merge is ready to execute the deterministic gh pr merge step.
EOF_PREP
}

merge_run() {
  local pr="$1"
  enter_worktree "$pr" false

  local required
  for required in .local/review.md .local/review.json .local/prep.md .local/prep.env; do
    require_artifact "$required"
  done

  merge_verify "$pr"
  # shellcheck disable=SC1091
  source .local/prep.env

  local pr_meta_json
  pr_meta_json=$(gh pr view "$pr" --json number,title,state,isDraft,author,labels)
  local pr_title
  pr_title=$(printf '%s\n' "$pr_meta_json" | jq -r .title)
  local pr_number
  pr_number=$(printf '%s\n' "$pr_meta_json" | jq -r .number)
  local contrib
  contrib=$(printf '%s\n' "$pr_meta_json" | jq -r .author.login)
  local is_draft
  is_draft=$(printf '%s\n' "$pr_meta_json" | jq -r .isDraft)
  if [ "$is_draft" = "true" ]; then
    echo "PR is draft; stop."
    exit 1
  fi

  local reviewer
  reviewer=$(gh api user --jq .login)
  local reviewer_id
  reviewer_id=$(gh api user --jq .id)

  local contrib_coauthor_email="${COAUTHOR_EMAIL:-}"
  if [ -z "$contrib_coauthor_email" ] || [ "$contrib_coauthor_email" = "null" ]; then
    local contrib_id
    contrib_id=$(gh api "users/$contrib" --jq .id)
    contrib_coauthor_email="${contrib_id}+${contrib}@users.noreply.github.com"
  fi

  local reviewer_email_candidates=()
  local reviewer_email_candidate
  while IFS= read -r reviewer_email_candidate; do
    [ -n "$reviewer_email_candidate" ] || continue
    reviewer_email_candidates+=("$reviewer_email_candidate")
  done < <(merge_author_email_candidates "$reviewer" "$reviewer_id")
  if [ "${#reviewer_email_candidates[@]}" -eq 0 ]; then
    echo "Unable to resolve a candidate merge author email for reviewer $reviewer"
    exit 1
  fi

  local reviewer_email="${reviewer_email_candidates[0]}"
  local reviewer_coauthor_email="${reviewer_id}+${reviewer}@users.noreply.github.com"
  local changelog_preview=""

  local changelog_status="not_required"
  if [ -s .local/gates.env ]; then
    # shellcheck disable=SC1091
    source .local/gates.env
    if [ "${CHANGELOG_REQUIRED:-false}" = "true" ]; then
      changelog_status="required_pending"
    fi
  fi

  if [ "$changelog_status" = "required_pending" ]; then
    checkout_prep_branch "$pr"
    local resolved_changelog_entry
    resolved_changelog_entry=$(resolve_pr_changelog_entry "$pr" "$contrib" "$pr_title")
    local changelog_section
    changelog_section=$(resolve_merge_changelog_section "$pr_meta_json")
    changelog_preview=$(printf '%s' "$resolved_changelog_entry" | tr '\n' ' ' | sed 's/[[:space:]]\+$//')
    local changelog_result
    if ! changelog_result=$(run_merge_changelog_with_diagnostics "$pr" "$contrib" "$pr_title" "$changelog_section" "$resolved_changelog_entry"); then
      echo "Changelog validation failed during merge-run." >&2
      exit 1
    fi
    echo "$changelog_result"

    if printf '%s\n' "$changelog_result" | rg -q '^pr_changelog_changed=true$'; then
      local commit_msg
      commit_msg=$(printf '%s' "$pr_title" | sed 's/[[:space:]]\+$//')
      scripts/committer --fast "$commit_msg" CHANGELOG.md

      local prep_head_sha_before_push
      prep_head_sha_before_push=$(git rev-parse HEAD)
      local lease_sha
      lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
      local push_result_env=".local/merge-changelog-push-result.env"
      push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha_before_push" "$lease_sha" false false "$push_result_env"
      # shellcheck disable=SC1090
      source "$push_result_env"
      PREP_HEAD_SHA="$PUSH_PREP_HEAD_SHA"
      refresh_merge_prep_metadata "$pr" "$PREP_HEAD_SHA" "$PUSHED_FROM_SHA" "$contrib"
      merge_verify "$pr"
      # shellcheck disable=SC1091
      source .local/prep.env
      changelog_status="added_and_pushed"
    else
      changelog_status="already_present"
    fi
  fi

  write_merge_prep_log_entry "$changelog_status"

  cat > .local/merge-body.txt <<EOF_BODY
Merged via squash.

Prepared head SHA: $PREP_HEAD_SHA
Co-authored-by: $contrib <$contrib_coauthor_email>
Co-authored-by: $reviewer <$reviewer_coauthor_email>
Reviewed-by: @$reviewer
EOF_BODY

  delete_remote_pr_head_branch_after_merge() {
    local head_json
    head_json=$(gh pr view "$pr" --json headRefName,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify)

    local head_ref
    head_ref=$(printf '%s\n' "$head_json" | jq -r '.headRefName // ""')
    if [ -z "$head_ref" ]; then
      return 0
    fi

    local repo_owner
    repo_owner=$(printf '%s\n' "$head_json" | jq -r '.headRepositoryOwner.login // ""')
    local repo_name
    repo_name=$(printf '%s\n' "$head_json" | jq -r '.headRepository.name // ""')
    if [ -z "$repo_owner" ] || [ -z "$repo_name" ]; then
      echo "Warning: unable to resolve head repository for remote branch cleanup"
      return 0
    fi

    local encoded_ref
    encoded_ref=$(jq -rn --arg value "heads/$head_ref" '$value|@uri')
    if gh api -X DELETE "repos/$repo_owner/$repo_name/git/refs/$encoded_ref" >/dev/null 2>&1; then
      return 0
    fi

    if ! gh api "repos/$repo_owner/$repo_name/git/ref/$encoded_ref" >/dev/null 2>&1; then
      echo "Remote branch cleanup: branch already absent for $repo_owner/$repo_name:$head_ref"
      return 0
    fi

    echo "Warning: failed to delete remote branch $repo_owner/$repo_name:$head_ref"
    return 0
  }

  run_merge_with_email() {
    local email="$1"
    local merge_output_file
    merge_output_file=$(mktemp)
    if gh pr merge "$pr" \
      --squash \
      --match-head-commit "$PREP_HEAD_SHA" \
      --author-email "$email" \
      --subject "$pr_title (#$pr_number)" \
      --body-file .local/merge-body.txt \
      >"$merge_output_file" 2>&1
    then
      rm -f "$merge_output_file"
      return 0
    fi

    MERGE_ERR_MSG=$(cat "$merge_output_file")
    print_relevant_log_excerpt "$merge_output_file"
    rm -f "$merge_output_file"
    return 1
  }

  local MERGE_ERR_MSG=""
  local selected_merge_author_email="$reviewer_email"
  if ! run_merge_with_email "$selected_merge_author_email"; then
    if is_author_email_merge_error "$MERGE_ERR_MSG" && [ "${#reviewer_email_candidates[@]}" -ge 2 ]; then
      selected_merge_author_email="${reviewer_email_candidates[1]}"
      echo "Retrying merge once with fallback author email: $selected_merge_author_email"
      run_merge_with_email "$selected_merge_author_email" || {
        echo "Merge failed after fallback retry."
        exit 1
      }
    else
      echo "Merge failed."
      exit 1
    fi
  fi

  local state
  state=$(gh pr view "$pr" --json state --jq .state)
  if [ "$state" != "MERGED" ]; then
    echo "Merge not finalized yet (state=$state), waiting up to 15 minutes..."
    local i
    for i in $(seq 1 90); do
      sleep 10
      state=$(gh pr view "$pr" --json state --jq .state)
      if [ "$state" = "MERGED" ]; then
        break
      fi
    done
  fi

  if [ "$state" != "MERGED" ]; then
    echo "PR state is $state after waiting."
    exit 1
  fi

  local merge_sha
  merge_sha=$(gh pr view "$pr" --json mergeCommit --jq '.mergeCommit.oid')
  if [ -z "$merge_sha" ] || [ "$merge_sha" = "null" ]; then
    echo "Merge commit SHA missing."
    exit 1
  fi
  local repo_nwo
  repo_nwo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

  local merge_sha_url=""
  if gh api repos/:owner/:repo/commits/"$merge_sha" >/dev/null 2>&1; then
    merge_sha_url="https://github.com/$repo_nwo/commit/$merge_sha"
  else
    echo "Merge commit is not resolvable via repository commit endpoint: $merge_sha"
    exit 1
  fi

  local prep_sha_url=""
  if gh api repos/:owner/:repo/commits/"$PREP_HEAD_SHA" >/dev/null 2>&1; then
    prep_sha_url="https://github.com/$repo_nwo/commit/$PREP_HEAD_SHA"
  else
    local pr_commit_count
    pr_commit_count=$(gh pr view "$pr" --json commits --jq "[.commits[].oid | select(. == \"$PREP_HEAD_SHA\")] | length")
    if [ "${pr_commit_count:-0}" -gt 0 ]; then
      prep_sha_url="https://github.com/$repo_nwo/pull/$pr/commits/$PREP_HEAD_SHA"
    fi
  fi
  if [ -z "$prep_sha_url" ]; then
    echo "Prepared head SHA is not resolvable in repo commits or PR commit list: $PREP_HEAD_SHA"
    exit 1
  fi

  local commit_body
  commit_body=$(gh api repos/:owner/:repo/commits/"$merge_sha" --jq .commit.message)
  printf '%s\n' "$commit_body" | rg -q "^Co-authored-by: $contrib <" || { echo "Missing PR author co-author trailer"; exit 1; }
  printf '%s\n' "$commit_body" | rg -q "^Co-authored-by: $reviewer <" || { echo "Missing reviewer co-author trailer"; exit 1; }

  local ok=0
  local comment_output=""
  local attempt
  for attempt in 1 2 3; do
    if comment_output=$(gh pr comment "$pr" -F - 2>&1 <<EOF_COMMENT
Merged via squash.

- Prepared head SHA: [$PREP_HEAD_SHA]($prep_sha_url)
- Merge commit: [$merge_sha]($merge_sha_url)

Thanks @$contrib!
EOF_COMMENT
); then
      ok=1
      break
    fi
    sleep 2
  done
  [ "$ok" -eq 1 ] || { echo "Failed to post PR comment after retries"; exit 1; }

  local comment_url=""
  comment_url=$(printf '%s\n' "$comment_output" | rg -o 'https://github.com/[^ ]+/pull/[0-9]+#issuecomment-[0-9]+' -m1 || true)
  if [ -z "$comment_url" ]; then
    comment_url="unresolved"
  fi

  local root
  root=$(repo_root)
  cd "$root"
  delete_remote_pr_head_branch_after_merge
  remove_worktree_if_present ".worktrees/pr-$pr"
  delete_local_branch_if_safe "temp/pr-$pr"
  delete_local_branch_if_safe "pr-$pr"
  delete_local_branch_if_safe "pr-$pr-prep"

  local pr_url
  pr_url=$(gh pr view "$pr" --json url --jq .url)

  echo "merge-run complete for PR #$pr"
  echo "merge commit: $merge_sha"
  echo "merge author email: $selected_merge_author_email"
  echo "completion comment: $comment_url"
  echo "$pr_url"
}
