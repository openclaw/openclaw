#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
publish_target="${2:-}"

if [[ "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/openclaw-npm-publish.sh --publish [package.tgz]" >&2
  exit 2
fi

package_version="$(node -p "require('./package.json').version")"
current_beta_version="$(npm view openclaw dist-tags.beta 2>/dev/null || true)"
mapfile -t publish_plan < <(
  PACKAGE_VERSION="${package_version}" CURRENT_BETA_VERSION="${current_beta_version}" node --import tsx --input-type=module <<'EOF'
import {
  resolveNpmDistTagMirrorAuth,
  resolveNpmPublishPlan,
} from "./scripts/openclaw-npm-release-check.ts";

const plan = resolveNpmPublishPlan(
  process.env.PACKAGE_VERSION ?? "",
  process.env.CURRENT_BETA_VERSION,
);
const auth = resolveNpmDistTagMirrorAuth();
console.log(plan.channel);
console.log(plan.publishTag);
console.log(plan.mirrorDistTags.join(","));
console.log(auth.source);
EOF
)

release_channel="${publish_plan[0]}"
publish_tag="${publish_plan[1]}"
mirror_dist_tags_csv="${publish_plan[2]:-}"
mirror_auth_source="${publish_plan[3]:-none}"
publish_cmd=(npm publish)
if [[ -n "${publish_target}" ]]; then
  publish_cmd+=("${publish_target}")
fi
publish_cmd+=(--access public --tag "${publish_tag}" --provenance)

echo "Resolved package version: ${package_version}"
echo "Current beta dist-tag: ${current_beta_version:-<missing>}"
echo "Resolved release channel: ${release_channel}"
echo "Resolved publish tag: ${publish_tag}"
echo "Resolved mirror dist-tags: ${mirror_dist_tags_csv:-<none>}"
echo "Publish auth: GitHub OIDC trusted publishing"
echo "Mirror dist-tag auth source: ${mirror_auth_source}"
if [[ -n "${publish_target}" ]]; then
  echo "Resolved publish target: ${publish_target}"
fi

mirror_auth_token=""
case "${mirror_auth_source}" in
  node-auth-token)
    mirror_auth_token="${NODE_AUTH_TOKEN:-}"
    ;;
  npm-token)
    mirror_auth_token="${NPM_TOKEN:-}"
    ;;
esac

if [[ -n "${mirror_dist_tags_csv}" && -z "${mirror_auth_token}" ]]; then
  echo "npm dist-tag mirroring requires explicit npm auth via NODE_AUTH_TOKEN or NPM_TOKEN." >&2
  echo "Refusing publish before npm latest/beta promotion can diverge." >&2
  exit 1
fi

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

"${publish_cmd[@]}"

if [[ -n "${mirror_dist_tags_csv}" ]]; then
  mirror_userconfig="$(mktemp)"
  trap 'rm -f "${mirror_userconfig}"' EXIT
  chmod 0600 "${mirror_userconfig}"
  printf '%s\n' "//registry.npmjs.org/:_authToken=${mirror_auth_token}" > "${mirror_userconfig}"

  IFS=',' read -r -a mirror_dist_tags <<< "${mirror_dist_tags_csv}"
  for dist_tag in "${mirror_dist_tags[@]}"; do
    [[ -n "${dist_tag}" ]] || continue
    echo "Mirroring openclaw@${package_version} onto dist-tag ${dist_tag}"
    NPM_CONFIG_USERCONFIG="${mirror_userconfig}" \
      npm dist-tag add "openclaw@${package_version}" "${dist_tag}"
  done
fi
