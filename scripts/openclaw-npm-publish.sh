#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"

if [[ "${mode}" != "--dry-run" && "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/openclaw-npm-publish.sh [--dry-run|--publish]" >&2
  exit 2
fi

package_version="$(node -p "require('./package.json').version")"
publish_cmd=(npm publish --access public --provenance)

if [[ "${package_version}" == *-beta.* ]]; then
  publish_cmd=(npm publish --access public --tag beta --provenance)
fi

if [[ -n "${NODE_AUTH_TOKEN:-}" ]]; then
  if [[ "${mode}" == "--dry-run" ]]; then
    echo 'Would write npm auth config to $HOME/.npmrc using NODE_AUTH_TOKEN'
  else
    printf '//registry.npmjs.org/:_authToken=%s\n' "${NODE_AUTH_TOKEN}" > "${HOME}/.npmrc"
  fi
fi

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

if [[ "${mode}" == "--dry-run" ]]; then
  exit 0
fi

"${publish_cmd[@]}"
