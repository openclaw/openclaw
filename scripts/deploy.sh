#!/usr/bin/env bash
# deploy.sh — build and publish ironclaw to npm
#
# Versioning convention (mirrors upstream openclaw tags):
#   --upstream <ver>  Sync to an upstream release version.
#                     If that version is already published, appends .1, .2, …
#                     (or -1, -2, … when the base has no prerelease).
#   --bump            Increment the local fork suffix on the current version.
#                     2026.2.6-3   → 2026.2.6-3.1
#                     2026.2.6-3.1 → 2026.2.6-3.2
#                     2026.2.7     → 2026.2.7-1
#   (no flag)         Publish whatever version is already in package.json.
#
# Environment:
#   NPM_TOKEN   Required. npm auth token for publishing.

set -euo pipefail

PACKAGE_NAME="ironclaw"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

current_version() {
  node -p "require('./package.json').version"
}

# Check whether a specific version is already on the npm registry.
npm_version_exists() {
  local v="$1"
  npm view "${PACKAGE_NAME}@${v}" version 2>/dev/null | grep -q "${v}" 2>/dev/null
}

# Given a base version, return it if available on npm, otherwise find the
# next free slot by appending a dot-suffix (.1, .2, …) for versions that
# already contain a prerelease, or a hyphen-suffix (-1, -2, …) otherwise.
find_available_version() {
  local base="$1"
  if ! npm_version_exists "$base"; then
    echo "$base"
    return
  fi

  local n=1
  if [[ "$base" == *-* ]]; then
    # Has prerelease already → append .N
    while npm_version_exists "${base}.${n}"; do
      n=$((n + 1))
    done
    echo "${base}.${n}"
  else
    # No prerelease → append -N
    while npm_version_exists "${base}-${n}"; do
      n=$((n + 1))
    done
    echo "${base}-${n}"
  fi
}

# Increment the local fork suffix on a version string.
#   2026.2.6-3     → 2026.2.6-3.1   (upstream prerelease, add .1)
#   2026.2.6-3.1   → 2026.2.6-3.2   (increment last dot segment)
#   2026.2.7       → 2026.2.7-1     (no prerelease, add -1)
#   2026.2.7-1     → 2026.2.7-1.1   (treat -1 as upstream-like, add .1)
bump_version() {
  local current="$1"

  # If the prerelease already has a dot (e.g. 3.1 in 2026.2.6-3.1),
  # increment the last numeric segment after the final dot.
  local prerelease="${current#*-}"
  if [[ "$current" == *-* ]] && [[ "$prerelease" == *.* ]]; then
    if [[ "$current" =~ ^(.*\.)([0-9]+)$ ]]; then
      echo "${BASH_REMATCH[1]}$((BASH_REMATCH[2] + 1))"
      return
    fi
  fi

  # Has a prerelease but no dot-suffix yet → append .1
  if [[ "$current" == *-* ]]; then
    echo "${current}.1"
    return
  fi

  # Plain semver with no prerelease → append -1
  echo "${current}-1"
}

# ── parse args ───────────────────────────────────────────────────────────────

MODE=""
UPSTREAM_VERSION=""
DRY_RUN=false
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --upstream)
      MODE="upstream"
      UPSTREAM_VERSION="${2:?--upstream requires a version argument}"
      shift 2
      ;;
    --bump)
      MODE="bump"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --help|-h)
      sed -n '2,/^[^#]/{ /^#/s/^# \{0,1\}//p; }' "$0"
      exit 0
      ;;
    *)
      die "unknown argument: $1 (see --help)"
      ;;
  esac
done

# ── auth ─────────────────────────────────────────────────────────────────────

if [[ -z "${NPM_TOKEN:-}" ]]; then
  die "NPM_TOKEN environment variable is required"
fi

# Write a temporary .npmrc for auth (npm_config_ env vars can't encode
# registry-scoped keys because they contain slashes and colons).
NPMRC_TEMP="${ROOT_DIR}/.npmrc.deploy"
trap 'rm -f "$NPMRC_TEMP"' EXIT
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$NPMRC_TEMP"
NPM_FLAGS=(--userconfig "$NPMRC_TEMP")

# ── compute version ─────────────────────────────────────────────────────────

CURRENT="$(current_version)"

case "$MODE" in
  upstream)
    VERSION="$(find_available_version "$UPSTREAM_VERSION")"
    echo "upstream sync: $UPSTREAM_VERSION → publishing as $VERSION"
    ;;
  bump)
    NEXT="$(bump_version "$CURRENT")"
    VERSION="$(find_available_version "$NEXT")"
    echo "local bump: $CURRENT → $VERSION"
    ;;
  *)
    if npm_version_exists "$CURRENT"; then
      die "version $CURRENT already exists on npm. Use --bump or --upstream <ver>."
    fi
    VERSION="$CURRENT"
    echo "publishing current version: $VERSION"
    ;;
esac

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] would publish ${PACKAGE_NAME}@${VERSION}"
  exit 0
fi

# ── set version ──────────────────────────────────────────────────────────────

npm version "$VERSION" --no-git-tag-version --allow-same-version "${NPM_FLAGS[@]}"

# ── build ────────────────────────────────────────────────────────────────────

# The `prepack` script (triggered by `npm publish`) runs the full build chain:
#   pnpm build && pnpm ui:build && pnpm web:build && pnpm web:prepack
# Running `pnpm build` here is a redundant fail-fast: catch CLI build errors
# before committing to a publish attempt.
if [[ "$SKIP_BUILD" != true ]]; then
  echo "building..."
  pnpm build
fi

# ── publish ──────────────────────────────────────────────────────────────────

# Always tag as "latest" — npm skips the latest tag for prerelease versions
# by default, but we want `npm i -g ironclaw` to always resolve to
# the most recently published version.
echo "publishing ${PACKAGE_NAME}@${VERSION}..."
npm publish --access public --tag latest "${NPM_FLAGS[@]}"

# Verify the standalone web app was included in the published package.
# `prepack` should have built it; if this file is missing, the web UI
# won't work for users who install globally.
STANDALONE_SERVER="apps/web/.next/standalone/apps/web/server.js"
if [[ ! -f "$STANDALONE_SERVER" ]]; then
  echo "warning: standalone web app build not found after publish ($STANDALONE_SERVER)"
  echo "         users may not get a working Web UI — check the prepack step"
fi

echo ""
echo "published ${PACKAGE_NAME}@${VERSION}"
echo "install:  npm i -g ${PACKAGE_NAME}"
