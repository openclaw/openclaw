#!/usr/bin/env bash
# deploy.sh — build and publish denchclaw to npm
#
# Versioning convention (standard semver):
#   --bump <kind>     Increment current package version.
#                     kind: major | minor | patch
#                     2.0.0 --bump patch => 2.0.1
#   --version <ver>   Publish an explicit semver version (x.y.z).
#   (no flag)         Publish whatever version is already in package.json.
#
# Flags:
#   --skip-tests  Skip running tests before build/publish.
#   --skip-publish  Run all validation/build checks but do not publish.
#   --skip-npx-smoke  Skip post-publish npx binary verification.
#
# Environment:
#   NPM_TOKEN    Optional. npm auth token for publishing.
#                Required only when actually publishing outside GitHub Actions.
#                If omitted in GitHub Actions, npm trusted publishing via OIDC
#                can be used instead.

set -euo pipefail

PACKAGE_NAME="denchclaw"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

run_npm() {
  if [[ ${#NPM_FLAGS[@]} -gt 0 ]]; then
    npm "$@" "${NPM_FLAGS[@]}"
  else
    npm "$@"
  fi
}

current_version() {
  node -p "require('./package.json').version"
}

# Check whether a specific version is already on the npm registry.
npm_version_exists() {
  local v="$1"
  npm view "${PACKAGE_NAME}@${v}" version 2>/dev/null | grep -q "${v}" 2>/dev/null
}

is_plain_semver() {
  local v="$1"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

bump_semver() {
  local current="$1"
  local kind="$2"

  if ! is_plain_semver "$current"; then
    die "current version must be plain semver (x.y.z) for --bump, got: $current"
  fi

  local major minor patch
  IFS='.' read -r major minor patch <<<"$current"
  case "$kind" in
    major)
      echo "$((major + 1)).0.0"
      ;;
    minor)
      echo "${major}.$((minor + 1)).0"
      ;;
    patch)
      echo "${major}.${minor}.$((patch + 1))"
      ;;
    *)
      die "--bump requires one of: major, minor, patch"
      ;;
  esac
}

verify_npx_command() {
  local version="$1"
  local label="$2"
  shift 2
  local attempts=15
  local delay_seconds=2
  local output=""
  local temp_dir
  temp_dir="$(mktemp -d)"

  for ((i = 1; i <= attempts; i++)); do
    if output="$(cd "$temp_dir" && "$@" 2>/dev/null)"; then
      if [[ "$output" == *"$version"* ]]; then
        echo "verified ${label}: ${output}"
        rm -rf "$temp_dir"
        return 0
      fi
    fi
    sleep "$delay_seconds"
  done

  rm -rf "$temp_dir"
  echo "error: failed to verify ${label} for ${PACKAGE_NAME}@${version}" >&2
  return 1
}

verify_npx_invocation() {
  local label="$1"
  shift
  local attempts=15
  local delay_seconds=2
  local temp_dir
  temp_dir="$(mktemp -d)"

  for ((i = 1; i <= attempts; i++)); do
    if (cd "$temp_dir" && "$@" >/dev/null 2>&1); then
      echo "verified ${label}"
      rm -rf "$temp_dir"
      return 0
    fi
    sleep "$delay_seconds"
  done

  rm -rf "$temp_dir"
  echo "error: failed to verify ${label}" >&2
  return 1
}

# ── parse args ───────────────────────────────────────────────────────────────

MODE=""
BUMP_KIND=""
EXPLICIT_VERSION=""
DRY_RUN=false
SKIP_BUILD=false
SKIP_TESTS=false
SKIP_PUBLISH=false
SKIP_NPX_SMOKE=false

set_mode() {
  local next="$1"
  if [[ -n "$MODE" && "$MODE" != "$next" ]]; then
    die "choose only one version mode: --version <x.y.z> or --bump <major|minor|patch>"
  fi
  MODE="$next"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --)
      shift
      ;;
    --version)
      set_mode "version"
      EXPLICIT_VERSION="${2:?--version requires a semver argument (x.y.z)}"
      shift 2
      ;;
    --bump)
      set_mode "bump"
      BUMP_KIND="${2:?--bump requires one of: major, minor, patch}"
      shift 2
      ;;
    --upstream)
      die "--upstream has been removed. Use --version <x.y.z> or --bump <major|minor|patch>."
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=true
      shift
      ;;
    --skip-publish)
      SKIP_PUBLISH=true
      shift
      ;;
    --skip-npx-smoke)
      SKIP_NPX_SMOKE=true
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

NPM_FLAGS=()

if [[ "$SKIP_PUBLISH" == true ]]; then
  :
elif [[ -n "${NPM_TOKEN:-}" ]]; then
  # Write a temporary .npmrc for auth (npm_config_ env vars can't encode
  # registry-scoped keys because they contain slashes and colons).
  NPMRC_TEMP="${ROOT_DIR}/.npmrc.deploy"
  trap 'rm -f "$NPMRC_TEMP"' EXIT
  echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$NPMRC_TEMP"
  NPM_FLAGS=(--userconfig "$NPMRC_TEMP")
elif [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "using npm trusted publishing via GitHub Actions OIDC"
else
  die "NPM_TOKEN environment variable is required outside GitHub Actions"
fi

# ── compute version ─────────────────────────────────────────────────────────

CURRENT="$(current_version)"

case "$MODE" in
  version)
    if ! is_plain_semver "$EXPLICIT_VERSION"; then
      die "--version must be plain semver (x.y.z), got: $EXPLICIT_VERSION"
    fi
    VERSION="$EXPLICIT_VERSION"
    echo "explicit version: $CURRENT → $VERSION"
    ;;
  bump)
    VERSION="$(bump_semver "$CURRENT" "$BUMP_KIND")"
    echo "semver bump (${BUMP_KIND}): $CURRENT → $VERSION"
    ;;
  *)
    VERSION="$CURRENT"
    echo "publishing current version: $VERSION"
    ;;
esac

if npm_version_exists "$VERSION"; then
  if [[ "$SKIP_PUBLISH" == true ]]; then
    echo "version $VERSION already exists on npm; continuing because --skip-publish was requested"
  else
    die "version $VERSION already exists on npm. Use --bump <major|minor|patch> or --version <x.y.z>."
  fi
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] would publish ${PACKAGE_NAME}@${VERSION}"
  exit 0
fi

# ── set version ──────────────────────────────────────────────────────────────

run_npm version "$VERSION" --no-git-tag-version --allow-same-version

# ── pre-flight: tests ────────────────────────────────────────────────────────

if [[ "$SKIP_TESTS" != true ]] && [[ "$SKIP_BUILD" != true ]]; then
  echo "running tests..."
  pnpm test
fi

# ── telemetry ────────────────────────────────────────────────────────────────

if [[ -z "${POSTHOG_KEY:-}" ]]; then
  echo "warning: POSTHOG_KEY not set — telemetry will be disabled in this build"
fi
export POSTHOG_KEY="${POSTHOG_KEY:-}"
export NEXT_PUBLIC_POSTHOG_KEY="${POSTHOG_KEY:-}"

# ── build ────────────────────────────────────────────────────────────────────

# Run the full build chain here so we can verify the standalone output
# before publishing. The `prepack` hook in package.json re-runs the same
# steps during `npm publish` but that's harmless (idempotent).
if [[ "$SKIP_BUILD" != true ]]; then
  echo "building..."
  pnpm build

  echo "building web app (standalone)..."
  pnpm web:build

  echo "flattening standalone deps..."
  pnpm web:prepack
fi

# ── pre-publish: verify standalone node_modules ──────────────────────────────

STANDALONE_APP_NM="apps/web/.next/standalone/apps/web/node_modules"

# Auto-extract serverExternalPackages from next.config.ts — these are NOT
# bundled by webpack, so they must exist in standalone node_modules or the
# web runtime will crash with "fetch failed" for users.
# Also always verify next/react/react-dom which the standalone server needs.
#
# Optional native accelerators (bufferutil, utf-8-validate) are skipped —
# ws works without them.
OPTIONAL_NATIVE="bufferutil utf-8-validate"

SERVER_EXTERNAL="$(node -e "
  import('file://${ROOT_DIR}/apps/web/next.config.ts')
    .then(m => (m.default.serverExternalPackages || []).forEach(p => console.log(p)))
    .catch(() => {})
" 2>/dev/null)"

STANDALONE_OK=true
CHECKED=""

for mod in next react react-dom $SERVER_EXTERNAL; do
  [ -z "$mod" ] && continue
  if [ ! -d "${STANDALONE_APP_NM}/${mod}" ]; then
    case " $OPTIONAL_NATIVE " in
      *" $mod "*) continue ;;
    esac
    echo "error: required module '${mod}' missing from standalone build (${STANDALONE_APP_NM}/${mod})"
    STANDALONE_OK=false
  fi
  CHECKED="${CHECKED:+$CHECKED }$mod"
done

if [ "$STANDALONE_OK" != true ]; then
  die "standalone build is missing required node_modules — web chat will crash at runtime.
  Run 'pnpm web:build && pnpm web:prepack' and verify the output."
fi

# Quick sanity: try to resolve each server-external package from the standalone dir.
for mod in $SERVER_EXTERNAL; do
  [ -z "$mod" ] && continue
  case " $OPTIONAL_NATIVE " in
    *" $mod "*) continue ;;
  esac
  if ! node -e "require.resolve('${mod}', { paths: ['${STANDALONE_APP_NM}'] })" 2>/dev/null; then
    die "standalone '${mod}' module exists but cannot be resolved — check flatten-standalone-deps output"
  fi
done
echo "standalone node_modules verified ($CHECKED)"

if [[ "$SKIP_PUBLISH" == true ]]; then
  echo "pre-publish checks passed; skipping publish"
  exit 0
fi

# ── publish ──────────────────────────────────────────────────────────────────

# Always tag as "latest" — npm skips the latest tag for prerelease versions
# by default, but we want `npm i -g denchclaw` to always resolve to
# the most recently published version. The root package already exposes both
# `denchclaw` and `dench` binaries, so there is no separate alias package.
echo "publishing ${PACKAGE_NAME}@${VERSION}..."
run_npm publish --access public --tag latest

# Verify published npx flows for the primary package.
if [[ "$SKIP_NPX_SMOKE" != true ]]; then
  echo "verifying npx binaries..."
  verify_npx_command "$VERSION" "npx denchclaw" \
    npx --yes "${PACKAGE_NAME}@${VERSION}" --version
  verify_npx_invocation "npx denchclaw update --help" \
    npx --yes "${PACKAGE_NAME}@${VERSION}" update --help
  verify_npx_invocation "npx denchclaw start --help" \
    npx --yes "${PACKAGE_NAME}@${VERSION}" start --help
  verify_npx_invocation "npx denchclaw stop --help" \
    npx --yes "${PACKAGE_NAME}@${VERSION}" stop --help
fi

# Post-publish sanity: confirm the standalone server was published.
STANDALONE_SERVER="apps/web/.next/standalone/apps/web/server.js"
if [[ ! -f "$STANDALONE_SERVER" ]]; then
  echo "warning: standalone web app server.js not found after publish ($STANDALONE_SERVER)"
  echo "         users may not get a working Web UI — check the prepack step"
fi

echo ""
echo "published ${PACKAGE_NAME}@${VERSION}"
echo "install:  npm i -g ${PACKAGE_NAME}"
echo "commands: ${PACKAGE_NAME}, dench"
