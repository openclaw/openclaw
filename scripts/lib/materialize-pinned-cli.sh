#!/usr/bin/env bash

# Sourced by the pinned CLI entrypoints before release credentials are exposed.
package_json="${source_root}/package.json"
package_lock="${source_root}/package-lock.json"
test -f "${package_json}"
test -f "${package_lock}"
if [[ -e "${destination}" || -L "${destination}" ]]; then
  echo "${cli_label} CLI destination must not already exist: ${destination}" >&2
  exit 1
fi

install -d -m 0700 "${destination}"
install -m 0600 "${package_json}" "${destination}/package.json"
install -m 0600 "${package_lock}" "${destination}/package-lock.json"

lock_sha256="$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));' "${package_lock}")"
[[ "${lock_sha256}" == "${expected_lock_sha256}" ]] || {
  echo "Pinned ${cli_label} CLI lock SHA-256 mismatch." >&2
  exit 1
}
cli_integrity="$(node -p 'require(require("node:path").resolve(process.argv[1])).packages[`node_modules/${process.argv[2]}`].integrity' "${package_lock}" "${cli_package}")"
[[ "${cli_integrity}" == "${expected_integrity}" ]] || {
  echo "Pinned ${cli_label} CLI integrity mismatch." >&2
  exit 1
}

# npm 12 misvalidates the lockfile root with --prefix; use the copied project.
(
  cd "${destination}"
  npm ci \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --omit=dev
)

cli_version="$(node -p 'require(require("node:path").join(process.argv[1], "node_modules", process.argv[2], "package.json")).version' "${destination}" "${cli_package}")"
[[ "${cli_version}" == "${expected_version}" ]] || {
  echo "Pinned ${cli_label} CLI version mismatch: ${cli_version}" >&2
  exit 1
}
test -x "${destination}/node_modules/.bin/${cli_package}"
cli="${destination}/node_modules/.bin/${cli_package}"
if [[ -n "${additional_bin}" ]]; then
  test -x "${destination}/node_modules/.bin/${additional_bin#*=}"
fi

echo "Materialized ${cli_package}@${cli_version} from lock ${lock_sha256}."
if [[ -n "${github_output}" ]]; then
  {
    echo "cli=${cli}"
    if [[ -n "${additional_bin}" ]]; then
      echo "${additional_bin%%=*}=${destination}/node_modules/.bin/${additional_bin#*=}"
    fi
    echo "integrity=${cli_integrity}"
    echo "lock_sha256=${lock_sha256}"
    echo "version=${cli_version}"
  } >> "${github_output}"
fi
