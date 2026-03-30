#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"

if [[ "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/openclaw-npm-publish.sh --publish" >&2
  exit 2
fi

package_version="$(node -p "require('./package.json').version")"
current_beta_version="$(npm view openclaw dist-tags.beta 2>/dev/null || true)"
mapfile -t publish_plan < <(
  PACKAGE_VERSION="${package_version}" CURRENT_BETA_VERSION="${current_beta_version}" node --import tsx --input-type=module <<'EOF'
import { resolveNpmPublishPlan } from "./scripts/openclaw-npm-release-check.ts";

const plan = resolveNpmPublishPlan(
  process.env.PACKAGE_VERSION ?? "",
  process.env.CURRENT_BETA_VERSION,
);
console.log(plan.channel);
console.log(plan.publishTag);
console.log(plan.mirrorDistTags.join(","));
EOF
)

release_channel="${publish_plan[0]}"
publish_tag="${publish_plan[1]}"
mirror_dist_tags_csv="${publish_plan[2]:-}"
publish_cmd=(npm publish --access public --tag "${publish_tag}" --provenance)

echo "Resolved package version: ${package_version}"
echo "Current beta dist-tag: ${current_beta_version:-<missing>}"
echo "Resolved release channel: ${release_channel}"
echo "Resolved publish tag: ${publish_tag}"
echo "Resolved mirror dist-tags: ${mirror_dist_tags_csv:-<none>}"
echo "Publish auth: GitHub OIDC trusted publishing"

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

"${publish_cmd[@]}"

if [[ -n "${mirror_dist_tags_csv}" ]]; then
  IFS=',' read -r -a mirror_dist_tags <<< "${mirror_dist_tags_csv}"
  for dist_tag in "${mirror_dist_tags[@]}"; do
    [[ -n "${dist_tag}" ]] || continue
    echo "Mirroring openclaw@${package_version} onto dist-tag ${dist_tag}"
    npm dist-tag add "openclaw@${package_version}" "${dist_tag}"
  done
fi
