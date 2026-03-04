#!/usr/bin/env bash
# =============================================================================
# scripts/mb-sync-upstream.sh — MaxBot upstream sync (fail-closed)
#
# Security model:
# - Stage merge in an isolated git worktree branch.
# - Auto-resolve ONLY MB-protected files (keep ours).
# - Any other conflict => hard stop (no union merge, no auto-mutation).
# - Promote staged result only via fast-forward.
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${BLUE}${BOLD}[mb-sync]${RESET} $*"; }
ok()   { echo -e "${GREEN}${BOLD}[mb-sync] ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}${BOLD}[mb-sync] ⚠${RESET} $*"; }
fail() { echo -e "${RED}${BOLD}[mb-sync] ✗${RESET} $*" >&2; }
die()  { fail "$*"; exit 1; }
hr()   { echo -e "${BOLD}────────────────────────────────────────────────────${RESET}"; }

DRY_RUN=false
SKIP_LINT=false
DEPLOY=false
KEEP_STAGE_ON_FAIL=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-lint) SKIP_LINT=true ;;
    --deploy) DEPLOY=true ;;
    --keep-stage-on-fail) KEEP_STAGE_ON_FAIL=true ;;
    --help|-h)
      cat <<'USAGE'
Usage: bash scripts/mb-sync-upstream.sh [flags]

Flags:
  --dry-run             Preview only; no merge changes
  --skip-lint           Skip pnpm check in staged worktree
  --deploy              Rebuild/restart gateway + cli after merge
  --keep-stage-on-fail  Keep staging worktree for debugging
USAGE
      exit 0 ;;
    *) die "Unknown flag: $arg" ;;
  esac
done

UPSTREAM_REMOTE="${MB_UPSTREAM_REMOTE:-origin}"
UPSTREAM_BRANCH="${MB_UPSTREAM_BRANCH:-main}"
MERGE_DATE="$(date +%Y-%m-%d)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
INITIAL_HEAD="$(git rev-parse HEAD)"
BACKUP_BRANCH="codex/mb-sync-backup-$STAMP"
STAGE_BRANCH="codex/mb-sync-stage-$STAMP"
STAGE_DIR=""
PROTECTED_FILE_LIST="$SCRIPT_DIR/mb-sync-protected-files.txt"
BACKUP_CREATED=false

# Base protected list (can be extended in mb-sync-protected-files.txt)
MB_PROTECTED_PATTERNS=(
  "src/agents/security-sentinel.ts"
  "src/agents/pi-tools.before-tool-call.ts"
  "src/gateway/control-plane-rate-limit.ts"
  "src/gateway/control-ui-csp.ts"
  "src/browser/config.ts"
  "docker/voicebox/patch_voicebox_runtime.py"
  "scripts/mb-sync-upstream.sh"
)

load_protected_patterns() {
  if [[ ! -f "$PROTECTED_FILE_LIST" ]]; then
    return 0
  fi
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    local line
    line="${raw%%#*}"
    line="${line%$'\r'}"
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    MB_PROTECTED_PATTERNS+=("$line")
  done < "$PROTECTED_FILE_LIST"
}

is_mb_protected() {
  local file="$1"
  local pattern
  for pattern in "${MB_PROTECTED_PATTERNS[@]}"; do
    [[ -z "$pattern" ]] && continue
    if [[ "$file" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  local corepack_pnpm="/usr/local/lib/node_modules/corepack/shims/pnpm"
  if [[ -x "$corepack_pnpm" ]]; then
    export PATH="$(dirname "$corepack_pnpm"):$PATH"
    return 0
  fi
  die "pnpm not found. Install pnpm (or corepack shim) before running sync."
}

cleanup() {
  local rc=$?
  set +e

  if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then
    if [[ "$rc" -ne 0 && "$KEEP_STAGE_ON_FAIL" == true ]]; then
      warn "Keeping failed stage worktree: $STAGE_DIR"
    else
      git worktree remove --force "$STAGE_DIR" >/dev/null 2>&1 || rm -rf "$STAGE_DIR"
    fi
  fi

  if [[ -n "$STAGE_BRANCH" ]]; then
    if git show-ref --verify --quiet "refs/heads/$STAGE_BRANCH"; then
      if [[ "$rc" -eq 0 || "$KEEP_STAGE_ON_FAIL" != true ]]; then
        git branch -D "$STAGE_BRANCH" >/dev/null 2>&1 || true
      fi
    fi
  fi

  if [[ "$rc" -ne 0 ]]; then
    echo ""
    fail "Sync failed (no live branch corruption applied)."
    if [[ "$BACKUP_CREATED" == true ]]; then
      fail "Rollback anchor kept at: $BACKUP_BRANCH -> $INITIAL_HEAD"
    else
      fail "No rollback anchor was created before failure."
    fi
  fi

  exit "$rc"
}
trap cleanup EXIT

preflight() {
  hr
  log "Pre-flight checks..."

  git rev-parse --git-dir >/dev/null 2>&1 || die "Not a git repository"
  [[ "$CURRENT_BRANCH" == "HEAD" ]] && die "Detached HEAD is not supported"
  [[ -f .git/MERGE_HEAD ]] && die "Merge already in progress"
  [[ -d .git/rebase-merge || -d .git/rebase-apply ]] && die "Rebase already in progress"

  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    die "Working tree is dirty. Commit/stash first."
  fi

  command -v git >/dev/null 2>&1 || die "git not found"
  command -v python3 >/dev/null 2>&1 || die "python3 not found"
  ensure_pnpm
  if [[ "$DEPLOY" == true ]]; then
    command -v docker >/dev/null 2>&1 || die "docker not found"
  fi

  if git show-ref --verify --quiet "refs/heads/$BACKUP_BRANCH"; then
    die "Backup branch collision: $BACKUP_BRANCH"
  fi
  if git show-ref --verify --quiet "refs/heads/$STAGE_BRANCH"; then
    die "Stage branch collision: $STAGE_BRANCH"
  fi

  git branch "$BACKUP_BRANCH" "$INITIAL_HEAD" >/dev/null
  BACKUP_CREATED=true
  ok "Backup anchor created: $BACKUP_BRANCH"
}

fetch_upstream() {
  hr
  log "Fetching $UPSTREAM_REMOTE/$UPSTREAM_BRANCH..."
  git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" 2>&1 | sed 's/^/  /'

  local ahead
  ahead="$(git rev-list --count "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" 2>/dev/null || echo 0)"
  if [[ "$ahead" -eq 0 ]]; then
    ok "Already up to date — nothing to merge."
    exit 0
  fi

  log "Found $ahead upstream commit(s):"
  git log --oneline "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | sed -n '1,20p' | sed 's/^/  /'

  if [[ "$DRY_RUN" == true ]]; then
    echo ""
    ok "[dry-run] No changes made."
    exit 0
  fi
}

create_stage_worktree() {
  hr
  STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mb-sync-stage.XXXXXX")"
  log "Creating isolated stage worktree: $STAGE_DIR"
  git worktree add -b "$STAGE_BRANCH" "$STAGE_DIR" "$CURRENT_BRANCH" >/dev/null
  ok "Stage branch ready: $STAGE_BRANCH"
}

resolve_conflicts_in_stage() {
  local unresolved=()
  local file

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if is_mb_protected "$file"; then
      log "  MB-protected: keeping ours -> $file"
      git -C "$STAGE_DIR" checkout --ours -- "$file"
      git -C "$STAGE_DIR" add "$file"
    else
      unresolved+=("$file")
    fi
  done < <(git -C "$STAGE_DIR" diff --name-only --diff-filter=U)

  if [[ ${#unresolved[@]} -gt 0 ]]; then
    fail "Unprotected conflicts detected (fail-closed)."
    for file in "${unresolved[@]}"; do
      fail "  $file"
    done
    fail ""
    fail "No auto-union was attempted. Resolve manually in stage worktree or update protected list."
    return 2
  fi

  if git -C "$STAGE_DIR" diff --name-only --diff-filter=U | grep -q .; then
    die "Conflict markers still present after protected resolution"
  fi

  # Match real git conflict markers only; avoid false positives on decorative separator lines.
  if grep -R -n --exclude-dir=.git -E '^<<<<<<<[[:space:]].*$|^=======$|^>>>>>>>[[:space:]].*$' "$STAGE_DIR" >/dev/null 2>&1; then
    die "Conflict markers found in staged files"
  fi

  ok "All conflicts resolved under fail-closed rules"
}

merge_in_stage() {
  hr
  log "Merging in stage branch..."
  if ! git -C "$STAGE_DIR" merge "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" --no-commit --no-ff 2>&1 | sed 's/^/  /'; then
    if git -C "$STAGE_DIR" diff --name-only --diff-filter=U | grep -q .; then
      warn "Conflicts detected; applying MB protected-file policy only..."
      resolve_conflicts_in_stage
    else
      die "Merge failed unexpectedly in stage worktree"
    fi
  fi
}

lint_in_stage() {
  [[ "$SKIP_LINT" == true ]] && { warn "Skipping lint (--skip-lint)"; return 0; }
  hr
  log "Running pnpm check in stage worktree..."
  if ! (cd "$STAGE_DIR" && pnpm check); then
    die "pnpm check failed in stage worktree (no auto-fix applied)."
  fi
  ok "pnpm check passed"
}

commit_stage_merge() {
  hr
  log "Committing staged merge..."

  local protected_summary
  protected_summary="$(printf '%s ' "${MB_PROTECTED_PATTERNS[@]}")"

  git -C "$STAGE_DIR" commit -m "chore: safe upstream merge $MERGE_DATE (fail-closed)\n\nMB-protected patterns: $protected_summary"
  ok "Stage merge committed"
}

promote_stage() {
  hr
  log "Promoting staged result to $CURRENT_BRANCH..."

  local live_branch live_head
  live_branch="$(git rev-parse --abbrev-ref HEAD)"
  live_head="$(git rev-parse HEAD)"

  [[ "$live_branch" == "$CURRENT_BRANCH" ]] || die "Live branch changed during staging"
  [[ "$live_head" == "$INITIAL_HEAD" ]] || die "Live HEAD changed during staging"

  git merge --ff-only "$STAGE_BRANCH"
  ok "Promotion complete (fast-forward only)"
}

do_deploy() {
  [[ "$DEPLOY" == true ]] || return 0
  hr
  log "Deploying updated gateway + cli containers..."

  local env_file="$REPO_ROOT/.env.safe"
  [[ -f "$env_file" ]] || die "Missing env file: $env_file"

  docker compose --env-file "$env_file" up -d --build --force-recreate openclaw-gateway openclaw-cli 2>&1 | sed 's/^/  /'

  local waited=0
  local max_wait=120
  until docker compose --env-file "$env_file" ps openclaw-gateway 2>/dev/null | grep -q "healthy"; do
    if [[ "$waited" -ge "$max_wait" ]]; then
      die "Gateway did not become healthy within ${max_wait}s"
    fi
    sleep 2
    waited=$((waited + 2))
  done

  ok "Deploy complete; gateway healthy"
}

final_report() {
  hr
  echo ""
  echo -e "${GREEN}${BOLD}  MaxBot safe upstream sync complete  ${RESET}"
  echo ""
  echo "  Branch:          $CURRENT_BRANCH"
  echo "  Upstream:        $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
  echo "  Backup anchor:   $BACKUP_BRANCH"
  echo "  Stage branch:    $STAGE_BRANCH (deleted during cleanup)"
  echo ""
  echo "  If you ever need to roll back manually:"
  echo "    git checkout $CURRENT_BRANCH"
  echo "    git reset --hard $BACKUP_BRANCH"
  echo ""
}

main() {
  echo ""
  echo -e "${BOLD}━━━  MaxBot Upstream Sync (Fail-Closed)  ━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""

  load_protected_patterns
  preflight
  fetch_upstream
  create_stage_worktree
  merge_in_stage
  lint_in_stage
  commit_stage_merge
  promote_stage
  do_deploy
  final_report
}

main "$@"
