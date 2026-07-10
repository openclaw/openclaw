#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: bash scripts/openclaw-npm-publish.sh (--validate package.tgz | --publish [package.tgz])"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

publish_mode="${1:-}"
case "${publish_mode}" in
  --publish | --validate) ;;
  *)
    usage >&2
    exit 2
    ;;
esac
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
if [[ "${publish_mode}" == "--validate" && -z "${publish_target}" ]]; then
  echo "error: npm publish validation requires a package tarball" >&2
  exit 2
fi

if [[ -n "${publish_target}" && -f "${publish_target}" ]]; then
  case "${publish_target}" in
    /*|./*|../*) ;;
    *) publish_target="./${publish_target}" ;;
  esac
fi

package_version="$(node -p "require('./package.json').version")"
if [[ -n "${publish_target}" ]]; then
  if [[ ! -f "${publish_target}" ]]; then
    echo "error: npm publish tarball not found: ${publish_target}" >&2
    exit 2
  fi
  expected_package_name="${OPENCLAW_NPM_EXPECTED_PACKAGE_NAME:-}"
  case "${expected_package_name}" in
    openclaw | @openclaw/ai) ;;
    *)
      echo "error: OPENCLAW_NPM_EXPECTED_PACKAGE_NAME must be openclaw or @openclaw/ai" >&2
      exit 2
      ;;
  esac
  if ! tarball_package_json="$(tar -xOf "${publish_target}" package/package.json)"; then
    echo "error: npm publish tarball is missing a readable package/package.json: ${publish_target}" >&2
    exit 2
  fi
  if ! printf '%s' "${tarball_package_json}" | \
    EXPECTED_PACKAGE_NAME="${expected_package_name}" EXPECTED_PACKAGE_VERSION="${package_version}" \
      PUBLISH_TARGET="${publish_target}" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const target = process.env.PUBLISH_TARGET;
      let pkg;
      try {
        pkg = JSON.parse(input);
      } catch {
        console.error(`error: npm publish tarball package/package.json is malformed: ${target}`);
        process.exit(2);
      }
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || typeof pkg.name !== "string" || pkg.name.trim() === "") {
        console.error(`error: npm publish tarball package/package.json has no valid name: ${target}`);
        process.exit(2);
      }
      if (pkg.name.trim() !== process.env.EXPECTED_PACKAGE_NAME) {
        console.error(
          `error: npm publish tarball package name mismatch: expected ${process.env.EXPECTED_PACKAGE_NAME}, got ${pkg.name.trim()}`,
        );
        process.exit(2);
      }
      // npm treats publishConfig as arbitrary config before its OIDC exchange.
      // Only the scoped AI package ships the exact public-access declaration.
      if (process.env.EXPECTED_PACKAGE_NAME === "openclaw" && pkg.publishConfig !== undefined) {
        console.error(`error: npm publish tarball publishConfig is not allowed: ${target}`);
        process.exit(2);
      }
      if (process.env.EXPECTED_PACKAGE_NAME === "@openclaw/ai") {
        const publishConfig = pkg.publishConfig;
        const keys =
          publishConfig && typeof publishConfig === "object" && !Array.isArray(publishConfig)
            ? Object.keys(publishConfig)
            : [];
        if (
          keys.length !== 1 ||
          keys[0] !== "access" ||
          publishConfig.access !== "public"
        ) {
          console.error(
            `error: npm publish tarball publishConfig may only contain access=public: ${target}`,
          );
          process.exit(2);
        }
      }
      if (typeof pkg.version !== "string" || pkg.version.trim() === "") {
        console.error(`error: npm publish tarball package/package.json has no valid version: ${target}`);
        process.exit(2);
      }
      if (pkg.version.trim() !== process.env.EXPECTED_PACKAGE_VERSION) {
        console.error(
          `error: npm publish tarball version mismatch: expected ${process.env.EXPECTED_PACKAGE_VERSION}, got ${pkg.version.trim()}`,
        );
        process.exit(2);
      }
    });
  '; then
    exit 2
  fi
fi

publish_plan="$(
  PACKAGE_VERSION="${package_version}" REQUESTED_PUBLISH_TAG="${OPENCLAW_NPM_PUBLISH_TAG:-}" \
    BYPASS_EXTENDED_STABLE_GUARD="${BYPASS_EXTENDED_STABLE_GUARD:-}" \
    node "${script_dir}/openclaw-npm-extended-stable-release.mjs" publish-plan
)"

release_channel="${publish_plan%%$'\n'*}"
publish_tag="${publish_plan#*$'\n'}"

echo "Resolved package version: ${package_version}"
echo "Resolved release channel: ${release_channel}"
echo "Resolved publish tag: ${publish_tag}"
if [[ -n "${publish_target}" ]]; then
  echo "Resolved publish target: ${publish_target}"
fi
if [[ "${publish_mode}" == "--validate" ]]; then
  echo "Validated npm publish target without mutation."
  exit 0
fi

publish_cmd=(npm publish)
if [[ -n "${publish_target}" ]]; then
  publish_cmd+=("${publish_target}")
fi
publish_cmd+=(
  --access public
  --tag "${publish_tag}"
  --provenance
  --registry=https://registry.npmjs.org/
  --@openclaw:registry=https://registry.npmjs.org/
)

echo "Publish auth: GitHub OIDC trusted publishing"

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

"${publish_cmd[@]}"
