#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
package_dir="${2:-}"

if [[ "${mode}" != "--dry-run" && "${mode}" != "--pack-dry-run" && "${mode}" != "--publish" && "${mode}" != "--publish-package" && "${mode}" != "--mirror-dist-tags" ]]; then
  echo "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack-dry-run|--publish|--publish-package|--mirror-dist-tags] <package-dir>" >&2
  exit 2
fi

if [[ -z "${package_dir}" ]]; then
  echo "missing package dir" >&2
  exit 2
fi

package_name="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.name)' "${package_dir}")"
package_version="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.version)' "${package_dir}")"
current_beta_version="$(npm view "${package_name}" dist-tags.beta 2>/dev/null || true)"
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
const publishMode = process.env.PUBLISH_MODE;
const mirrorAuthPresenceFlag = ["1", "true", "yes", "available"]
  .includes((process.env.OPENCLAW_NPM_DIST_TAG_MIRROR_AUTH_AVAILABLE ?? "").trim().toLowerCase());
const shouldRequireMirrorAuth = shouldRequireNpmDistTagMirrorAuth({
  mode:
    publishMode === "--publish" ||
    publishMode === "--publish-package" ||
    publishMode === "--mirror-dist-tags"
      ? "--publish"
      : "--dry-run",
  mirrorDistTags: plan.mirrorDistTags,
  hasAuth: auth.hasAuth || mirrorAuthPresenceFlag,
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
mirror_auth_presence_flag="${OPENCLAW_NPM_DIST_TAG_MIRROR_AUTH_AVAILABLE:-}"
case "${mirror_auth_presence_flag,,}" in
  1|true|yes|available)
    mirror_auth_available="true"
    ;;
  *)
    mirror_auth_available="false"
    ;;
esac
if [[ "${mirror_auth_source}" != "none" ]]; then
  mirror_auth_available="true"
fi

log "Mirror dist-tag auth source: ${mirror_auth_source}"
log "Mirror dist-tag auth availability: ${mirror_auth_available}"
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
if [[ "${mode}" != "--mirror-dist-tags" ]]; then
  if [[ -n "${publish_auth_token}" ]]; then
    log "Publish auth: ${publish_auth_source} ${publish_provenance}"
  else
    log "Publish auth: GitHub OIDC trusted publishing"
  fi
fi

if [[ "${mirror_auth_requirement}" == "required" ]]; then
  if [[ "${mode}" == "--publish-package" ]]; then
    echo "npm dist-tag mirroring requires confirmed npm auth availability before package publish." >&2
    echo "Set OPENCLAW_NPM_DIST_TAG_MIRROR_AUTH_AVAILABLE=1 only after confirming the later mirror step has npm auth." >&2
  elif [[ "${mode}" == "--mirror-dist-tags" ]]; then
    echo "npm dist-tag mirroring requires explicit npm auth via NODE_AUTH_TOKEN or NPM_TOKEN." >&2
    echo "Refusing npm latest/beta promotion without npm auth." >&2
  else
    echo "npm dist-tag mirroring requires explicit npm auth via NODE_AUTH_TOKEN or NPM_TOKEN." >&2
    echo "Refusing publish before npm latest/beta promotion can diverge." >&2
  fi
  exit 1
fi

if [[ "${mode}" == "--mirror-dist-tags" && -n "${mirror_dist_tags_csv}" && -z "${mirror_auth_token}" ]]; then
  echo "npm dist-tag mirroring requires explicit npm auth via NODE_AUTH_TOKEN or NPM_TOKEN." >&2
  echo "Refusing npm latest/beta promotion without npm auth." >&2
  exit 1
fi

if [[ "${mode}" != "--mirror-dist-tags" ]]; then
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
fi

if [[ "${mode}" == "--dry-run" ]]; then
  exit 0
fi

if [[ "${mode}" != "--mirror-dist-tags" ]]; then
  build_package_runtime
  check_package_shrinkwrap
fi

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
  run_publish_with_manifest_overlay() {
    if [[ "${OPENCLAW_NPM_PUBLISH_AUTH_MODE:-}" == "trusted-publisher" ]]; then
      env -u NODE_AUTH_TOKEN -u NPM_TOKEN -u NPM_CONFIG_USERCONFIG \
        node scripts/lib/plugin-npm-package-manifest.mjs --run "${package_dir}" -- "$@"
    else
      run_with_manifest_overlay "$@"
    fi
  }
  mirror_dist_tags() {
    if [[ -z "${mirror_dist_tags_csv}" ]]; then
      log "Mirror dist-tags: <none>"
      return
    fi

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
  }

  if [[ "${mode}" != "--mirror-dist-tags" ]]; then
    publish_userconfig=""
    if [[ -n "${publish_auth_token}" ]]; then
      publish_userconfig="$(mktemp)"
      cleanup_files+=("${publish_userconfig}")
      chmod 0600 "${publish_userconfig}"
      printf '%s\n' "//registry.npmjs.org/:_authToken=${publish_auth_token}" > "${publish_userconfig}"
      NPM_CONFIG_USERCONFIG="${publish_userconfig}" run_publish_with_manifest_overlay "${publish_cmd[@]}"
    else
      run_publish_with_manifest_overlay "${publish_cmd[@]}"
    fi
  fi

  if [[ "${mode}" == "--publish" || "${mode}" == "--mirror-dist-tags" ]]; then
    mirror_dist_tags
  fi
)
