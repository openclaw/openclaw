#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack-dry-run|--publish] <package-dir>"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

mode="${1:-}"
if [[ "${mode}" != "--dry-run" && "${mode}" != "--pack-dry-run" && "${mode}" != "--publish" ]]; then
  usage >&2
  exit 2
fi
shift

if [[ "${1:-}" == "--" ]]; then
  shift
fi
package_dir=""
if [[ "$#" -gt 0 ]]; then
  case "$1" in
    -*) echo "unexpected plugin npm package-dir option: $1" >&2; exit 2 ;;
    *) package_dir="$1"; shift ;;
  esac
fi
if [[ -z "${package_dir}" ]]; then
  echo "missing package dir" >&2
  exit 2
fi
if [[ "$#" -gt 0 ]]; then
  echo "unexpected plugin npm publish argument: $1" >&2
  exit 2
fi

package_name="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.name)' "${package_dir}")"
package_version="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.version)' "${package_dir}")"
current_beta_version="$(npm view "${package_name}" dist-tags.beta 2>/dev/null || true)"
release_selector="${OPENCLAW_PLUGIN_NPM_RELEASE_SELECTOR:-daily}"
release_class="${OPENCLAW_PLUGIN_NPM_RELEASE_CLASS:-daily}"
expected_package_name="${OPENCLAW_PLUGIN_NPM_EXPECTED_PACKAGE_NAME:-}"
expected_package_version="${OPENCLAW_PLUGIN_NPM_EXPECTED_PACKAGE_VERSION:-}"
expected_npm_tag="${OPENCLAW_PLUGIN_NPM_EXPECTED_NPM_TAG:-}"
stable_manifest_sha256="${OPENCLAW_PLUGIN_NPM_STABLE_MANIFEST_SHA256:-}"
stable_line="${OPENCLAW_PLUGIN_NPM_STABLE_LINE:-}"
package_acceptance_run_id="${OPENCLAW_PLUGIN_NPM_PACKAGE_ACCEPTANCE_RUN_ID:-}"
log() {
  if [[ "${mode}" == "--pack-dry-run" ]]; then
    printf '%s\n' "$*" >&2
  else
    printf '%s\n' "$*"
  fi
}
publish_plan_output="$(
  PACKAGE_VERSION="${package_version}" CURRENT_BETA_VERSION="${current_beta_version}" PUBLISH_MODE="${mode}" node --input-type=module <<'EOF'
import {
  resolveNpmDistTagMirrorAuth,
  resolveNpmPublishPlan,
  shouldRequireNpmDistTagMirrorAuth,
} from "./scripts/lib/npm-publish-plan.mjs";

const plan = resolveNpmPublishPlan(
  process.env.PACKAGE_VERSION ?? "",
  process.env.CURRENT_BETA_VERSION,
);
const auth = resolveNpmDistTagMirrorAuth({
  nodeAuthToken: process.env.NODE_AUTH_TOKEN,
  npmToken: process.env.NPM_TOKEN,
});
const shouldRequireMirrorAuth = shouldRequireNpmDistTagMirrorAuth({
  mode: process.env.PUBLISH_MODE === "--publish" ? "--publish" : "--dry-run",
  mirrorDistTags: plan.mirrorDistTags,
  hasAuth: auth.hasAuth,
});
console.log(plan.channel);
console.log(plan.publishTag);
console.log(plan.mirrorDistTags.join(","));
console.log(auth.source);
console.log(shouldRequireMirrorAuth ? "required" : "optional");
EOF
)"
release_channel="$(printf '%s\n' "${publish_plan_output}" | sed -n '1p')"
publish_tag="$(printf '%s\n' "${publish_plan_output}" | sed -n '2p')"
mirror_dist_tags_csv="$(printf '%s\n' "${publish_plan_output}" | sed -n '3p')"
mirror_auth_source="$(printf '%s\n' "${publish_plan_output}" | sed -n '4p')"
mirror_auth_requirement="$(printf '%s\n' "${publish_plan_output}" | sed -n '5p')"
mirror_auth_source="${mirror_auth_source:-none}"
mirror_auth_requirement="${mirror_auth_requirement:-optional}"

if [[ "${release_selector}" == "stable" ]]; then
  if [[ "${release_class}" != "stable-base" && "${release_class}" != "stable-patch" ]]; then
    echo "Stable plugin npm publish requires OPENCLAW_PLUGIN_NPM_RELEASE_CLASS=stable-base or stable-patch." >&2
    exit 1
  fi
  if [[ -z "${stable_line// }" ]]; then
    echo "Stable plugin npm publish requires OPENCLAW_PLUGIN_NPM_STABLE_LINE." >&2
    exit 1
  fi
  if [[ ! "${stable_manifest_sha256}" =~ ^[a-f0-9]{64}$ ]]; then
    echo "Stable plugin npm publish requires OPENCLAW_PLUGIN_NPM_STABLE_MANIFEST_SHA256 as a lowercase SHA-256 digest." >&2
    exit 1
  fi
  if [[ -z "${package_acceptance_run_id// }" ]]; then
    echo "Stable plugin npm publish requires OPENCLAW_PLUGIN_NPM_PACKAGE_ACCEPTANCE_RUN_ID." >&2
    exit 1
  fi
  if [[ "${expected_package_name}" != "${package_name}" ]]; then
    echo "Stable plugin npm publish package mismatch: expected ${expected_package_name:-<missing>}, got ${package_name}." >&2
    exit 1
  fi
  if [[ "${expected_package_version}" != "${package_version}" ]]; then
    echo "Stable plugin npm publish version mismatch for ${package_name}: expected ${expected_package_version:-<missing>}, got ${package_version}." >&2
    exit 1
  fi
  if [[ "${expected_npm_tag}" != "stable" ]]; then
    echo "Stable plugin npm publish requires OPENCLAW_PLUGIN_NPM_EXPECTED_NPM_TAG=stable; refusing ${expected_npm_tag:-<missing>}." >&2
    exit 1
  fi
  if [[ "${publish_tag}" == "latest" || "${publish_tag}" == "daily" ]]; then
    log "Generic final-version npm plan resolved ${publish_tag}; stable manifest mode overrides it with ${expected_npm_tag}."
  fi
  publish_tag="${expected_npm_tag}"
  mirror_dist_tags_csv=""
elif [[ "${release_selector}" == "daily" ]]; then
  if [[ -n "${expected_package_name}${expected_package_version}${expected_npm_tag}${stable_manifest_sha256}${stable_line}${package_acceptance_run_id}" ]]; then
    echo "Stable plugin npm expectation inputs require OPENCLAW_PLUGIN_NPM_RELEASE_SELECTOR=stable." >&2
    exit 1
  fi
else
  echo "Unknown OPENCLAW_PLUGIN_NPM_RELEASE_SELECTOR: ${release_selector}. Expected daily or stable." >&2
  exit 1
fi

publish_cmd=(npm publish --access public --tag "${publish_tag}")
if [[ "${OPENCLAW_NPM_PUBLISH_PROVENANCE:-1}" != "0" && "${OPENCLAW_NPM_PUBLISH_PROVENANCE:-1}" != "false" ]]; then
  publish_cmd+=(--provenance)
fi

log "Resolved package dir: ${package_dir}"
log "Resolved package name: ${package_name}"
log "Resolved package version: ${package_version}"
log "Current beta dist-tag: ${current_beta_version:-<missing>}"
log "Resolved release channel: ${release_channel}"
log "Resolved publish tag: ${publish_tag}"
log "Resolved mirror dist-tags: ${mirror_dist_tags_csv:-<none>}"
log "Mirror dist-tag auth source: ${mirror_auth_source}"
log "Mirror dist-tag auth requirement: ${mirror_auth_requirement}"

build_package_runtime() {
  if [[ "${OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD:-1}" == "0" || "${OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD:-1}" == "false" ]]; then
    log "Package-local runtime build: skipped"
    return
  fi
  log "Package-local runtime build: ${package_dir}"
  node scripts/lib/plugin-npm-runtime-build.mjs "${package_dir}" >&2
}

check_package_shrinkwrap() {
  log "Package-local shrinkwrap check: ${package_dir}"
  node scripts/generate-npm-shrinkwrap.mjs --package-dir "${package_dir}" --check >&2
}

mirror_auth_token=""
case "${mirror_auth_source}" in
  node-auth-token)
    mirror_auth_token="${NODE_AUTH_TOKEN:-}"
    ;;
  npm-token)
    mirror_auth_token="${NPM_TOKEN:-}"
    ;;
esac
publish_auth_token="${mirror_auth_token}"
publish_auth_source="${mirror_auth_source}"
if [[ "${OPENCLAW_NPM_PUBLISH_AUTH_MODE:-}" == "trusted-publisher" ]]; then
  publish_auth_token=""
  publish_auth_source="trusted-publisher"
fi
publish_provenance="without provenance"
if [[ " ${publish_cmd[*]} " == *" --provenance "* ]]; then
  publish_provenance="with provenance"
fi
if [[ -n "${publish_auth_token}" ]]; then
  log "Publish auth: ${publish_auth_source} ${publish_provenance}"
else
  log "Publish auth: GitHub OIDC trusted publishing"
fi

if [[ "${mirror_auth_requirement}" == "required" && -z "${mirror_auth_token}" ]]; then
  echo "npm dist-tag mirroring requires explicit npm auth via NODE_AUTH_TOKEN or NPM_TOKEN." >&2
  echo "Refusing publish before npm latest/beta promotion can diverge." >&2
  exit 1
fi

if [[ "${mode}" == "--pack-dry-run" ]]; then
  {
    printf 'Publish command:'
    printf ' %q' "${publish_cmd[@]}"
    printf '\n'
  } >&2
else
  printf 'Publish command:'
  printf ' %q' "${publish_cmd[@]}"
  printf '\n'
fi

if [[ "${mode}" == "--dry-run" ]]; then
  exit 0
fi

build_package_runtime
check_package_shrinkwrap

if [[ "${mode}" == "--pack-dry-run" ]]; then
  OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES=1 \
    node scripts/lib/plugin-npm-package-manifest.mjs --run "${package_dir}" -- \
    npm pack --dry-run --json --ignore-scripts
  exit 0
fi

(
  cleanup_files=()
  trap 'rm -f "${cleanup_files[@]}"' EXIT
  run_with_manifest_overlay() {
    OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES=1 \
      node scripts/lib/plugin-npm-package-manifest.mjs --run "${package_dir}" -- "$@"
  }
  publish_userconfig=""
  if [[ -n "${publish_auth_token}" ]]; then
    publish_userconfig="$(mktemp)"
    cleanup_files+=("${publish_userconfig}")
    chmod 0600 "${publish_userconfig}"
    printf '%s\n' "//registry.npmjs.org/:_authToken=${publish_auth_token}" > "${publish_userconfig}"
    NPM_CONFIG_USERCONFIG="${publish_userconfig}" run_with_manifest_overlay "${publish_cmd[@]}"
  else
    run_with_manifest_overlay "${publish_cmd[@]}"
  fi

  if [[ -n "${mirror_dist_tags_csv}" ]]; then
    mirror_userconfig="$(mktemp)"
    cleanup_files+=("${mirror_userconfig}")
    chmod 0600 "${mirror_userconfig}"
    printf '%s\n' "//registry.npmjs.org/:_authToken=${mirror_auth_token}" > "${mirror_userconfig}"

    IFS=',' read -r -a mirror_dist_tags <<< "${mirror_dist_tags_csv}"
    for dist_tag in "${mirror_dist_tags[@]}"; do
      [[ -n "${dist_tag}" ]] || continue
      echo "Mirroring ${package_name}@${package_version} onto dist-tag ${dist_tag}"
      if ! NPM_CONFIG_USERCONFIG="${mirror_userconfig}" \
        npm dist-tag add "${package_name}@${package_version}" "${dist_tag}"; then
        if [[ "${mirror_auth_requirement}" == "required" ]]; then
          exit 1
        fi
        echo "Warning: optional npm dist-tag mirror failed for ${package_name}@${package_version} -> ${dist_tag}; published package remains live." >&2
      fi
    done
  fi
)
