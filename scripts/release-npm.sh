#!/usr/bin/env bash
# QVerisBot npm release script - bump version, sync plugins, build, validate, tag, push.
# CI (GitHub Actions) publishes on tag push. Use --local to publish locally instead.
#
# Usage:
#   ./scripts/release-npm.sh [patch|minor|major] [--skip-smoke] [--skip-tests] [--dry-run] [--no-push] [--local] [--tag-only]
#   ./scripts/release-npm.sh 2026.2.17 [--skip-smoke] [--skip-tests] [--dry-run] [--no-push] [--local] [--tag-only]
#
# Examples:
#   ./scripts/release-npm.sh patch               # Bump, tag, push → CI publishes
#   ./scripts/release-npm.sh 2026.2.17 --tag-only  # Tag + push only (version already committed)
#   ./scripts/release-npm.sh patch --skip-smoke # Skip install smoke (faster)
#   ./scripts/release-npm.sh patch --local      # Publish locally (no CI)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PKG_NAME="@qverisai/qverisbot"
SKIP_SMOKE=0
SKIP_TESTS=0
DRY_RUN=0
NO_PUSH=0
LOCAL_PUBLISH=0
TAG_ONLY=0
BUMP="patch"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag-only)
      TAG_ONLY=1
      shift
      ;;
    --skip-smoke)
      SKIP_SMOKE=1
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-push)
      NO_PUSH=1
      shift
      ;;
    --local)
      LOCAL_PUBLISH=1
      shift
      ;;
    patch|minor|major)
      BUMP="$1"
      shift
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
        BUMP="$1"
      else
        echo "Unknown argument: $1" >&2
        echo "Usage: $0 [patch|minor|major|VERSION] [--skip-smoke] [--skip-tests] [--dry-run] [--no-push] [--local] [--tag-only]" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -n "$(git status --porcelain)" ]] && [[ "$TAG_ONLY" -eq 0 ]]; then
  echo "Working tree is dirty. Commit or stash changes first." >&2
  exit 1
fi

if [[ "$TAG_ONLY" -eq 1 ]]; then
  if [[ "$BUMP" == "patch" || "$BUMP" == "minor" || "$BUMP" == "major" ]]; then
    NEW_VER="$(node -p "require('./package.json').version")"
  else
    NEW_VER="$BUMP"
  fi
  TAG="v${NEW_VER}"
  echo "==> Tag-only mode: $TAG (skip bump, build, test, commit)"
else
  echo "==> Bump version: $BUMP"
if [[ "$BUMP" == "patch" || "$BUMP" == "minor" || "$BUMP" == "major" ]]; then
  npm version "$BUMP" --no-git-tag-version
else
  node -e "
    const p = require('./package.json');
    p.version = '$BUMP';
    require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  "
fi

NEW_VER="$(node -p "require('./package.json').version")"
TAG="v${NEW_VER}"
echo "==> New version: $NEW_VER (tag: $TAG)"

echo "==> Sync plugin versions"
pnpm plugins:sync

echo "==> Format (fix CHANGELOG etc. from plugins:sync)"
pnpm format

echo "==> Build"
pnpm build

echo "==> Check (format, ts, lint)"
pnpm check

if [[ "$SKIP_TESTS" -eq 1 ]]; then
  echo "==> Skip unit tests (--skip-tests)"
else
  echo "==> Test"
  pnpm test
fi

echo "==> Release check (npm pack validation)"
pnpm release:check

if [[ "$SKIP_SMOKE" -eq 0 ]]; then
  echo "==> Install smoke (fast path)"
  QVERISBOT_INSTALL_SMOKE_SKIP_NONROOT=1 QVERISBOT_INSTALL_SMOKE_SKIP_CLI=1 pnpm test:install:smoke
else
  echo "==> Skip install smoke (--skip-smoke)"
fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "==> Dry run: skipping git commit, tag, and npm publish"
    echo "Version in package.json is $NEW_VER. Run without --dry-run to publish."
    exit 0
  fi

  echo "==> Stage and commit"
git add package.json pnpm-lock.yaml package-lock.json
for f in extensions/*/package.json extensions/*/CHANGELOG.md; do
  [[ -f "$f" ]] && git add "$f" 2>/dev/null || true
done
  if ! git diff --staged --quiet 2>/dev/null; then
    git commit -m "release: $NEW_VER"
  else
    echo "Nothing to commit (working tree clean). Version may already be $NEW_VER."
  fi
fi

echo "==> Tag $TAG"
TAG_FORCE_PUSH=0
if git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag -f "$TAG"
  echo "Tag $TAG already existed; moved to current HEAD"
  TAG_FORCE_PUSH=1
else
  git tag "$TAG"
fi

if [[ "$LOCAL_PUBLISH" -eq 1 ]]; then
  echo "==> Publish to npm (local)"
  npm publish --access public
fi

echo "==> Push"
git push origin main
if [[ "$NO_PUSH" -eq 0 ]]; then
  if [[ "$TAG_FORCE_PUSH" -eq 1 ]]; then
    git push -f origin "$TAG"
  else
    git push origin "$TAG"
  fi
  if [[ "$LOCAL_PUBLISH" -eq 0 ]]; then
    echo "==> CI will publish $PKG_NAME@$NEW_VER on tag push"
  fi
fi

echo ""
if [[ "$LOCAL_PUBLISH" -eq 1 ]]; then
  echo "OK: $PKG_NAME@$NEW_VER published. Tag: $TAG"
else
  echo "OK: $PKG_NAME@$NEW_VER tagged. CI will publish on push. Tag: $TAG"
fi
