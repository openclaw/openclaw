#!/usr/bin/env bash

capture_backup_rollback() {
  local required
  required="$(node scripts/e2e/lib/upgrade-survivor/backup-rollback.mjs eligibility \
    "$baseline_version" "$ARTIFACT_ROOT/backup-rollback.json")"
  [ "$required" = "required" ] || return 0

  local retained_prefix="$RUNTIME_ROOT/backup-rollback/baseline-prefix"
  mkdir -p "$RUNTIME_ROOT/backup-rollback"
  # Retain the complete npm prefix: package-local and prefix-level dependencies
  # must still resolve after the installed updater replaces its own runtime.
  cp -a "$npm_config_prefix" "$retained_prefix"
  local retained_package
  retained_package="$(openclaw_e2e_package_root "$retained_prefix")"
  local retained_entry
  retained_entry="$(openclaw_e2e_package_entrypoint "$retained_package")"
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" \
    node scripts/e2e/lib/upgrade-survivor/backup-rollback.mjs capture \
    "$ARTIFACT_ROOT/schema-before.json" "$retained_package" "$retained_entry" \
    "$RUNTIME_ROOT/backup-rollback" "$ARTIFACT_ROOT/backup-rollback.json"
}

verify_backup_rollback() {
  stop_gateway
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" \
    node scripts/e2e/lib/upgrade-survivor/backup-rollback.mjs verify \
    "$ARTIFACT_ROOT/backup-rollback.json" "$ARTIFACT_ROOT/schema-after.json"
}
