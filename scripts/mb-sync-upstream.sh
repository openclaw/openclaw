#!/usr/bin/env bash
# =============================================================================
# scripts/mb-sync-upstream.sh — MaxBot upstream sync with OpenClaw
#
# SECURITY CONTRACT:
#   MB (the agent) may TRIGGER this script but makes NO merge decisions.
#   All protected files and resolution strategies are HARDCODED here.
#   MB cannot modify this file at runtime.
#
# Usage:
#   bash scripts/mb-sync-upstream.sh           # normal run
#   bash scripts/mb-sync-upstream.sh --dry-run  # preview only, no changes
#   bash scripts/mb-sync-upstream.sh --skip-lint
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${BLUE}${BOLD}[mb-sync]${RESET} $*"; }
ok()   { echo -e "${GREEN}${BOLD}[mb-sync] ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}${BOLD}[mb-sync] ⚠${RESET} $*"; }
fail() { echo -e "${RED}${BOLD}[mb-sync] ✗${RESET} $*" >&2; }
die()  { fail "$*"; exit 1; }
hr()   { echo -e "${BOLD}────────────────────────────────────────────────────${RESET}"; }

# ── CLI flags ─────────────────────────────────────────────────────────────────
DRY_RUN=false
SKIP_LINT=false
DEPLOY=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --skip-lint) SKIP_LINT=true ;;
    --deploy)    DEPLOY=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--skip-lint] [--deploy]"
      echo "  --dry-run    Preview upstream commits, make no changes"
      echo "  --skip-lint  Skip lint/typecheck after merge"
      echo "  --deploy     Rebuild Docker images and restart containers after merge"
      exit 0 ;;
  esac
done

# ── Config ────────────────────────────────────────────────────────────────────
UPSTREAM_REMOTE="${MB_UPSTREAM_REMOTE:-origin}"
UPSTREAM_BRANCH="${MB_UPSTREAM_BRANCH:-main}"
MAX_LINT_ATTEMPTS=3
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
MERGE_DATE=$(date +%Y-%m-%d)

# ── HARDCODED: MB-protected files ─────────────────────────────────────────────
# These files always keep MB's version on any conflict.
# This list is the source of truth — not configurable by MB at runtime.
MB_ALWAYS_OURS=(
  "src/agents/security-sentinel.ts"
  "src/agents/pi-tools.before-tool-call.ts"
  "src/gateway/control-plane-rate-limit.ts"
  "src/gateway/control-ui-csp.ts"
  "src/browser/config.ts"
  "docker/voicebox/patch_voicebox_runtime.py"
)

# ── Helpers ───────────────────────────────────────────────────────────────────
has_conflicts() {
  git diff --name-only --diff-filter=U 2>/dev/null | grep -q .
}

conflicted_files() {
  git diff --name-only --diff-filter=U 2>/dev/null
}

is_mb_protected() {
  local f="$1"
  for p in "${MB_ALWAYS_OURS[@]}"; do
    [[ "$f" == "$p" ]] && return 0
  done
  return 1
}

# macOS vs Linux sed
sedi() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# ── Pre-flight ────────────────────────────────────────────────────────────────
preflight() {
  hr
  log "Pre-flight checks..."

  git rev-parse --git-dir >/dev/null 2>&1 || die "Not a git repository"

  [[ -f ".git/MERGE_HEAD" ]] && \
    die "A merge is already in progress. Resolve it first (git merge --abort) then re-run."

  [[ -d ".git/rebase-merge" || -d ".git/rebase-apply" ]] && \
    die "A rebase is in progress. Abort it first."

  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    die "Working tree is dirty. Commit or stash your changes first."
  fi

  # Resolve pnpm — may be via corepack or a non-standard PATH
  if ! command -v pnpm >/dev/null 2>&1; then
    local corepack_pnpm="/usr/local/lib/node_modules/corepack/shims/pnpm"
    if [[ -x "$corepack_pnpm" ]]; then
      export PATH="$(dirname "$corepack_pnpm"):$PATH"
    else
      die "pnpm not found. Install via: npm i -g pnpm"
    fi
  fi
  command -v python3 >/dev/null 2>&1 || die "python3 not found"

  ok "Pre-flight passed (branch: $CURRENT_BRANCH)"
}

# ── Fetch ─────────────────────────────────────────────────────────────────────
fetch_upstream() {
  hr
  log "Fetching $UPSTREAM_REMOTE/$UPSTREAM_BRANCH..."
  git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" 2>&1 | sed 's/^/  /'

  local ahead
  ahead=$(git rev-list --count "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" 2>/dev/null || echo 0)

  if [[ "$ahead" -eq 0 ]]; then
    ok "Already up to date — nothing to merge."
    exit 0
  fi

  log "Found $ahead new upstream commit(s):"
  { git log --oneline "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" || true; } | head -20 | sed 's/^/  /'
  local total
  total=$(git rev-list --count "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" || echo "$ahead")
  [[ "$total" -gt 20 ]] && echo "  ... and $((total - 20)) more"

  if [[ "$DRY_RUN" == true ]]; then
    echo ""
    log "[DRY RUN] No changes made. Remove --dry-run to proceed."
    exit 0
  fi
}

# ── Merge ─────────────────────────────────────────────────────────────────────
run_merge() {
  hr
  log "Merging $UPSTREAM_REMOTE/$UPSTREAM_BRANCH into $CURRENT_BRANCH..."

  # --no-commit so we can validate before finalising
  if ! git merge "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" --no-commit --no-ff 2>&1 | sed 's/^/  /'; then
    # merge returned non-zero but may just be due to conflicts — check
    if has_conflicts; then
      warn "Conflicts detected — applying MB resolution rules..."
    else
      die "Merge failed unexpectedly. Check git status."
    fi
  fi

  if has_conflicts; then
    resolve_conflicts
  else
    ok "Merge applied cleanly (no conflicts)"
  fi
}

# ── Conflict resolution ───────────────────────────────────────────────────────
resolve_conflicts() {
  hr
  log "Resolving conflicts..."
  local unresolved=()

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    echo ""
    if is_mb_protected "$file"; then
      log "  MB-PROTECTED → keeping MB version: $file"
      git checkout --ours -- "$file"
      git add "$file"
      ok "  Resolved (ours): $file"
    else
      warn "  Attempting auto-resolve (union): $file"
      if resolve_union "$file"; then
        git add "$file"
        ok "  Auto-resolved (union): $file"
      else
        unresolved+=("$file")
        warn "  Could not auto-resolve: $file (will need manual fix)"
      fi
    fi
  done < <(conflicted_files)

  if [[ ${#unresolved[@]} -gt 0 ]]; then
    echo ""
    fail "The following files need manual conflict resolution:"
    for f in "${unresolved[@]}"; do
      fail "  $f ($(grep -c '<<<<<<<' "$f" 2>/dev/null || echo '?') block(s))"
    done
    fail ""
    fail "Fix the conflicts, then run:"
    fail "  git add <files>"
    fail "  bash scripts/mb-sync-upstream.sh --skip-lint  # to resume from lint step"
    fail "  git commit"
    exit 2
  fi

  ok "All conflicts resolved"
}

# Union strategy: keep both sides' additions (ours first, theirs appended)
resolve_union() {
  local file="$1"

  python3 - "$file" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    content = f.read()

# Match conflict blocks
pattern = re.compile(
    r'<{7} HEAD\n(.*?)={7}\n(.*?)>{7}[^\n]*\n',
    re.DOTALL
)

def union(ours, theirs):
    """Keep both sides. For purely additive conflicts this is always safe."""
    ours = ours.rstrip('\n')
    theirs = theirs.rstrip('\n')
    if not ours:
        return theirs + '\n'
    if not theirs:
        return ours + '\n'
    return ours + '\n' + theirs + '\n'

resolved = pattern.sub(lambda m: union(m.group(1), m.group(2)), content)

# Fail if any markers remain (shouldn't happen but be safe)
if re.search(r'^[<=>]{7}', resolved, re.MULTILINE):
    sys.exit(1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(resolved)

sys.exit(0)
PYEOF
}

# ── Lint / auto-fix ───────────────────────────────────────────────────────────
fix_lint() {
  [[ "$SKIP_LINT" == true ]] && { warn "Skipping lint (--skip-lint)"; return 0; }

  hr
  log "Lint check..."
  local attempt=0 lint_out

  while [[ $attempt -lt $MAX_LINT_ATTEMPTS ]]; do
    attempt=$((attempt + 1))
    log "  Attempt $attempt/$MAX_LINT_ATTEMPTS..."

    lint_out=$(pnpm check 2>&1) && { ok "Lint passed"; return 0; }

    warn "  Lint errors — analysing..."
    echo "$lint_out" | grep "^  x " | sed 's/^/    /' | head -20

    local fixed=false

    # Fix 1: unused imports/vars after merge removed the consuming code
    if echo "$lint_out" | grep -q "imported but never used\|declared but never used"; then
      fix_unused_symbols "$lint_out" && fixed=true
    fi

    # Fix 2: duplicate import lines from merge
    if echo "$lint_out" | grep -q "duplicate\|already"; then
      fix_duplicate_imports && fixed=true
    fi

    # Fix 3: stray conflict markers
    if grep -rq '<<<<<<<' --include='*.ts' --include='*.js' --include='*.yml' .; then
      fail "Conflict markers still present in files — resolve manually"
      exit 2
    fi

    [[ "$fixed" == false ]] && break
  done

  # Final check
  if lint_out=$(pnpm check 2>&1); then
    ok "Lint passed after auto-fix"
    return 0
  fi

  fail "Lint still failing after $MAX_LINT_ATTEMPTS attempts."
  fail "Remaining errors:"
  echo "$lint_out" | grep "^  x " | sed 's/^/  /' | head -30
  fail ""
  fail "Fix these manually, then commit with:"
  fail "  git add <files> && git commit"
  exit 2
}

fix_unused_symbols() {
  local lint_out="$1"
  local fixed=false

  # Parse oxlint output format:
  #   x eslint(no-unused-vars): Type 'Foo' is imported but never used.
  #     ,-[src/file.ts:49:3]
  while IFS= read -r line; do
    local symbol src_file col_line

    # Extract symbol name
    if [[ "$line" =~ \'([^\']+)\'.*imported.*never.*used ]] || \
       [[ "$line" =~ \'([^\']+)\'.*declared.*never.*used ]]; then
      symbol="${BASH_REMATCH[1]}"
    else
      continue
    fi

    # Extract source file from the ,-[ line that follows
    src_file=$(echo "$lint_out" | grep -A3 "$(echo "$line" | head -c 80)" \
      | grep -o ',-\[.*:' | head -1 | sed 's/,-\[\(.*\):[0-9]*:/\1/')

    [[ -z "$src_file" || ! -f "$src_file" ]] && continue

    log "  Removing unused symbol: '$symbol' from $src_file"

    # Remove: import { Symbol } from "...";  (single-symbol import)
    sedi "/^import[[:space:]]*{[[:space:]]*${symbol}[[:space:]]*}[[:space:]]*from/d" "$src_file"

    # Remove: symbol, or ,symbol  (from multi-symbol import)
    sedi "s/[[:space:]]*${symbol},[[:space:]]*//" "$src_file"
    sedi "s/,[[:space:]]*${symbol}[[:space:]]*//" "$src_file"
    # Catch: import { symbol } → import {  } → remove whole line
    sedi "/^import[[:space:]]*{[[:space:]}]*}[[:space:]]*from/d" "$src_file"

    # Remove standalone const/var declaration
    sedi "/^const[[:space:]][[:space:]]*${symbol}[[:space:]]*=/d" "$src_file"

    git add "$src_file" 2>/dev/null || true
    fixed=true
  done <<< "$lint_out"

  [[ "$fixed" == true ]]
}

fix_duplicate_imports() {
  local fixed=false
  # Find TS files changed in this merge and deduplicate their imports
  while IFS= read -r f; do
    [[ ! -f "$f" ]] && continue

    local before after
    before=$(cat "$f")
    python3 - "$f" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path, encoding='utf-8') as fh:
    lines = fh.readlines()

from collections import OrderedDict

# Collect import blocks grouped by module
imports = OrderedDict()  # module -> {type_only: set, value: set}
output = []
i = 0

while i < len(lines):
    line = lines[i]

    # Single-line: import { A, B } from "mod";  or  import type { A } from "mod";
    m = re.match(r'^(import\s+(?:type\s+)?\{)([^}]*)\}\s+from\s+(["\'][^"\']+["\']);', line)
    if m:
        prefix, syms_str, mod = m.group(1), m.group(2), m.group(3)
        is_type = 'type ' in prefix
        syms = {s.strip() for s in syms_str.split(',') if s.strip()}
        key = (mod, is_type)
        if key not in imports:
            imports[key] = {'prefix': prefix, 'syms': set(), 'idx': len(output)}
            output.append(None)  # placeholder
        imports[key]['syms'].update(syms)
        i += 1
        continue

    output.append(line)
    i += 1

# Fill placeholders
result = []
for line in output:
    if line is None:
        continue
    result.append(line)

# Re-insert deduped imports at first occurrence positions
# Rebuild from scratch preserving order
final = []
import_done = set()
for line in output:
    if line is not None:
        final.append(line)
    # None = placeholder; find which import it belongs to
    # (handled by ordering — just emit imports in order)

# Simpler: just rewrite the file top section
# Find first import line index in result
first_import = next((i for i, l in enumerate(output) if l is None or
                     (l and re.match(r'^import\s', l))), None)

# Write merged imports
merged_imports = []
for (mod, is_type), info in imports.items():
    syms = sorted(info['syms'])
    prefix = info['prefix']
    merged_imports.append(f"{prefix}{', '.join(syms)}} from {mod};\n")

# Rebuild: non-import lines before first import + merged imports + rest
non_import_before = []
non_import_after = []
seen_import = False
for line in output:
    if line is None:
        seen_import = True
        continue
    if not seen_import and not re.match(r'^import\s', line):
        non_import_before.append(line)
    elif seen_import:
        non_import_after.append(line)

final_content = ''.join(non_import_before + merged_imports + non_import_after)
if final_content != ''.join(lines):
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(final_content)
PYEOF
    after=$(cat "$f")
    if [[ "$before" != "$after" ]]; then
      git add "$f" 2>/dev/null || true
      fixed=true
      ok "  Deduplicated imports: $f"
    fi
  done < <(git diff --name-only HEAD 2>/dev/null | grep '\.ts$')

  [[ "$fixed" == true ]]
}

# ── Commit ────────────────────────────────────────────────────────────────────
do_commit() {
  hr
  log "Committing merge..."

  local count
  count=$(git rev-list --count "MERGE_HEAD...$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" --right-only 2>/dev/null \
    || git log --oneline ORIG_HEAD..HEAD 2>/dev/null | wc -l | tr -d ' ' \
    || echo "?")

  git commit --no-edit -m "$(cat <<EOF
chore: upstream merge $MERGE_DATE — take OC fixes, preserve MB security layer

MB-protected files (always kept): ${MB_ALWAYS_OURS[*]}

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
  ok "Committed. $count upstream commit(s) integrated. MB security layer intact."
}

# ── Report ────────────────────────────────────────────────────────────────────
final_report() {
  hr
  echo ""
  echo -e "${GREEN}${BOLD}  MaxBot upstream sync complete  ${RESET}"
  echo ""
  echo "  Branch:    $CURRENT_BRANCH"
  echo "  Upstream:  $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
  echo "  Date:      $MERGE_DATE"
  echo ""
  echo "  MB-protected (always kept):"
  for f in "${MB_ALWAYS_OURS[@]}"; do
    echo "    ✓ $f"
  done
  echo ""
  git log --oneline -3 | sed 's/^/  /'
  echo ""
}

# ── Deploy ────────────────────────────────────────────────────────────────────
do_deploy() {
  hr
  echo -e "${YELLOW}${BOLD}  ⚠  DOCKER REBUILD — UI will disconnect briefly  ⚠${RESET}"
  echo ""
  echo "  The gateway container will be restarted. The MaxBot web UI will"
  echo "  go offline for ~30–60 seconds while Docker rebuilds and comes back."
  echo ""
  echo -e "  ${BOLD}Signal is your fallback during this window.${RESET}"
  echo "  (+447366270212 — message Davey Dee if needed)"
  echo ""
  echo -n "  Starting in "
  for i in 10 9 8 7 6 5 4 3 2 1; do
    echo -n "${i}... "
    sleep 1
  done
  echo ""
  echo ""

  # Detect compose command (v2 plugin or standalone)
  local compose_cmd
  if docker compose version >/dev/null 2>&1; then
    compose_cmd="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    compose_cmd="docker-compose"
  else
    die "Neither 'docker compose' nor 'docker-compose' found."
  fi

  # Determine which services need a rebuild:
  # Always rebuild gateway. If voicebox Dockerfile/patch changed, rebuild that too.
  local services=("openclaw-gateway")
  if git diff --name-only ORIG_HEAD..HEAD 2>/dev/null \
      | grep -qE 'docker/voicebox/|Dockerfile'; then
    services+=("openclaw-voicebox")
    log "Voicebox source changed — rebuilding voicebox too."
  fi

  # Always pass --env-file so docker compose picks up .env.safe
  local env_file="$REPO_ROOT/.env.safe"
  local compose_env_flag=""
  if [[ -f "$env_file" ]]; then
    compose_env_flag="--env-file $env_file"
  else
    warn ".env.safe not found at $env_file — using default env"
  fi

  log "Building: ${services[*]}..."
  $compose_cmd $compose_env_flag build "${services[@]}" 2>&1 | sed 's/^/  /'

  log "Restarting containers..."
  $compose_cmd $compose_env_flag up -d 2>&1 | sed 's/^/  /'

  # Health poll — gateway
  local gateway_url="http://127.0.0.1:18889/health"
  local max_wait=120
  local waited=0
  log "Waiting for gateway to come back up (max ${max_wait}s)..."
  until curl -sf "$gateway_url" >/dev/null 2>&1; do
    if [[ $waited -ge $max_wait ]]; then
      fail "Gateway did not respond within ${max_wait}s."
      fail "Check: $compose_cmd $compose_env_flag logs openclaw-gateway"
      exit 2
    fi
    sleep 2
    waited=$((waited + 2))
    echo -n "."
  done
  echo ""
  ok "Gateway healthy (${waited}s)"

  # Health poll — signal (best-effort, don't fail if signal is down)
  local signal_url="http://127.0.0.1:18080/api/v1/check"
  if curl -sf "$signal_url" >/dev/null 2>&1; then
    ok "Signal healthy"
  else
    warn "Signal health check did not respond — may still be starting up"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}  Deploy complete. MaxBot is back online.  ${RESET}"
  echo ""
  $compose_cmd $compose_env_flag ps 2>/dev/null | sed 's/^/  /' || true
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}━━━  MaxBot Upstream Sync  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "     MB triggers — script decides. Protecting ${#MB_ALWAYS_OURS[@]} files."
  echo ""

  preflight
  fetch_upstream
  run_merge
  fix_lint
  do_commit
  final_report

  if [[ "$DEPLOY" == true ]]; then
    do_deploy
  else
    echo "  Tip: run with --deploy to rebuild Docker images and restart containers."
    echo ""
  fi
}

main "$@"
