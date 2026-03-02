#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <job-id> <repo-name> [base-branch] [remote-url]" >&2
  exit 2
fi

JOB_ID="$1"
REPO_NAME="$2"
BASE_BRANCH="${3:-main}"
REMOTE_URL="${4:-}"

REPOS_ROOT="/srv/openclaw/repos"
WORKTREES_ROOT="/srv/openclaw/worktrees"
JOBS_ROOT="/srv/openclaw/jobs"

REPO_DIR="${REPOS_ROOT}/${REPO_NAME}"
WORKTREE_DIR="${WORKTREES_ROOT}/${REPO_NAME}/${JOB_ID}"
JOB_DIR="${JOBS_ROOT}/${JOB_ID}"
BRANCH="job/${JOB_ID}"

mkdir -p "${REPOS_ROOT}" "${WORKTREES_ROOT}/${REPO_NAME}" "${JOB_DIR}"

if [ ! -d "${REPO_DIR}/.git" ]; then
  if [ -z "${REMOTE_URL}" ]; then
    echo "Repo not found at ${REPO_DIR}. Provide remote-url as 4th arg to clone." >&2
    exit 1
  fi
  git clone "${REMOTE_URL}" "${REPO_DIR}"
fi

git -C "${REPO_DIR}" fetch --all --prune
if ! git -C "${REPO_DIR}" rev-parse --verify --quiet "${BASE_BRANCH}" >/dev/null; then
  if git -C "${REPO_DIR}" rev-parse --verify --quiet "origin/${BASE_BRANCH}" >/dev/null; then
    BASE_BRANCH="origin/${BASE_BRANCH}"
  else
    echo "Base branch not found: ${BASE_BRANCH}" >&2
    exit 1
  fi
fi

if [ -d "${WORKTREE_DIR}" ]; then
  echo "Worktree already exists: ${WORKTREE_DIR}" >&2
  exit 1
fi

git -C "${REPO_DIR}" worktree add -B "${BRANCH}" "${WORKTREE_DIR}" "${BASE_BRANCH}"

created_at="$(date -Is)"
status_file="${JOB_DIR}/status.json"

jq -n \
  --arg jobId "${JOB_ID}" \
  --arg repo "${REPO_NAME}" \
  --arg branch "${BRANCH}" \
  --arg worktreePath "${WORKTREE_DIR}" \
  --arg createdAt "${created_at}" \
  '{
    jobId: $jobId,
    repo: $repo,
    branch: $branch,
    worktreePath: $worktreePath,
    phaseCurrent: 1,
    phaseTotal: 6,
    lastCheck: "bootstrap-complete",
    nextAction: "start-task",
    approvalNeeded: false,
    result: "in_progress",
    updatedAt: $createdAt,
    createdAt: $createdAt
  }' > "${status_file}"

chmod 600 "${status_file}"

echo "job bootstrap complete"
echo "  jobId: ${JOB_ID}"
echo "  repo: ${REPO_NAME}"
echo "  branch: ${BRANCH}"
echo "  worktree: ${WORKTREE_DIR}"
echo "  status: ${status_file}"
