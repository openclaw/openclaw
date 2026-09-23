#!/usr/bin/env bash
# Host-only snapshot preparation/publication shared by upgrade harnesses.
prepare_diagnostics_capture() {
  # A previous attempt must never be published as this container's evidence.
  if [ -L "$ARTIFACT_DIR" ] || [ -L "$ARTIFACT_DIR/diagnostics" ] || [ -L "$ARTIFACT_DIR/missing-load-path" ] ||
    ! rm -f "$ARTIFACT_DIR/diagnostics/raw.json" "$ARTIFACT_DIR/diagnostics/post-core.json" "$ARTIFACT_DIR/diagnostics/last-rpc" "$ARTIFACT_DIR/summary.json" \
      "$ARTIFACT_DIR/update.json" "$ARTIFACT_DIR/repair.json" "$ARTIFACT_DIR/recovery-update.json" \
      "$ARTIFACT_DIR/candidate-cohort.json" \
      "$ARTIFACT_DIR"/legacy-operator-baseline-turn.{out,err} \
      "$ARTIFACT_DIR"/legacy-operator-candidate-turn.{out,err} \
      "$ARTIFACT_DIR/missing-load-path/baseline-gateway.log" \
      "$ARTIFACT_DIR/missing-load-path/baseline-gateway-convergence-refusal.log" \
      "$ARTIFACT_DIR/sibling-registrations.jsonl" "$ARTIFACT_DIR/sibling-source.json" "$ARTIFACT_DIR/sibling-canary.json" \
      "$ARTIFACT_DIR"/diagnostics/doctor-*.json; then
    echo "Upgrade survivor diagnostics missing: private capture setup failed." >&2
    return 0
  fi
  diagnostics_ready=1
}
publish_diagnostics() {
  # This directory is host-owned and is never mounted into the candidate.
  local log_root="${OPENCLAW_DOCKER_ALL_LOG_DIR:-$ROOT_DIR/.artifacts/docker-tests}"
  local diagnostic_dir
  local private_root
  private_root="$(cd "$ARTIFACT_DIR" && pwd)" || return
  mkdir -p "$log_root" || return
  log_root="$(cd "$log_root" && pwd)" || return
  diagnostic_dir="$(mktemp -d "$log_root/upgrade-survivor-$LANE_ARTIFACT_SUFFIX.XXXXXX")" || return
  (cd "$HARNESS_ROOT_DIR" && node --import "$HARNESS_ROOT_DIR/scripts/tsx.mjs" \
    "$HARNESS_ROOT_DIR/scripts/upgrade-survivor-diagnostics.mjs" \
    publish "$private_root" "$diagnostic_dir" "${1:-failed}")
}
