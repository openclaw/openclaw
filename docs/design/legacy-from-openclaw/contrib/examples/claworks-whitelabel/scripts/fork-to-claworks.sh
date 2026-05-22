#!/usr/bin/env bash
# fork-to-claworks.sh — Transform an OpenClaw checkout into a ClaWorks fork.
#
# This script performs a deep rename of internal product identifiers across the
# source tree, config files, and package manifests so that the resulting codebase
# is fully branded as ClaWorks with no visible OpenClaw strings in:
#   • CLI binary name       (openclaw  → claworks)
#   • Default state dir     (.openclaw → .claworks)
#   • Config filename       (openclaw.json → claworks.json)
#   • Env var prefix        (OPENCLAW_ → CLAWORKS_)
#   • Product/display name  (OpenClaw → ClaWorks)
#   • Package name          (openclaw → claworks)
#   • Internal constants    (OPENCLAW_ATTRIBUTION_PRODUCT etc.)
#
# USAGE
#   cd /path/to/openclaw  &&  bash contrib/examples/claworks-whitelabel/scripts/fork-to-claworks.sh
#
# OPTIONS
#   --dry-run          Print what would change without modifying files
#   --skip-git         Do not commit the result
#   --out-dir <path>   Work in a copy at <path> instead of modifying the current tree
#
# NOTES
#   • Run once on a clean checkout; the script is NOT idempotent.
#   • Review the git diff carefully before pushing or publishing.
#   • Generated lock files (pnpm-lock.yaml, bun.lockb) are regenerated via pnpm install.
#   • Test suite string expectations that assert on "openclaw" literals will fail
#     after the fork — update them as needed before CI.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../" && pwd)"
DRY_RUN=0
SKIP_GIT=0
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --skip-git)  SKIP_GIT=1 ;;
    --out-dir)   OUT_DIR="$2"; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info(){ printf '  \033[36mℹ\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── Resolve working directory ────────────────────────────────────────────────
if [[ -n "${OUT_DIR}" ]]; then
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    info "Copying repo to ${OUT_DIR} ..."
    rsync -a --exclude='.git' --exclude='node_modules' --exclude='dist' \
          "${REPO_ROOT}/" "${OUT_DIR}/"
  fi
  WORK="${OUT_DIR}"
else
  WORK="${REPO_ROOT}"
fi

hdr "ClaWorks fork transformation (working dir: ${WORK})"
[[ "${DRY_RUN}" -eq 1 ]] && warn "DRY RUN — no files will be written"

# ── Helpers ──────────────────────────────────────────────────────────────────
# sed -i portable wrapper (macOS needs '' argument)
sedi() {
  if sed --version 2>/dev/null | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

do_replace() {
  local pattern="$1" replacement="$2" file="$3"
  if grep -q "${pattern}" "${file}" 2>/dev/null; then
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      info "  [dry] ${file}: s/${pattern}/${replacement}/"
    else
      sedi "s|${pattern}|${replacement}|g" "${file}"
    fi
  fi
}

# Replace in all source files matching a glob, excluding node_modules / dist / .git
replace_in_tree() {
  local pattern="$1" replacement="$2"
  shift 2
  local globs=("$@")
  for glob in "${globs[@]}"; do
    while IFS= read -r -d '' file; do
      do_replace "${pattern}" "${replacement}" "${file}"
    done < <(find "${WORK}" \
      \( -path "*/node_modules/*" -o -path "*/.git/*" -o -path "*/dist/*" \) -prune \
      -o -name "${glob}" -print0 2>/dev/null)
  done
}

# ── 1. TypeScript / JavaScript source  ──────────────────────────────────────
hdr "1. Source files (TS/JS/JSON/MD)"

TS_GLOBS=("*.ts" "*.tsx" "*.js" "*.mjs" "*.cjs")

# Product display name (case-sensitive: OpenClaw → ClaWorks)
# Only in user-visible strings; avoid mangling identifiers like OpenClawConfig
info "Product display name: OpenClaw → ClaWorks (quoted contexts)"
replace_in_tree '"OpenClaw"' '"ClaWorks"' "${TS_GLOBS[@]}"
replace_in_tree "'OpenClaw'" "'ClaWorks'" "${TS_GLOBS[@]}"
replace_in_tree '`OpenClaw' '`ClaWorks' "${TS_GLOBS[@]}"

# Attribution originator slug: "openclaw" → "claworks" (quoted)
info "Attribution originator slug: openclaw → claworks (quoted)"
replace_in_tree '"openclaw"' '"claworks"' "${TS_GLOBS[@]}"
replace_in_tree "'openclaw'" "'claworks'" "${TS_GLOBS[@]}"

# openclaw.ai URL in source
info "URLs: openclaw.ai → claworks.ai"
replace_in_tree 'https://openclaw\.ai' 'https://claworks.ai' "${TS_GLOBS[@]}"
replace_in_tree 'https://docs\.openclaw\.ai' 'https://docs.claworks.ai' "${TS_GLOBS[@]}"
replace_in_tree 'https://github\.com/openclaw/openclaw' 'https://github.com/your-org/claworks' "${TS_GLOBS[@]}"

# Default state dir constant
info "Default state dir constant: .openclaw → .claworks"
replace_in_tree 'NEW_STATE_DIRNAME = "\.openclaw"' 'NEW_STATE_DIRNAME = ".claworks"' "${TS_GLOBS[@]}"
replace_in_tree 'CONFIG_FILENAME = "openclaw\.json"' 'CONFIG_FILENAME = "claworks.json"' "${TS_GLOBS[@]}"

# ENV VAR PREFIX: OPENCLAW_ → CLAWORKS_
# Only in env var names (all-caps context). Preserve OPENCLAW in string comments
# and type names (OpenClaw*) — handled by targeted replacements below.
info "Env var names: OPENCLAW_ → CLAWORKS_"
for ts_glob in "${TS_GLOBS[@]}"; do
  while IFS= read -r -d '' file; do
    if grep -q 'OPENCLAW_' "${file}" 2>/dev/null; then
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        info "  [dry] ${file}: OPENCLAW_ → CLAWORKS_"
      else
        sedi 's/OPENCLAW_/CLAWORKS_/g' "${file}"
      fi
    fi
  done < <(find "${WORK}" \
    \( -path "*/node_modules/*" -o -path "*/.git/*" -o -path "*/dist/*" \) -prune \
    -o -name "${ts_glob}" -print0 2>/dev/null)
done

# CLI command references in strings / comments
info "CLI command string: 'openclaw ' → 'claworks '"
replace_in_tree 'openclaw ' 'claworks ' "${TS_GLOBS[@]}"
replace_in_tree '"openclaw"' '"claworks"' "${TS_GLOBS[@]}"

# Gateway binary name
info "Binary name: openclaw-gateway → claworks-gateway"
replace_in_tree 'openclaw-gateway' 'claworks-gateway' "${TS_GLOBS[@]}"

# OpenClaw-Gateway user agent
info "Gateway User-Agent: OpenClaw-Gateway → ClaWorks-Gateway"
replace_in_tree 'OpenClaw-Gateway' 'ClaWorks-Gateway' "${TS_GLOBS[@]}"

# ── 2. package.json ──────────────────────────────────────────────────────────
hdr "2. package.json — package name and bin"

PKG="${WORK}/package.json"
if [[ -f "${PKG}" ]]; then
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    # Name
    sedi 's|"name": "openclaw"|"name": "claworks"|g' "${PKG}"
    # Bin key
    sedi 's|"openclaw": |"claworks": |g' "${PKG}"
    # Description
    sedi 's|OpenClaw|ClaWorks|g' "${PKG}"
    ok "package.json updated"
  else
    info "[dry] package.json: name, bin, description → claworks/ClaWorks"
  fi
fi

# pnpm-workspace.yaml package entries
WORKSPACE="${WORK}/pnpm-workspace.yaml"
if [[ -f "${WORKSPACE}" ]]; then
  do_replace 'openclaw' 'claworks' "${WORKSPACE}"
fi

# ── 3. Markdown / docs ────────────────────────────────────────────────────────
hdr "3. Docs and markdown files"

MD_GLOBS=("*.md" "*.mdx" "*.txt" "*.rst")
info "Product name in docs: OpenClaw → ClaWorks"
replace_in_tree 'OpenClaw' 'ClaWorks' "${MD_GLOBS[@]}"
replace_in_tree 'openclaw\.ai' 'claworks.ai' "${MD_GLOBS[@]}"
replace_in_tree 'openclaw\.json' 'claworks.json' "${MD_GLOBS[@]}"
replace_in_tree '\.openclaw' '.claworks' "${MD_GLOBS[@]}"
replace_in_tree 'openclaw ' 'claworks ' "${MD_GLOBS[@]}"
replace_in_tree 'openclaw$' 'claworks' "${MD_GLOBS[@]}"

# ── 4. YAML / shell / Dockerfile ──────────────────────────────────────────────
hdr "4. Config / deploy files"

CFG_GLOBS=("*.yml" "*.yaml" "*.sh" "Dockerfile*" "*.env*" "*.conf" "*.toml" "*.ini")
for glob in "${CFG_GLOBS[@]}"; do
  replace_in_tree 'OpenClaw' 'ClaWorks' "${glob}"
  replace_in_tree 'openclaw' 'claworks' "${glob}"
  replace_in_tree 'OPENCLAW_' 'CLAWORKS_' "${glob}"
done

# ── 5. Rename files ────────────────────────────────────────────────────────────
hdr "5. Rename files containing 'openclaw' in the name"

rename_file() {
  local src="$1"
  local dst="${src//openclaw/claworks}"
  if [[ "${src}" != "${dst}" ]]; then
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      info "[dry] rename: ${src} → ${dst}"
    else
      mv "${src}" "${dst}"
      ok "Renamed: $(basename "${src}") → $(basename "${dst}")"
    fi
  fi
}

while IFS= read -r -d '' file; do
  rename_file "${file}"
done < <(find "${WORK}" \
  \( -path "*/node_modules/*" -o -path "*/.git/*" -o -path "*/dist/*" \) -prune \
  -o -name "*openclaw*" -print0 2>/dev/null | sort -rz)

# ── 6. pnpm install ───────────────────────────────────────────────────────────
hdr "6. Regenerate lockfile"

if [[ "${DRY_RUN}" -eq 0 ]] && command -v pnpm >/dev/null 2>&1; then
  info "Running pnpm install in ${WORK} ..."
  (cd "${WORK}" && pnpm install --no-frozen-lockfile 2>&1 | tail -5)
  ok "pnpm install completed"
else
  warn "Skipping pnpm install (dry-run or pnpm not found) — run manually after"
fi

# ── 7. Git commit ─────────────────────────────────────────────────────────────
hdr "7. Git"

if [[ "${DRY_RUN}" -eq 0 ]] && [[ "${SKIP_GIT}" -eq 0 ]] && [[ -z "${OUT_DIR}" ]]; then
  cd "${WORK}"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git add -A
    git commit -m "chore: fork openclaw → claworks (white-label rename)"
    ok "Committed fork rename"
  else
    warn "Not a git repository — skipping commit"
  fi
else
  info "Skipping git commit (--skip-git, --dry-run, or --out-dir used)"
fi

printf '\n'
ok "Fork transformation complete!"
printf '\n'
printf '  Next steps:\n'
printf '  1. Review: git diff HEAD~1  (or diff %s vs original)\n' "${OUT_DIR:-<this repo>}"
printf '  2. Build:  pnpm build\n'
printf '  3. Test:   pnpm test --reporter=dot 2>&1 | tail -20\n'
printf '     (Some tests asserting "openclaw" literals will need updating)\n'
printf '  4. Tag:    git tag v<version>-claworks\n'
printf '  5. Publish or deploy from the new claworks binary\n\n'
