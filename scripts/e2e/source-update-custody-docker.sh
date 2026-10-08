#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

if [ "$(printenv OPENCLAW_QA_ALLOW_SOURCE_CUSTODY_PROOF || :)" != 1 ]; then
  echo "Source custody proof is opt-in; set OPENCLAW_QA_ALLOW_SOURCE_CUSTODY_PROOF=1" >&2
  exit 2
fi
# 270min is an upper envelope, not measured runtime. Reserve the final 180s
# for daemon cleanup and return before the scheduler's deadline (outer job: 285min).
lane_started="$(date +%s)"
lane_work_deadline=$((lane_started + 270 * 60 - 180))
lane_cleanup_deadline=$((lane_started + 270 * 60 - 30))
phase_budget() {
  DOCKER_E2E_PHASE_DEADLINE=$(( $(date +%s) + $1 ))
  [ "$DOCKER_E2E_PHASE_DEADLINE" -le "$lane_work_deadline" ] || DOCKER_E2E_PHASE_DEADLINE=$lane_work_deadline
  DOCKER_E2E_CLEANUP_DEADLINE=$((DOCKER_E2E_PHASE_DEADLINE + 120))
  [ "$DOCKER_E2E_CLEANUP_DEADLINE" -le "$lane_cleanup_deadline" ] || DOCKER_E2E_CLEANUP_DEADLINE=$lane_cleanup_deadline
  export OPENCLAW_SOURCE_CUSTODY_DEADLINE=$((DOCKER_E2E_PHASE_DEADLINE - 30))
}
SOURCE_ROOT="$(printenv OPENCLAW_DOCKER_E2E_REPO_ROOT || :)"
[ -n "$SOURCE_ROOT" ] || SOURCE_ROOT="$ROOT_DIR"
SOURCE_SHA="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
test "$SOURCE_SHA" = "$(printenv OPENCLAW_DOCKER_E2E_SELECTED_SHA)"
test -z "$(git -C "$SOURCE_ROOT" status --porcelain --untracked-files=no)"
export OPENCLAW_SOURCE_CUSTODY_CANDIDATE_SHA="$SOURCE_SHA"
ARTIFACT_PARENT="$(printenv OPENCLAW_DOCKER_ALL_LOG_DIR || :)"
[ -n "$ARTIFACT_PARENT" ] || ARTIFACT_PARENT="$SOURCE_ROOT/.artifacts/docker-tests"
mkdir -p "$ARTIFACT_PARENT"
ARTIFACT_DIR="$(mktemp -d "$ARTIFACT_PARENT/source-update-custody.XXXXXX")"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"
mkdir -p "$ARTIFACT_DIR/prepare"
chmod a+rwx "$ARTIFACT_DIR" "$ARTIFACT_DIR/prepare"
# CID authority is private host state, never inside a child/proof bind mount.
custody_dir="$(mktemp -d "$ARTIFACT_DIR/custody.XXXXXX")"
seed_cidfile="$custody_dir/seed.cid"
seed_pending=0
seed_cleanup_attempted=0
seed_commit_pending=0
prepared_image=""
cleanup() {
  local status="$1"
  trap - EXIT
  local DOCKER_E2E_PHASE_DEADLINE="$lane_cleanup_deadline"
  local DOCKER_COMMAND_TIMEOUT=60s
  if [ "$seed_pending" = 1 ] && [ "$seed_cleanup_attempted" = 0 ] && [ "$seed_commit_pending" = 0 ]; then
    seed_cleanup_attempted=1
    if docker_e2e_cleanup_container_cidfile "$seed_cidfile"; then
      seed_pending=0
    else
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  if [ "$seed_pending" = 0 ] && [ "${DOCKER_E2E_PACKAGE_CUSTODY_UNRESOLVED:-0}" != 1 ]; then
    if [ -n "$prepared_image" ]; then
      docker_e2e_docker_cmd image rm "$prepared_image" >"$ARTIFACT_DIR/image-cleanup.log" 2>&1 || {
        [ "$status" -ne 0 ] || status=1
      }
    fi
    rmdir "$custody_dir" || { [ "$status" -ne 0 ] || status=1; }
  else
    echo "Unsettled Docker custody retained: $custody_dir; inputs: $ARTIFACT_DIR" >&2
    [ "$status" -ne 0 ] || status=1
  fi
  return "$status"
}
trap 'status=$?; cleanup "$status"; exit $?' EXIT

# Build/inspect/pull, released install, wait, logs and commit share this phase;
# none can renew the preparation budget. COW cells preserve observed seed state.
phase_budget 2400
IMAGE="$(docker_e2e_resolve_image openclaw-source-update-custody OPENCLAW_DOCKER_E2E_BARE_IMAGE)"
docker_e2e_build_or_reuse "$IMAGE" source-update-custody "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare
seed_pending=1
DOCKER_COMMAND_TIMEOUT=2400s docker_e2e_run_detached_with_harness \
  --cidfile "$seed_cidfile" --init --memory 16g --user root \
  -e OPENCLAW_SOURCE_CUSTODY_CANDIDATE_SHA -e OPENCLAW_SOURCE_CUSTODY_DEADLINE \
  -v "$ARTIFACT_DIR/prepare:/proof" "$IMAGE" bash -c '
    set -euo pipefail
    rm -f -- /node_modules
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl
    rm -rf /var/lib/apt/lists/*
    exec runuser -u appuser -- node scripts/e2e/lib/source-update-custody/driver.mjs prepare
  ' >/dev/null
seed_cid="$(cat "$seed_cidfile")"
[[ "$seed_cid" =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid seed CID; retaining custody" >&2; exit 1; }
seed_status="$(DOCKER_COMMAND_TIMEOUT=2400s docker_e2e_docker_cmd wait "$seed_cid")"
docker_e2e_docker_cmd logs "$seed_cid" >"$ARTIFACT_DIR/prepare/container.log" 2>&1
[ "$seed_status" = 0 ]
docker_e2e_docker_cmd inspect "$seed_cid" >"$ARTIFACT_DIR/prepare/container.json"
seed_commit_pending=1
prepared_image="$(docker_e2e_docker_cmd commit "$seed_cid")"
[[ "$prepared_image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Unresolved seed commit; retaining custody" >&2; exit 1; }
seed_commit_pending=0
printf '%s\n' "$prepared_image" >"$ARTIFACT_DIR/prepared-image.txt"
seed_cleanup_attempted=1
DOCKER_E2E_PHASE_DEADLINE="$DOCKER_E2E_CLEANUP_DEADLINE" docker_e2e_cleanup_container_cidfile "$seed_cidfile"
seed_pending=0

for cell in legacy escaped active stopped; do
  mkdir -p "$ARTIFACT_DIR/$cell"
  chmod a+rwx "$ARTIFACT_DIR/$cell"
  # The first-hop ceiling is also capped by the ORIGINAL whole-lane deadline.
  phase_budget 3200
  TMPDIR="$custody_dir" DOCKER_COMMAND_TIMEOUT=3200s docker_e2e_run_with_harness \
    --init --memory 16g --user appuser \
    -e OPENCLAW_SOURCE_CUSTODY_CANDIDATE_SHA -e OPENCLAW_SOURCE_CUSTODY_DEADLINE \
    -v "$ARTIFACT_DIR/$cell:/proof" "$prepared_image" \
    node scripts/e2e/lib/source-update-custody/driver.mjs cell "$cell"
done
cleanup 0
node - "$ARTIFACT_DIR" "$SOURCE_SHA" <<'NODE'
const fs = require("node:fs"), assert = require("node:assert/strict");
const [root, candidate] = process.argv.slice(2);
const cells = ["legacy", "escaped", "active", "stopped"].map(cell => {
  const value = JSON.parse(fs.readFileSync(root + "/" + cell + "/summary.json", "utf8"));
  assert.equal(value.cell, cell);
  assert.equal(value.candidate, candidate);
  return value;
});
fs.writeFileSync(root + "/summary.json", JSON.stringify({ candidate, cells }, null, 2) + "\n");
NODE
