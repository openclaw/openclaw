repo_root() {
  # Resolve canonical repository root from git common-dir so wrappers work
  # the same from main checkout or any linked worktree.
  local base_dir
  local common_git_dir
  base_dir="${script_parent_dir:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

  if common_git_dir=$(git -C "$base_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    (cd "$(dirname "$common_git_dir")" && pwd)
    return
  fi

  # Fallback for environments where git common-dir is unavailable.
  (cd "$base_dir/.." && pwd)
}

enter_worktree() {
  local pr="$1"
  local reset_to_main="${2:-false}"
  local invoke_cwd
  invoke_cwd="$PWD"
  local root
  root=$(repo_root)

  if [ "$invoke_cwd" != "$root" ]; then
    echo "Detected non-root invocation cwd=$invoke_cwd, using canonical root $root"
  fi

  cd "$root"
  gh auth status >/dev/null
  git fetch origin main

  local dir=".worktrees/pr-$pr"
  if [ -d "$dir" ]; then
    cd "$dir"
    git fetch origin main
    if [ "$reset_to_main" = "true" ]; then
      git checkout -B "temp/pr-$pr" origin/main
    fi
  else
    git worktree add "$dir" -b "temp/pr-$pr" origin/main
    cd "$dir"
  fi

  mkdir -p .local
}

pr_meta_json() {
  local pr="$1"
  gh pr view "$pr" --json number,title,state,isDraft,author,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,url,body,labels,assignees,reviewRequests,files,additions,deletions,statusCheckRollup
}

write_pr_meta_files() {
  local json="$1"

  printf '%s\n' "$json" > .local/pr-meta.json

  cat > .local/pr-meta.env <<EOF_ENV
PR_NUMBER=$(printf '%s\n' "$json" | jq -r .number)
PR_URL=$(printf '%s\n' "$json" | jq -r .url)
PR_AUTHOR=$(printf '%s\n' "$json" | jq -r .author.login)
PR_BASE=$(printf '%s\n' "$json" | jq -r .baseRefName)
PR_HEAD=$(printf '%s\n' "$json" | jq -r .headRefName)
PR_HEAD_SHA=$(printf '%s\n' "$json" | jq -r .headRefOid)
PR_HEAD_REPO=$(printf '%s\n' "$json" | jq -r .headRepository.nameWithOwner)
PR_HEAD_REPO_URL=$(printf '%s\n' "$json" | jq -r '.headRepository.url // ""')
PR_HEAD_OWNER=$(printf '%s\n' "$json" | jq -r '.headRepositoryOwner.login // ""')
PR_HEAD_REPO_NAME=$(printf '%s\n' "$json" | jq -r '.headRepository.name // ""')
EOF_ENV
}

list_pr_worktrees() {
  local root
  root=$(repo_root)
  cd "$root"

  local dir
  local found=false
  for dir in .worktrees/pr-*; do
    [ -d "$dir" ] || continue
    found=true
    local pr
    if ! pr=$(pr_number_from_worktree_dir "$dir"); then
      printf 'UNKNOWN\t%s\tUNKNOWN\t(unparseable)\t\n' "$dir"
      continue
    fi
    local info
    info=$(gh pr view "$pr" --json state,title,url --jq '[.state, .title, .url] | @tsv' 2>/dev/null || printf 'UNKNOWN\t(unavailable)\t')
    printf '%s\t%s\t%s\n' "$pr" "$dir" "$info"
  done

  if [ "$found" = "false" ]; then
    echo "No PR worktrees found."
  fi
}

gc_pr_worktrees() {
  local dry_run="${1:-false}"
  local root
  root=$(repo_root)
  cd "$root"

  local dir
  local removed=0
  for dir in .worktrees/pr-*; do
    [ -d "$dir" ] || continue
    local pr
    if ! pr=$(pr_number_from_worktree_dir "$dir"); then
      echo "skipping $dir (could not parse PR number)"
      continue
    fi
    local state
    state=$(gh pr view "$pr" --json state --jq .state 2>/dev/null || printf 'UNKNOWN')
    case "$state" in
      MERGED|CLOSED)
        if [ "$dry_run" = "true" ]; then
          echo "would remove $dir (PR #$pr state=$state)"
        else
          git worktree remove "$dir" --force
          git branch -D "temp/pr-$pr" 2>/dev/null || true
          git branch -D "pr-$pr" 2>/dev/null || true
          git branch -D "pr-$pr-prep" 2>/dev/null || true
          echo "removed $dir (PR #$pr state=$state)"
        fi
        removed=$((removed + 1))
        ;;
    esac
  done

  if [ "$removed" -eq 0 ]; then
    if [ "$dry_run" = "true" ]; then
      echo "No merged/closed PR worktrees eligible for removal."
    else
      echo "No merged/closed PR worktrees removed."
    fi
  fi
}

pr_number_from_worktree_dir() {
  local dir="$1"
  local token
  token="${dir##*/pr-}"
  token="${token%%[^0-9]*}"
  if [ -n "$token" ]; then
    printf '%s\n' "$token"
    return 0
  fi
  return 1
}
