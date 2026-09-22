#!/usr/bin/env bash

capture_missing_load_path_lint() {
  local lint_exit=0
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" \
    openclaw doctor --lint --json --severity-min warning \
    --only core/doctor/final-config-validation \
    >"$ARTIFACT_ROOT/missing-load-path/doctor-lint.json" \
    2>"$ARTIFACT_ROOT/missing-load-path/doctor-lint.err" || lint_exit=$?
  [ "$lint_exit" -eq 1 ]
}

run_missing_load_path_fixture() {
  if [ "$SCENARIO" = "missing-load-path" ] && [ "$UPDATE_RESTART_MODE" != "manual" ]; then
    echo "missing-load-path requires manual restart" >&2
    return 2
  fi
  { [ "$SCENARIO" = "base" ] || [ "$SCENARIO" = "missing-load-path" ]; } &&
    [ "$UPDATE_RESTART_MODE" = "manual" ] || return 0
  local stage="$1"
  local helper="scripts/e2e/lib/upgrade-survivor/assertions.mjs"
  case "$stage" in
    seed)
      phase missing-load-path-seed node "$helper" missing-load-path "$stage" || return "$?"
      export OPENCLAW_UPGRADE_SURVIVOR_MISSING_LOAD_PATH_SEEDED=1
      ;;
    baseline)
      local GATEWAY_LOG="$ARTIFACT_ROOT/missing-load-path/baseline-gateway.log"
      local HEALTHZ_JSON="$ARTIFACT_ROOT/missing-load-path/baseline-healthz.json"
      local READYZ_JSON="$ARTIFACT_ROOT/missing-load-path/baseline-readyz.json"
      phase missing-load-path-baseline-start openclaw_prepublish_plugin_registry_run_published start_gateway
      phase missing-load-path-baseline-ready check_gateway_probes
      phase missing-load-path-baseline-stop stop_gateway
      ;;
    post-doctor)
      phase missing-load-path-doctor-lint capture_missing_load_path_lint
      phase missing-load-path-post-doctor node "$helper" missing-load-path "$stage"
      ;;
    *)
      phase "missing-load-path-$stage" node "$helper" missing-load-path "$stage"
      ;;
  esac
}
