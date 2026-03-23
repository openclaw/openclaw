#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/sync-upstream-release.sh [--tag <vYYYY.M.D>] [--branch <branch-name>] [--base <ref>] [--fork-tag <name>] [--fork-tag-prefix <prefix>] [--no-fork-tag] [--no-codex-handoff] [--codex-handoff-path <path>] [--no-verify] [--no-push] [--dry-run] [--allow-dirty]

Defaults:
  --tag      latest upstream non-beta release tag
  --branch   release-sync/<tag>
  --base     <tag> (the upstream release tag itself)
  --fork-tag explicit fork release tag name (default: <prefix><tag>)
  --fork-tag-prefix fork tag prefix when --fork-tag is omitted (default: vida-)
  --no-fork-tag do not create a fork release tag
  --no-codex-handoff do not write a Codex conflict handoff file
  --codex-handoff-path path for generated Codex conflict handoff file
  --no-verify skip downstream compatibility verification script after merge
  --no-push  do not push branch to origin
  --dry-run  print computed values and exit
  --allow-dirty skip clean-tree check
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERIFY_SCRIPT="${SCRIPT_DIR}/verify-vida-release.sh"

TAG=""
BRANCH=""
BASE_REF=""
PUSH=1
DRY_RUN=0
ALLOW_DIRTY=0
CREATE_FORK_TAG=1
FORK_TAG=""
FORK_TAG_PREFIX="vida-"
WRITE_CODEX_HANDOFF=1
CODEX_HANDOFF_PATH=""
RUN_VERIFY=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --fork-tag)
      FORK_TAG="${2:-}"
      shift 2
      ;;
    --fork-tag-prefix)
      FORK_TAG_PREFIX="${2:-}"
      shift 2
      ;;
    --no-fork-tag)
      CREATE_FORK_TAG=0
      shift
      ;;
    --no-codex-handoff)
      WRITE_CODEX_HANDOFF=0
      shift
      ;;
    --codex-handoff-path)
      CODEX_HANDOFF_PATH="${2:-}"
      shift 2
      ;;
    --no-verify)
      RUN_VERIFY=0
      shift
      ;;
    --no-push)
      PUSH=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

write_codex_handoff() {
  if [[ "${WRITE_CODEX_HANDOFF}" -ne 1 ]]; then
    return 0
  fi

  local handoff_path="${CODEX_HANDOFF_PATH}"
  if [[ -z "${handoff_path}" ]]; then
    handoff_path="${REPO_ROOT}/tmp/codex-handoff-${TAG}.md"
  fi
  mkdir -p "$(dirname "${handoff_path}")"

  local unresolved
  unresolved="$(git diff --name-only --diff-filter=U || true)"
  if [[ -z "${unresolved}" ]]; then
    unresolved="(none detected by git diff --diff-filter=U)"
  fi

  {
    echo "# Codex Handoff: Resolve release-sync conflicts"
    echo
    echo "Context"
    echo "- Repo: ${REPO_ROOT}"
    echo "- Branch: ${BRANCH}"
    echo "- Base ref: ${BASE_REF}"
    echo "- Upstream release tag: ${TAG}"
    if [[ "${CREATE_FORK_TAG}" -eq 1 ]]; then
      echo "- Fork release tag target: ${FORK_TAG}"
    fi
    echo
    echo "Unresolved conflict files"
    while IFS= read -r file; do
      [[ -n "${file}" ]] && echo "- ${file}"
    done <<< "${unresolved}"
    echo
    echo "Required outcomes"
    echo "- Merge upstream release into fork branch while preserving VIDA-specific behavior."
    echo "- Keep downstream OpenClaw Docker compatibility with fork release tags and date image tags."
    echo "- Ensure no conflict markers remain."
    echo
    echo "Suggested workflow"
    echo "1. Review unresolved files and resolve conflict markers."
    echo "2. Validate build/test scope needed for touched areas."
    echo "3. Run downstream verifier:"
    if [[ "${CREATE_FORK_TAG}" -eq 1 ]]; then
      echo "   scripts/verify-vida-release.sh --fork-tag ${FORK_TAG}"
    else
      echo "   scripts/verify-vida-release.sh"
    fi
    echo "4. Commit merge resolution and push:"
    echo "   git add <resolved files>"
    echo "   git commit"
    echo "   git push -u origin ${BRANCH}"
    if [[ "${CREATE_FORK_TAG}" -eq 1 ]]; then
      echo "   git tag -a ${FORK_TAG} -m \"Fork release aligned with upstream ${TAG}\""
      echo "   git push origin ${FORK_TAG}"
    fi
  } > "${handoff_path}"

  echo "Wrote Codex handoff: ${handoff_path}" >&2
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: run this script inside a git repository." >&2
  exit 1
fi

if [[ "$ALLOW_DIRTY" -ne 1 ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

echo "Fetching remotes..."
git fetch --prune upstream --tags
git fetch --prune origin --tags

if [[ -z "$TAG" ]]; then
  TAG="$(git for-each-ref refs/tags --format='%(refname:short)' --sort=-creatordate | grep -E '^v[0-9]' | grep -v -- '-beta' | head -n 1 || true)"
fi

if [[ -z "$TAG" ]]; then
  echo "Error: could not determine upstream release tag." >&2
  exit 1
fi

if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Error: tag '$TAG' not found locally after fetch." >&2
  exit 1
fi

if [[ -z "${BASE_REF}" ]]; then
  BASE_REF="${TAG}"
fi

if ! git rev-parse -q --verify "$BASE_REF" >/dev/null; then
  echo "Error: base ref '$BASE_REF' not found." >&2
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="release-sync/$TAG"
fi

if [[ "$CREATE_FORK_TAG" -eq 1 ]] && [[ -z "$FORK_TAG" ]]; then
  FORK_TAG="${FORK_TAG_PREFIX}${TAG}"
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "Error: local branch '$BRANCH' already exists." >&2
  exit 1
fi

if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "Error: origin branch '$BRANCH' already exists." >&2
  exit 1
fi

echo "Tag:      $TAG"
echo "Base ref: $BASE_REF"
echo "Branch:   $BRANCH"
if [[ "$CREATE_FORK_TAG" -eq 1 ]]; then
  echo "Fork tag: $FORK_TAG"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete."
  exit 0
fi

echo "Creating branch..."
git checkout -b "$BRANCH" "$BASE_REF"

BASE_COMMIT="$(git rev-parse "$BASE_REF^{commit}")"
TAG_COMMIT="$(git rev-parse "refs/tags/$TAG^{commit}")"
if [[ "${BASE_COMMIT}" == "${TAG_COMMIT}" ]]; then
  echo "Base ref already points at ${TAG}; skipping merge."
else
  echo "Merging release tag $TAG..."
  set +e
  git merge --no-ff --no-edit "$TAG"
  MERGE_EXIT=$?
  set -e

  if [[ "$MERGE_EXIT" -ne 0 ]]; then
    echo
    echo "Merge reported conflicts or errors on branch '$BRANCH'." >&2
    write_codex_handoff
    echo "Resolve conflicts, commit, then push manually:" >&2
    echo "  git push -u origin $BRANCH" >&2
    exit "$MERGE_EXIT"
  fi
fi

if [[ "$PUSH" -eq 1 ]]; then
  echo "Pushing branch to origin..."
  git push -u origin "$BRANCH"
fi

if [[ "$CREATE_FORK_TAG" -eq 1 ]]; then
  if git rev-parse -q --verify "refs/tags/$FORK_TAG" >/dev/null; then
    echo "Error: local tag '$FORK_TAG' already exists." >&2
    exit 1
  fi
  if git ls-remote --exit-code --tags --refs origin "$FORK_TAG" >/dev/null 2>&1; then
    echo "Error: origin tag '$FORK_TAG' already exists." >&2
    exit 1
  fi
  echo "Creating fork tag '$FORK_TAG'..."
  git tag -a "$FORK_TAG" -m "Fork release aligned with upstream $TAG"
  if [[ "$PUSH" -eq 1 ]]; then
    echo "Pushing fork tag '$FORK_TAG' to origin..."
    git push origin "$FORK_TAG"
  fi
fi

if [[ "${RUN_VERIFY}" -eq 1 ]]; then
  if [[ ! -x "${VERIFY_SCRIPT}" ]]; then
    echo "Warning: verifier script not found or not executable: ${VERIFY_SCRIPT}" >&2
  else
    echo "Running downstream verification..."
    if [[ "${CREATE_FORK_TAG}" -eq 1 ]]; then
      "${VERIFY_SCRIPT}" --fork-tag "${FORK_TAG}" --openclaw-ref "${FORK_TAG}"
    else
      "${VERIFY_SCRIPT}"
    fi
  fi
fi

echo "Done. Branch '$BRANCH' now contains merge of '$TAG' into '$BASE_REF'."
