#!/usr/bin/env bash
set -euo pipefail

ROLLUP_BRANCH="${ROLLUP_BRANCH:-bugfixes/rollup}"
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
RUN_VALIDATION="${RUN_VALIDATION:-1}"
PUSH_REFRESHED="${PUSH_REFRESHED:-0}"
KEEP_WORKTREE="${KEEP_WORKTREE:-0}"

usage() {
  cat <<'USAGE'
Usage: refresh-rollup-safe.sh [--push] [--no-validation] [--keep-worktree]

Safely refreshes bugfix rollup branch on top of upstream/main using an isolated worktree.
Defaults: validation on, push off.

Environment overrides:
  ROLLUP_BRANCH, ORIGIN_REMOTE, UPSTREAM_REMOTE, UPSTREAM_REF
  RUN_VALIDATION=0|1, PUSH_REFRESHED=0|1, KEEP_WORKTREE=0|1
USAGE
}

for arg in "$@"; do
  case "${arg}" in
    --push) PUSH_REFRESHED=1 ;;
    --no-validation) RUN_VALIDATION=0 ;;
    --keep-worktree) KEEP_WORKTREE=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option '${arg}'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree must be clean before refresh" >&2
  exit 1
fi

git remote get-url "${ORIGIN_REMOTE}" >/dev/null
git remote get-url "${UPSTREAM_REMOTE}" >/dev/null
git fetch --prune "${ORIGIN_REMOTE}"
git fetch --prune "${UPSTREAM_REMOTE}"

old_remote_sha="$(git ls-remote --heads "${ORIGIN_REMOTE}" "${ROLLUP_BRANCH}" | awk '{print $1}')"
if [ -z "${old_remote_sha}" ]; then
  echo "error: cannot resolve ${ORIGIN_REMOTE}/${ROLLUP_BRANCH}" >&2
  exit 1
fi

ts="$(date +%Y%m%d-%H%M%S)"
backup_branch="backup/rollup-refresh-${ts}"
refresh_branch="refresh/${ROLLUP_BRANCH//\//-}-${ts}"
worktree_dir="$(mktemp -d -t rollup-refresh-XXXXXX)"

git branch "${backup_branch}" "${old_remote_sha}" >/dev/null
echo "backup branch: ${backup_branch} -> ${old_remote_sha}"
echo "pre-refresh commits:"
git --no-pager log --oneline "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}..refs/remotes/${ORIGIN_REMOTE}/${ROLLUP_BRANCH}" || true

git worktree add -b "${refresh_branch}" "${worktree_dir}" "refs/remotes/${ORIGIN_REMOTE}/${ROLLUP_BRANCH}" >/dev/null

cleanup_success() {
  if [ "${KEEP_WORKTREE}" = "1" ]; then
    return
  fi
  git worktree remove "${worktree_dir}" --force >/dev/null 2>&1 || true
  git branch -D "${refresh_branch}" >/dev/null 2>&1 || true
}

cleanup_failure() {
  echo "refresh failed; worktree kept at: ${worktree_dir}" >&2
  echo "refresh branch kept as: ${refresh_branch}" >&2
}

trap cleanup_failure ERR

cd "${worktree_dir}"
GIT_EDITOR=true git rebase "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}"

echo "post-refresh commits:"
git --no-pager log --oneline "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}..HEAD" || true
echo "cherry summary:"
git --no-pager cherry -v "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}" HEAD || true
echo "range-diff:"
git --no-pager range-diff \
  "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}...${backup_branch}" \
  "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_REF}...HEAD" || true

if [ "${RUN_VALIDATION}" = "1" ]; then
  if [ ! -e "${worktree_dir}/node_modules" ] && [ -e "${repo_root}/node_modules" ]; then
    ln -s "${repo_root}/node_modules" "${worktree_dir}/node_modules"
  fi
  pnpm exec vitest run \
    src/agents/pi-embedded-runner/runs.test.ts \
    src/agents/pi-embedded-runner/run/compaction-timeout.test.ts \
    src/process/command-queue.test.ts \
    src/auto-reply/reply/queue-policy.test.ts \
    src/auto-reply/reply/reply-flow.test.ts \
    src/auto-reply/reply/commands.test.ts
  pnpm build
fi

if [ "${PUSH_REFRESHED}" = "1" ]; then
  live_remote_sha="$(git ls-remote --heads "${ORIGIN_REMOTE}" "${ROLLUP_BRANCH}" | awk '{print $1}')"
  git push "${ORIGIN_REMOTE}" HEAD:"${ROLLUP_BRANCH}" \
    --force-with-lease="refs/heads/${ROLLUP_BRANCH}:${live_remote_sha}"
  new_remote_sha="$(git ls-remote --heads "${ORIGIN_REMOTE}" "${ROLLUP_BRANCH}" | awk '{print $1}')"
  echo "push complete: ${ORIGIN_REMOTE}/${ROLLUP_BRANCH} ${live_remote_sha} -> ${new_remote_sha}"
fi

trap - ERR
cd "${repo_root}"
cleanup_success
echo "refresh complete (backup preserved: ${backup_branch})"
