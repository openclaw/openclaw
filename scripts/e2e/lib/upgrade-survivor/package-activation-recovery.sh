#!/usr/bin/env bash

run_package_activation_recovery_survivor() {
  if { [ "$baseline_version" != "2026.9.8" ] && [ "$baseline_version" != "2026.9.9" ] &&
    { [ "$SCENARIO" != "package-stranded-first-hop" ] || [ "$baseline_version" != "2026.9.7" ]; }; } ||
    [ "$CANDIDATE_KIND" != "tarball" ] || [ "$UPDATE_RESTART_MODE" != "manual" ]; then
    echo "package activation recovery requires published 9.8/9.9, an exact packed candidate, and manual restart" >&2
    return 1
  fi
  local fixture="scripts/e2e/lib/upgrade-survivor/package-activation-recovery.mjs"
  local fault="publication-complete" result=0 target="${CANDIDATE_SPEC#file:}"
  [ "$SCENARIO" != "package-verification-recovery" ] || fault="verification"
  phase configure-recovery-gateway openclaw config set gateway "$(cat scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json)" --strict-json
  phase disable-recovery-plugins openclaw config set plugins.enabled false --strict-json
  phase validate-recovery-baseline validate_baseline_config
  phase resolve-recovery-candidate resolve_candidate_version
  if [ "$SCENARIO" = "package-stranded-first-hop" ]; then
    mkdir -p "$RUNTIME_ROOT/stranded-target"
    phase pack-released-stranded-target openclaw_prepublish_plugin_registry_run_published \
      npm pack openclaw@2026.9.8 --pack-destination "$RUNTIME_ROOT/stranded-target" --ignore-scripts --json \
      >"$ARTIFACT_ROOT/stranded-target-package.json"
    target="$RUNTIME_ROOT/stranded-target/openclaw-2026.9.8.tgz"
  fi
  phase capture-recovery-packages node "$fixture" setup "$ARTIFACT_ROOT" "$(package_root)" "$target" "$fault" "$OPENCLAW_CONFIG_PATH"
  # Do not route this deliberate failure through the normal success classifier.
  # This uses the unmodified published updater; only its external dependencies
  # observe the durable boundary and terminate/fail the relevant real process.
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" env OPENCLAW_SURVIVOR_PACKAGE_FAULT="$ARTIFACT_ROOT/package-activation-fault.json" \
    NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=$PWD/scripts/e2e/lib/upgrade-survivor/package-activation-fault.mjs" \
    openclaw update --tag "file:$target" --yes --no-restart --json \
    >"$ARTIFACT_ROOT/interrupted-update.json" 2>"$ARTIFACT_ROOT/interrupted-update.err" || result=$?
  printf '%s\n' "$result" >"$ARTIFACT_ROOT/interrupted-update.exit"
  phase assert-authentic-interruption node "$fixture" interrupted "$ARTIFACT_ROOT" "$result"
  if [ "$SCENARIO" = "package-stranded-first-hop" ]; then
    # This deliberately absent target distinguishes the old admission refusal
    # from any download, candidate execution, or unsupported cross-root repair.
    local absent="$RUNTIME_ROOT/candidate-must-not-be-opened.tgz"
    [ ! -e "$absent" ] || return 1
    result=0
    openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update --tag "file:$absent" --yes --no-restart --json \
      >"$ARTIFACT_ROOT/stranded-update.json" 2>"$ARTIFACT_ROOT/stranded-update.err" || result=$?
    phase assert-unchanged-old-first-hop node "$fixture" stranded "$ARTIFACT_ROOT" "$result"
    installed_version="$(read_installed_version)"
    candidate_install_mode="not-reached"
    update_outcome="expected-admission-refusal"
    run_completed="1"
    return 0
  fi
  result=0
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update repair --yes --no-restart --json \
    >"$REPAIR_JSON" 2>"$ARTIFACT_ROOT/repair.err" || result=$?
  phase assert-public-repair node "$fixture" repaired "$ARTIFACT_ROOT" "$result"
  result=0
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update repair --yes --no-restart --json \
    >"$ARTIFACT_ROOT/repeat-repair.json" 2>"$ARTIFACT_ROOT/repeat-repair.err" || result=$?
  phase assert-repeat-repair node "$fixture" repeat "$ARTIFACT_ROOT" "$result"
  local future="$RUNTIME_ROOT/recovery-next.tgz"
  phase pack-distinct-next-update node scripts/e2e/lib/update-first-hop-package-fixtures.mjs \
    future-tarball "${CANDIDATE_SPEC#file:}" "$future" >"$ARTIFACT_ROOT/recovery-next-package.json"
  result=0
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update --tag "file:$future" --yes --no-restart --json \
    >"$ARTIFACT_ROOT/next-update.json" 2>"$ARTIFACT_ROOT/next-update.err" || result=$?
  phase assert-distinct-next-update node "$fixture" next "$ARTIFACT_ROOT" "$result" "$future"
  installed_version="$(read_installed_version)"
  update_outcome="success"
  run_completed="1"
}
