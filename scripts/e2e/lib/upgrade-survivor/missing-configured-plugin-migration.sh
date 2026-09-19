#!/usr/bin/env bash

run_missing_configured_plugin_migration() {
  if [ "$baseline_version" != "2026.9.2" ] || [ "$UPDATE_RESTART_MODE" != "manual" ]; then
    echo "missing-configured-plugin-migration requires the published 2026.9.2 baseline and manual restart" >&2
    return 1
  fi
  local helper="scripts/e2e/lib/upgrade-survivor/missing-configured-plugin-migration.mjs"
  local fixture_root="$ARTIFACT_ROOT/missing-plugin"
  local port_file="$fixture_root/registry-ports.json"
  mkdir -p "$fixture_root"
  rm -f "$port_file"
  phase configure-missing-plugin-registry configure_plugin_registry
  phase configure-missing-plugin-clawhub configure_clawhub_fixture
  node "$helper" serve "$port_file" "$NPM_CONFIG_REGISTRY" "$OPENCLAW_CLAWHUB_URL" \
    >"$fixture_root/registry.log" 2>&1 &
  missing_plugin_registry_pid="$!"
  wait_for_fixture_port "$missing_plugin_registry_pid" "$port_file" "$fixture_root/registry.log" "missing Codex registry"
  export NPM_CONFIG_REGISTRY="$(node -p 'require(process.argv[1]).npm' "$port_file")"
  export npm_config_registry="$NPM_CONFIG_REGISTRY"
  export BUN_CONFIG_REGISTRY="$NPM_CONFIG_REGISTRY"
  export OPENCLAW_CLAWHUB_URL="$(node -p 'require(process.argv[1]).clawhub' "$port_file")"
  export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL="$NPM_CONFIG_REGISTRY"

  # Add the retired inputs after baseline validation so only the candidate owns them.
  phase seed-missing-plugin-inputs node "$helper" seed
  phase update-missing-plugin update_candidate
  [ "$update_outcome" = "success" ] && [ "$update_exit_code" = "0" ] || {
    echo "Missing Codex must leave a successful update, not a repair-required result" >&2
    return 1
  }
  phase assert-deferred-update node "$helper" pending post-update
  phase start-with-missing-plugin start_gateway
  phase missing-plugin-health check_gateway_probes
  phase missing-plugin-status check_gateway_status
  phase assert-deferred-startup node "$helper" pending post-startup
  phase capture-missing-plugin-diagnostics node "$helper" diagnostics
  phase stop-missing-plugin-gateway stop_gateway
  phase doctor-with-missing-plugin run_doctor
  phase assert-deferred-doctor node "$helper" pending post-doctor

  phase expose-codex-artifact node "$helper" available "$port_file"
  phase resume-plugin-migration run_doctor
  phase assert-resumed-plugin-migration node "$helper" resumed "$candidate_version"
  phase validate-resumed-config validate_post_doctor_config
  echo "Missing Codex upgrade passed: 2026.9.2 -> $candidate_version; Gateway served while migration was pending, then Doctor imported both retained bindings."
}
