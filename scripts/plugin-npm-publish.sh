#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
package_dir="${2:-}"

if [[ "${mode}" != "--dry-run" && "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--publish] <package-dir>" >&2
  exit 2
fi

if [[ -z "${package_dir}" ]]; then
  echo "missing package dir" >&2
  exit 2
fi

package_name="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.name)' "${package_dir}")"
package_version="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.version)' "${package_dir}")"
current_beta_version="$(npm view "${package_name}" dist-tags.beta 2>/dev/null || true)"
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

echo "Resolved package dir: ${package_dir}"
echo "Resolved package name: ${package_name}"
echo "Resolved package version: ${package_version}"
echo "Current beta dist-tag: ${current_beta_version:-<missing>}"
echo "Resolved release channel: ${release_channel}"
echo "Resolved publish tag: ${publish_tag}"
echo "Resolved mirror dist-tags: ${mirror_dist_tags_csv:-<none>}"
echo "Publish auth: GitHub OIDC trusted publishing"

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

if [[ "${mode}" == "--dry-run" ]]; then
  exit 0
fi

(
  cd "${package_dir}"
  "${publish_cmd[@]}"

  if [[ -n "${mirror_dist_tags_csv}" ]]; then
    IFS=',' read -r -a mirror_dist_tags <<< "${mirror_dist_tags_csv}"
    for dist_tag in "${mirror_dist_tags[@]}"; do
      [[ -n "${dist_tag}" ]] || continue
      echo "Mirroring ${package_name}@${package_version} onto dist-tag ${dist_tag}"
      npm dist-tag add "${package_name}@${package_version}" "${dist_tag}"
    done
  fi
)
