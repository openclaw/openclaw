#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: bash scripts/openclaw-npm-publish.sh --publish [package.tgz]"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" != "--publish" ]]; then
  usage >&2
  exit 2
fi
shift

publish_target=""
if [[ "${1:-}" == "--" ]]; then
  shift
fi
if [[ "$#" -gt 0 ]]; then
  case "$1" in
    -*) echo "error: unexpected npm publish target option: $1" >&2; exit 2 ;;
    *) publish_target="$1"; shift ;;
  esac
fi
if [[ "$#" -gt 0 ]]; then
  echo "error: unexpected npm publish argument: $1" >&2
  exit 2
fi

if [[ -n "${publish_target}" && -f "${publish_target}" ]]; then
  case "${publish_target}" in
    /*|./*|../*) ;;
    *) publish_target="./${publish_target}" ;;
  esac
fi

tooling_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_version="$(node -p "require('./package.json').version")"
if [[ -n "${publish_target}" ]]; then
  if [[ ! -f "${publish_target}" ]]; then
    echo "error: npm publish tarball not found: ${publish_target}" >&2
    exit 2
  fi
  if ! tarball_package_json="$(tar -xOf "${publish_target}" package/package.json)"; then
    echo "error: npm publish tarball is missing a readable package/package.json: ${publish_target}" >&2
    exit 2
  fi
  if ! tarball_package_version="$(printf '%s' "${tarball_package_json}" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const pkg = JSON.parse(input);
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || typeof pkg.version !== "string" || pkg.version.trim() === "") {
        throw new Error("package/package.json must contain a nonempty string version");
      }
      process.stdout.write(pkg.version.trim());
    });
  ')"; then
    echo "error: npm publish tarball package/package.json is malformed or has no valid version: ${publish_target}" >&2
    exit 2
  fi
  if [[ "${tarball_package_version}" != "${package_version}" ]]; then
    echo "error: npm publish tarball version mismatch: expected ${package_version}, got ${tarball_package_version}" >&2
    exit 2
  fi
fi

publish_plan="$(
  PACKAGE_VERSION="${package_version}" REQUESTED_PUBLISH_TAG="${OPENCLAW_NPM_PUBLISH_TAG:-}" \
    BYPASS_EXTENDED_STABLE_GUARD="${BYPASS_EXTENDED_STABLE_GUARD:-}" \
    node "${tooling_root}/scripts/openclaw-npm-extended-stable-release.mjs" publish-plan
)"

release_channel="${publish_plan%%$'\n'*}"
publish_tag="${publish_plan#*$'\n'}"
publish_cmd=(npm publish)
if [[ -n "${publish_target}" ]]; then
  publish_cmd+=("${publish_target}")
fi
publish_cmd+=(--access public --tag "${publish_tag}" --provenance)

echo "Resolved package version: ${package_version}"
echo "Resolved release channel: ${release_channel}"
echo "Resolved publish tag: ${publish_tag}"
echo "Publish auth: GitHub OIDC trusted publishing"
if [[ -n "${publish_target}" ]]; then
  echo "Resolved publish target: ${publish_target}"
fi

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

# GitHub publication uses the pinned publisher's guard, never candidate code.
# Keep it after tarball inspection and planning, and repeat it for every write.
if [[ "${GITHUB_ACTIONS:-}" == "true" || -n "${WORKFLOW_SHA:-}" ]]; then
  EXPECTED_RELEASE_SHA="$(git rev-parse HEAD)" \
    node "${tooling_root}/scripts/npm-preflight-tooling-identity.mjs" --verify-publication-authority
fi

publish_stderr="$(mktemp)"
trap 'rm -f "${publish_stderr}"' EXIT
if "${publish_cmd[@]}" 2> >(tee "${publish_stderr}" >&2); then
  publish_status=0
else
  publish_status=$?
fi
wait

if [[ "${publish_status}" -eq 0 ]]; then
  exit 0
fi

if grep -Fq "Cannot publish over previously staged version" "${publish_stderr}"; then
  echo "npm retained this exact version as staged or completed; publication completion is uncertain." >&2
  if registry_observation="$(
    npm view "openclaw@${package_version}" version dist.integrity --json --prefer-online 2>&1
  )"; then
    echo "Exact-version registry observation: published" >&2
    printf '%s\n' "${registry_observation}" >&2
  else
    echo "Exact-version registry observation: staged or not yet publicly readable" >&2
    printf '%s\n' "${registry_observation}" >&2
  fi
  echo "Do not rerun npm publish. Verify and recover the existing version with:" >&2
  printf 'OPENCLAW_NPM_EXPECTED_WORKFLOW_REF=%q OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA=%q node --import tsx scripts/openclaw-npm-postpublish-verify.ts %q\n' \
    "${GITHUB_REF:-refs/tags/release-publish/<tooling-sha12>-<epoch>}" \
    "${WORKFLOW_SHA:-<tooling-sha>}" \
    "${package_version}" >&2
fi

exit "${publish_status}"
