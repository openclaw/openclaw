#!/usr/bin/env bash
set -euo pipefail

BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-HEAD}"

if [[ -z "${BASE_SHA}" ]]; then
  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    BASE_SHA="$(git rev-parse HEAD~1)"
  else
    echo "docs-gate: single commit history; skipping diff-enforced checks."
    exit 0
  fi
fi

commit_changed_files="$(git diff --name-only "${BASE_SHA}" "${HEAD_SHA}" || true)"
working_tree_files="$(git diff --name-only || true)"
staged_files="$(git diff --name-only --cached || true)"
untracked_files="$(git ls-files --others --exclude-standard || true)"
changed_files="$(
  printf "%s\n%s\n%s\n%s\n" \
    "${commit_changed_files}" \
    "${working_tree_files}" \
    "${staged_files}" \
    "${untracked_files}" \
    | sed '/^$/d' \
    | sort -u
)"
if [[ -z "${changed_files}" ]]; then
  echo "docs-gate: no changed files detected."
  exit 0
fi

needs_docs="false"
while IFS= read -r file; do
  [[ -z "${file}" ]] && continue
  if [[ "${file}" =~ ^src/ ]] || \
     [[ "${file}" =~ ^scripts/ ]] || \
     [[ "${file}" =~ ^\.github/workflows/ ]] || \
     [[ "${file}" == "package.json" ]] || \
     [[ "${file}" == "package-lock.json" ]] || \
     [[ "${file}" == "next.config.ts" ]] || \
     [[ "${file}" == "eslint.config.mjs" ]] || \
     [[ "${file}" == "tsconfig.json" ]]; then
    needs_docs="true"
    break
  fi
done <<< "${changed_files}"

if [[ "${needs_docs}" != "true" ]]; then
  echo "docs-gate: no code/config changes requiring changelog enforcement."
  exit 0
fi

has_changelog_update="false"
has_log_update="false"

while IFS= read -r file; do
  [[ "${file}" == "CHANGELOG.md" ]] && has_changelog_update="true"
  [[ "${file}" == "docs/engineering/IMPLEMENTATION_LOG.md" ]] && has_log_update="true"
done <<< "${changed_files}"

if [[ "${has_changelog_update}" != "true" ]] || [[ "${has_log_update}" != "true" ]]; then
  echo "docs-gate: failed."
  echo "Code/config changes require updates to both:"
  echo "- CHANGELOG.md"
  echo "- docs/engineering/IMPLEMENTATION_LOG.md"
  echo ""
  echo "Changed files in range ${BASE_SHA}..${HEAD_SHA}:"
  echo "${changed_files}"
  exit 1
fi

echo "docs-gate: passed."
