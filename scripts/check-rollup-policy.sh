#!/usr/bin/env bash
set -euo pipefail

ROLLUP_BRANCH="${ROLLUP_BRANCH:-bugfixes/rollup}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: not inside a git repository" >&2
  exit 2
fi

if ! git remote get-url "${UPSTREAM_REMOTE}" >/dev/null 2>&1; then
  echo "error: missing git remote '${UPSTREAM_REMOTE}'" >&2
  exit 2
fi

git fetch --prune "${UPSTREAM_REMOTE}"

if ! git rev-parse --verify "HEAD" >/dev/null 2>&1; then
  echo "error: HEAD is not valid" >&2
  exit 2
fi

range="refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}..HEAD"
ahead_count="$(git rev-list --count "${range}")"
merge_count="$(git rev-list --count --merges "${range}")"

if [ "${merge_count}" -ne 0 ]; then
  echo "error: rollup must be linear; found ${merge_count} merge commit(s) in ${range}" >&2
  exit 1
fi

duplicate_commits="$(git cherry -v "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}" HEAD | rg '^- ' || true)"
if [ -n "${duplicate_commits}" ]; then
  echo "error: rollup contains commit(s) already upstream-equivalent; drop/rebase them first:" >&2
  echo "${duplicate_commits}" >&2
  exit 1
fi

tmpdir="$(mktemp -d -t rollup-policy-check-XXXXXX)"
cleanup() {
  git worktree remove "${tmpdir}" --force >/dev/null 2>&1 || true
  rm -rf "${tmpdir}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git worktree add --detach "${tmpdir}" "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}" >/dev/null
commits="$(git rev-list --reverse "${range}")"

if [ -n "${commits}" ]; then
  while IFS= read -r commit; do
    [ -z "${commit}" ] && continue
    if ! git -C "${tmpdir}" cherry-pick -x "${commit}" >/dev/null 2>&1; then
      echo "error: replay check failed when applying commit ${commit}" >&2
      git -C "${tmpdir}" status --short >&2 || true
      exit 1
    fi
  done <<<"${commits}"
fi

echo "rollup-policy-check: ok"
echo "branch=${ROLLUP_BRANCH} ahead_commits=${ahead_count} upstream=${UPSTREAM_REMOTE}/${UPSTREAM_REF}"
