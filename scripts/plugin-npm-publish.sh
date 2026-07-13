#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack|--pack-dry-run|--publish] <package-dir> [verified-package.tgz]"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

mode="${1:-}"
if [[ "${mode}" != "--dry-run" && "${mode}" != "--pack" && "${mode}" != "--pack-dry-run" && "${mode}" != "--publish" ]]; then
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
publish_target=""
if [[ "$#" -gt 0 && "${mode}" == "--publish" ]]; then
  case "$1" in
    -*) echo "unexpected plugin npm tarball option: $1" >&2; exit 2 ;;
    *) publish_target="$1"; shift ;;
  esac
fi
if [[ "$#" -gt 0 ]]; then
  echo "unexpected plugin npm publish argument: $1" >&2
  exit 2
fi
if [[ "${mode}" == "--pack" && -z "${OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR:-}" ]]; then
  echo "--pack requires OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR" >&2
  exit 2
fi

package_name="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.name)' "${package_dir}")"
package_version="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.version)' "${package_dir}")"
if [[ -n "${publish_target}" ]]; then
  if [[ ! -f "${publish_target}" ]]; then
    echo "verified plugin npm tarball not found: ${publish_target}" >&2
    exit 2
  fi
  case "${publish_target}" in
    /*|./*|../*) ;;
    *) publish_target="./${publish_target}" ;;
  esac
  if ! tarball_package_json="$(tar -xOf "${publish_target}" package/package.json)"; then
    echo "verified plugin npm tarball is missing package/package.json: ${publish_target}" >&2
    exit 2
  fi
  tarball_identity="$(printf '%s' "${tarball_package_json}" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const pkg = JSON.parse(input);
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || typeof pkg.name !== "string" || typeof pkg.version !== "string") {
        throw new Error("package/package.json must contain string name and version");
      }
      process.stdout.write(`${pkg.name.trim()}\n${pkg.version.trim()}\n`);
    });
  ')" || {
    echo "verified plugin npm tarball has invalid package identity: ${publish_target}" >&2
    exit 2
  }
  tarball_package_name="$(printf '%s\n' "${tarball_identity}" | sed -n '1p')"
  tarball_package_version="$(printf '%s\n' "${tarball_identity}" | sed -n '2p')"
  if [[ "${tarball_package_name}" != "${package_name}" || "${tarball_package_version}" != "${package_version}" ]]; then
    echo "verified plugin npm tarball identity mismatch: expected ${package_name}@${package_version}, got ${tarball_package_name}@${tarball_package_version}" >&2
    exit 2
  fi
fi
current_beta_version="$(npm view "${package_name}" dist-tags.beta 2>/dev/null || true)"
log() {
  if [[ "${mode}" == "--pack" || "${mode}" == "--pack-dry-run" ]]; then
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
  process.env.OPENCLAW_PLUGIN_NPM_PUBLISH_TAG,
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
defer_dist_tag_mirrors="${OPENCLAW_PLUGIN_NPM_DEFER_DIST_TAG_MIRRORS:-0}"
if [[ "${defer_dist_tag_mirrors}" == "1" || "${defer_dist_tag_mirrors}" == "true" ]]; then
  if [[ "${mode}" != "--publish" || "${OPENCLAW_NPM_PUBLISH_AUTH_MODE:-}" != "trusted-publisher" ]]; then
    echo "Deferring npm dist-tag mirrors is restricted to trusted-publisher publication." >&2
    exit 1
  fi
  mirror_auth_requirement="optional"
fi
publish_cmd=(npm publish)
if [[ -n "${publish_target}" ]]; then
  publish_cmd+=("${publish_target}")
fi
publish_cmd+=(--access public --tag "${publish_tag}")
if [[ "${OPENCLAW_NPM_PUBLISH_PROVENANCE:-1}" != "0" && "${OPENCLAW_NPM_PUBLISH_PROVENANCE:-1}" != "false" ]]; then
  publish_cmd+=(--provenance)
fi

log "Resolved package dir: ${package_dir}"
log "Resolved package name: ${package_name}"
log "Resolved package version: ${package_version}"
if [[ -n "${publish_target}" ]]; then
  log "Resolved verified publish target: ${publish_target}"
fi
log "Current beta dist-tag: ${current_beta_version:-<missing>}"
log "Resolved release channel: ${release_channel}"
log "Resolved publish tag: ${publish_tag}"
log "Resolved mirror dist-tags: ${mirror_dist_tags_csv:-<none>}"
log "Mirror dist-tag auth source: ${mirror_auth_source}"
log "Mirror dist-tag auth requirement: ${mirror_auth_requirement}"
if [[ "${defer_dist_tag_mirrors}" == "1" || "${defer_dist_tag_mirrors}" == "true" ]]; then
  log "Mirror dist-tag execution: deferred to credential-isolated release tooling"
fi

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

if [[ "${mode}" == "--pack" || "${mode}" == "--pack-dry-run" ]]; then
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

if [[ -z "${publish_target}" ]]; then
  build_package_runtime
  check_package_shrinkwrap
fi

if [[ "${mode}" == "--pack" || "${mode}" == "--pack-dry-run" ]]; then
  pack_args=(npm pack --json --ignore-scripts)
  if [[ "${mode}" == "--pack-dry-run" ]]; then
    pack_args+=(--dry-run)
  else
    mkdir -p "${OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR}"
    pack_output_dir="$(cd "${OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR}" && pwd)"
    pack_args+=(--pack-destination "${pack_output_dir}")
  fi
  OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES=1 \
    node scripts/lib/plugin-npm-package-manifest.mjs --run "${package_dir}" -- \
    "${pack_args[@]}"
  exit 0
fi

(
  cleanup_files=()
  cleanup() {
    if (( ${#cleanup_files[@]} > 0 )); then
      rm -f "${cleanup_files[@]}"
    fi
  }
  trap cleanup EXIT
  run_with_manifest_overlay() {
    OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES=1 \
      node scripts/lib/plugin-npm-package-manifest.mjs --run "${package_dir}" -- "$@"
  }
  run_publish() {
    if [[ -n "${publish_target}" ]]; then
      "$@"
      return
    fi
    run_with_manifest_overlay "$@"
  }
  publish_userconfig=""
  if [[ -n "${publish_auth_token}" ]]; then
    publish_userconfig="$(mktemp)"
    cleanup_files+=("${publish_userconfig}")
    chmod 0600 "${publish_userconfig}"
    printf '%s\n' "//registry.npmjs.org/:_authToken=${publish_auth_token}" > "${publish_userconfig}"
    NPM_CONFIG_USERCONFIG="${publish_userconfig}" run_publish "${publish_cmd[@]}"
  else
    run_publish "${publish_cmd[@]}"
  fi

  if [[ -n "${mirror_dist_tags_csv}" && "${defer_dist_tag_mirrors}" != "1" && "${defer_dist_tag_mirrors}" != "true" ]]; then
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
