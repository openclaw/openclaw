#!/usr/bin/env bash

# Uses the published updater and the survivor's real Gateway/systemd fixture.
run_abandoned_update_survivor() {
  if { [ "$baseline_version" != "2026.9.4" ] && [ "$baseline_version" != "2026.9.3" ]; } || [ "$UPDATE_RESTART_MODE" != "auto-auth" ]; then
    echo "abandoned-update requires baseline openclaw@2026.9.4 or openclaw@2026.9.3 and auto-auth service mode" >&2
    return 1
  fi
  if [ "$CANDIDATE_KIND" != "tarball" ]; then
    echo "abandoned-update requires a packed candidate tarball" >&2
    return 1
  fi
  local helper="scripts/e2e/lib/upgrade-survivor/abandoned-update.mjs"
  local gateway_config
  gateway_config="$(cat scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json)"
  phase configure-gateway openclaw config set gateway "$gateway_config" --strict-json
  phase disable-fixture-plugins openclaw config set plugins.enabled false --strict-json
  phase validate-baseline-config validate_baseline_config
  phase resolve-candidate resolve_candidate_version
  phase package-identities node "$helper" packages "$CANDIDATE_SPEC" "$(package_root)" "$ARTIFACT_ROOT"
  phase prepare-update-restart-probe prepare_update_restart_probe
  # The shipped ledger table is first-use-only, so let its own CLI create it.
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update --dry-run --yes --no-restart \
    --tag "$(candidate_update_spec)" --json >"$ARTIFACT_ROOT/baseline-preview.json" 2>"$ARTIFACT_ROOT/baseline-preview.err"
  phase update-candidate update_candidate
  phase assert-candidate-build node "$helper" installed "$(package_root)" "$ARTIFACT_ROOT"
  if [ "$update_repair_required" != "0" ]; then
    echo "ledger-only survivor unexpectedly needs post-core repair" >&2
    return 1
  fi
  # This setup occurs before the repair boundary. Only the candidate serves its new bytes.
  phase start-candidate-service run_update_restart_probe_gateway install 18789 "$COMMAND_TIMEOUT"
  phase gateway-probes check_gateway_probes
  phase gateway-status check_gateway_status
  # Current published update drivers supersede inactive admissions themselves.
  # Seed repair's legacy input after that separate shipped-parent upgrade completes.
  phase seed-abandoned-run node "$helper" seed "$OPENCLAW_STATE_DIR" "$ARTIFACT_ROOT"
  phase assert-no-automatic-recovery node "$helper" preserved "$OPENCLAW_STATE_DIR" "$ARTIFACT_ROOT"
  node "$helper" service "$SYSTEMCTL_SHIM_PID_FILE" "$SYSTEMCTL_SHIM_LOG" \
    "$ARTIFACT_ROOT/repair-service-before.json"

  local repair_status=0 status_status=0
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update repair --yes --json \
    >"$REPAIR_JSON" 2>"$ARTIFACT_ROOT/repair.err" || repair_status=$?
  printf '%s\n' "$repair_status" >"$ARTIFACT_ROOT/repair.exit"
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update status --json \
    >"$ARTIFACT_ROOT/update-status.json" 2>"$ARTIFACT_ROOT/update-status.err" || status_status=$?
  printf '%s\n' "$status_status" >"$ARTIFACT_ROOT/update-status.exit"
  node "$helper" service "$SYSTEMCTL_SHIM_PID_FILE" "$SYSTEMCTL_SHIM_LOG" \
    "$ARTIFACT_ROOT/repair-service-after.json"
  # Save both outcomes before assertions so the same fixture retains the origin/main refusal.
  phase assert-ledger-recovery node "$helper" recovered "$OPENCLAW_STATE_DIR" "$ARTIFACT_ROOT"
  phase repaired-gateway-probes check_gateway_probes
  phase repaired-gateway-status check_gateway_status

  phase seed-post-core-run node "$helper" seed-post-core "$OPENCLAW_STATE_DIR" "$ARTIFACT_ROOT"
  node "$helper" service "$SYSTEMCTL_SHIM_PID_FILE" "$SYSTEMCTL_SHIM_LOG" \
    "$ARTIFACT_ROOT/full-repair-service-before.json"
  repair_status=0
  status_status=0
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update repair --yes --json \
    >"$ARTIFACT_ROOT/full-repair.json" 2>"$ARTIFACT_ROOT/full-repair.err" || repair_status=$?
  printf '%s\n' "$repair_status" >"$ARTIFACT_ROOT/full-repair.exit"
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update status --json \
    >"$ARTIFACT_ROOT/full-repair-status.json" 2>"$ARTIFACT_ROOT/full-repair-status.err" || status_status=$?
  printf '%s\n' "$status_status" >"$ARTIFACT_ROOT/full-repair-status.exit"
  node "$helper" service "$SYSTEMCTL_SHIM_PID_FILE" "$SYSTEMCTL_SHIM_LOG" \
    "$ARTIFACT_ROOT/full-repair-service-after.json"
  phase assert-post-core-recovery node "$helper" recovered-post-core "$OPENCLAW_STATE_DIR" "$ARTIFACT_ROOT"
  phase restored-gateway-probes check_gateway_probes
  phase restored-gateway-status check_gateway_status
  phase deadline-channel openclaw config set update.channel stable
  local deadline_hook
  deadline_hook="$(node "$helper" deadline-hook "$(package_root)" "$ARTIFACT_ROOT")"
  node "$helper" service "$SYSTEMCTL_SHIM_PID_FILE" "$SYSTEMCTL_SHIM_LOG" \
    "$ARTIFACT_ROOT/deadline-service-before.json"
  repair_status=0
  NODE_OPTIONS="${NODE_OPTIONS:-} --import $deadline_hook" \
    openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update repair --yes --json --channel stable --timeout 15 \
    >"$ARTIFACT_ROOT/deadline-repair.json" 2>"$ARTIFACT_ROOT/deadline-repair.err" || repair_status=$?
  printf '%s\n' "$repair_status" >"$ARTIFACT_ROOT/deadline-repair.exit"
  node "$helper" service "$SYSTEMCTL_SHIM_PID_FILE" "$SYSTEMCTL_SHIM_LOG" \
    "$ARTIFACT_ROOT/deadline-service-after.json"
  phase assert-deadline-recovery node "$helper" deadline-verify "$OPENCLAW_STATE_DIR" "$ARTIFACT_ROOT"
  phase deadline-gateway-probes check_gateway_probes
  phase deadline-gateway-status check_gateway_status
  echo "Published $baseline_version stale run repaired without interruption; post-core repair restored the service under its update parent."
}
