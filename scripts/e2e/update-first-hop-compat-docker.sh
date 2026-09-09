#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Proves the selected first-hop method and a fresh updater without legacy chunks.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

if [ "${OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP:-0}" != "1" ]; then
  echo "blocked destructive package self-update; set OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 to run" >&2
  exit 2
fi

IMAGE_NAME="$(
  docker_e2e_resolve_image \
    "openclaw-update-first-hop-compat-e2e" \
    OPENCLAW_UPDATE_FIRST_HOP_E2E_IMAGE
)"
SKIP_BUILD="${OPENCLAW_UPDATE_FIRST_HOP_E2E_SKIP_BUILD:-0}"
DOCKER_RUN_TIMEOUT="${OPENCLAW_UPDATE_FIRST_HOP_DOCKER_RUN_TIMEOUT:-1200s}"
ARTIFACT_DIR="${OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/update-first-hop-compat}"
SOURCE_PACKAGE="${OPENCLAW_UPDATE_FIRST_HOP_SOURCE_PACKAGE_TGZ:-}"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-update-first-hop.XXXXXX")"
PACKAGE_TGZ=""
FIXTURE_HELPER="$ROOT_DIR/scripts/e2e/lib/update-first-hop-package-fixtures.mjs"

cleanup() {
  local exit_status="$?"
  trap - EXIT
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
  rm -rf "$FIXTURE_ROOT"
  exit "$exit_status"
}
trap cleanup EXIT

mkdir -p "$ARTIFACT_DIR" "$FIXTURE_ROOT/source" "$FIXTURE_ROOT/packages"
chmod -R a+rwX "$ARTIFACT_DIR" || true

if [ -n "$SOURCE_PACKAGE" ] && [ ! -f "$SOURCE_PACKAGE" ]; then
  echo "source package tarball does not exist: $SOURCE_PACKAGE" >&2
  exit 2
fi

PACKAGE_TGZ="$(
  docker_e2e_prepare_package_tgz \
    update-first-hop-compat \
    "${OPENCLAW_UPDATE_FIRST_HOP_CANDIDATE_PACKAGE_TGZ:-}"
)"
docker_e2e_package_mount_args "$PACKAGE_TGZ" /tmp/openclaw-update-first-hop-candidate.tgz

mkdir -p "$FIXTURE_ROOT/packages/negative" "$FIXTURE_ROOT/packages/future"
tar -xzf "$PACKAGE_TGZ" -C "$FIXTURE_ROOT/packages/negative"
tar -xzf "$PACKAGE_TGZ" -C "$FIXTURE_ROOT/packages/future"
node "$FIXTURE_HELPER" negative "$FIXTURE_ROOT/packages/negative/package"
node "$FIXTURE_HELPER" future "$FIXTURE_ROOT/packages/future/package"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$FIXTURE_ROOT/negative.tgz" \
  -C "$FIXTURE_ROOT/packages/negative" package
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$FIXTURE_ROOT/future.tgz" \
  -C "$FIXTURE_ROOT/packages/future" package

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  update-first-hop-compat \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  bare \
  "$SKIP_BUILD"

SOURCE_VERSIONS=("")
if [ -z "$SOURCE_PACKAGE" ]; then
  SOURCE_VERSIONS=()
  node "$FIXTURE_HELPER" sources "$FIXTURE_ROOT/packages/negative/package" \
    >"$FIXTURE_ROOT/source-versions.txt"
  while IFS= read -r version; do
    SOURCE_VERSIONS+=("$version")
  done <"$FIXTURE_ROOT/source-versions.txt"
fi

for version in "${SOURCE_VERSIONS[@]}"; do
  lane_artifact_dir="$ARTIFACT_DIR"
  source_package="$SOURCE_PACKAGE"
  if [ -n "$version" ]; then
    lane_artifact_dir="$ARTIFACT_DIR/$version"
    mkdir -p "$lane_artifact_dir"
    npm pack "openclaw@$version" --ignore-scripts --json --min-release-age=0 \
      --pack-destination "$FIXTURE_ROOT/source" >"$lane_artifact_dir/source-pack.json"
    source_package="$FIXTURE_ROOT/source/$(node -e '
      const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (!Array.isArray(result) || result.length !== 1 || !result[0]?.filename) process.exit(1);
      process.stdout.write(result[0].filename);
    ' "$lane_artifact_dir/source-pack.json")"
  fi
  chmod a+rwx "$lane_artifact_dir"
  node "$FIXTURE_HELPER" source "$FIXTURE_ROOT/packages/negative/package" \
    "$source_package" "$version" >"$lane_artifact_dir/source.json"
  expected_missing_chunk="$(node -e '
    const source = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(source.expectedMissingChunk ?? "");
  ' "$lane_artifact_dir/source.json")"
  {
    printf 'source=%s\n' "$source_package"
    printf 'candidate=%s\n' "$PACKAGE_TGZ"
    printf 'expected_missing_chunk=%s\n' "$expected_missing_chunk"
    shasum -a 256 "$source_package" "$PACKAGE_TGZ" "$FIXTURE_ROOT/negative.tgz" "$FIXTURE_ROOT/future.tgz"
    printf '\nsource_build_info=' && tar -xOf "$source_package" package/dist/build-info.json
    printf '\ncandidate_build_info=' && tar -xOf "$PACKAGE_TGZ" package/dist/build-info.json
    printf '\nfuture_build_info=' && tar -xOf "$FIXTURE_ROOT/future.tgz" package/dist/build-info.json
  } >"$lane_artifact_dir/inputs.txt"

  echo "Running packaged updater first-hop compatibility Docker E2E (${version:-explicit source})..."
  docker_e2e_run_with_harness \
    -e OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 \
    -e OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR=/tmp/openclaw-update-first-hop-artifacts \
    -e OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK="$expected_missing_chunk" \
    -v "$lane_artifact_dir:/tmp/openclaw-update-first-hop-artifacts" \
    -v "$(docker_e2e_abs_path "$source_package"):/tmp/openclaw-update-first-hop-source.tgz:ro" \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -v "$FIXTURE_ROOT/negative.tgz:/tmp/openclaw-update-first-hop-negative.tgz:ro" \
    -v "$FIXTURE_ROOT/future.tgz:/tmp/openclaw-update-first-hop-future.tgz:ro" \
    "$IMAGE_NAME" \
    timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" \
    bash scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh
done

if [ -z "$SOURCE_PACKAGE" ]; then
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const [root, ...versions] = process.argv.slice(1);
    const sources = versions.map(version => JSON.parse(fs.readFileSync(path.join(root, version, "summary.json"), "utf8")));
    fs.writeFileSync(path.join(root, "summary.json"), `${JSON.stringify({ sources }, null, 2)}\n`);
  ' "$ARTIFACT_DIR" "${SOURCE_VERSIONS[@]}"
fi
