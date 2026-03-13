#!/usr/bin/env bash

set -euo pipefail

PR_NUMBER=${PR_NUMBER:?PR_NUMBER is required}
PR_HEAD_REF=${PR_HEAD_REF:?PR_HEAD_REF is required}
GITHUB_OUTPUT=${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}

mapfile -t files < <(
  {
    git diff --name-only
    git diff --cached --name-only
    git ls-files --others --exclude-standard
  } | awk 'NF' | sort -u
)

if [ "${#files[@]}" -eq 0 ]; then
  {
    echo "changed=false"
    echo "commit_sha="
    echo "changed_files="
  } >>"$GITHUB_OUTPUT"
  exit 0
fi

bash ./scripts/committer "CI: codex fix PR #${PR_NUMBER}" "${files[@]}"
git push origin "HEAD:${PR_HEAD_REF}"

sha=$(git rev-parse HEAD)
{
  echo "changed=true"
  echo "commit_sha=${sha}"
  echo "changed_files<<EOF"
  printf '%s\n' "${files[@]}"
  echo "EOF"
} >>"$GITHUB_OUTPUT"
