#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
package_dir="${2:-}"

if [[ "${mode}" != "--dry-run" && "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/plugin-clawhub-publish.sh [--dry-run|--publish] <package-dir>" >&2
  exit 2
fi

if [[ -z "${package_dir}" ]]; then
  echo "missing package dir" >&2
  exit 2
fi

if ! command -v clawhub >/dev/null 2>&1; then
  echo "clawhub CLI is required on PATH" >&2
  exit 1
fi

package_name="$(node -e 'const pkg = require(require(\"node:path\").resolve(process.argv[1], \"package.json\")); console.log(pkg.name)' "${package_dir}")"
package_version="$(node -e 'const pkg = require(require(\"node:path\").resolve(process.argv[1], \"package.json\")); console.log(pkg.version)' "${package_dir}")"
source_repo="${SOURCE_REPO:-${GITHUB_REPOSITORY:-openclaw/openclaw}}"
source_commit="${SOURCE_COMMIT:-$(git rev-parse HEAD)}"
source_ref="${SOURCE_REF:-$(git symbolic-ref -q HEAD || true)}"

publish_cmd=(
  clawhub
  package
  publish
  "${package_dir}"
  --source-repo
  "${source_repo}"
  --source-commit
  "${source_commit}"
  --source-path
  "${package_dir}"
)

if [[ -n "${source_ref}" ]]; then
  publish_cmd+=(
    --source-ref
    "${source_ref}"
  )
fi

echo "Resolved package dir: ${package_dir}"
echo "Resolved package name: ${package_name}"
echo "Resolved package version: ${package_version}"
echo "Resolved source repo: ${source_repo}"
echo "Resolved source commit: ${source_commit}"
echo "Resolved source ref: ${source_ref:-<missing>}"
echo "Publish auth: GitHub Actions OIDC via ClawHub short-lived token"

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

if [[ "${mode}" == "--dry-run" ]]; then
  "${publish_cmd[@]}" --dry-run
  exit 0
fi

"${publish_cmd[@]}"
