#!/usr/bin/env bash

start_missing_load_path_baseline() {
  local start_status=0 exit_status=0
  start_gateway || start_status=$?
  [ "$start_status" -eq 0 ] && return 0
  [ "$start_status" -eq 1 ] && [ -n "${gateway_pid:-}" ] || return "$start_status"
  # Published startup may install migration plugins, then require one fresh process.
  # Never restart a live/timed-out child or reinterpret an unrelated startup failure.
  if kill -0 "$gateway_pid" >/dev/null 2>&1; then
    return "$start_status"
  fi
  wait "$gateway_pid" || exit_status=$?
  [ "$exit_status" -eq 1 ] || return "$start_status"
  grep -Fxq 'OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.' \
    "$GATEWAY_LOG" || return "$start_status"
  local refused_log="$ARTIFACT_ROOT/missing-load-path/baseline-gateway-convergence-refusal.log"
  cp "$GATEWAY_LOG" "$refused_log" || return "$?"
  printf 'Published baseline %s completed plugin convergence (pid %s, exit %s); restarting once with the same config, state, and port. First attempt: %s\n' \
    "$baseline_version" "$gateway_pid" "$exit_status" "$refused_log"
  gateway_pid=""
  start_gateway
}

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
      local companion_version plugin
      companion_version="$(node --input-type=module -e '
        import { compareReleaseVersions, parseReleaseVersion } from "./scripts/lib/release-version.mjs";
        const release = parseReleaseVersion(process.argv[1]);
        if (!release) throw new Error("Invalid baseline release version");
        if (compareReleaseVersions(release.version, "2026.5.2-beta.1") !== -1 &&
            compareReleaseVersions(release.version, "2026.9.1") === -1) {
          process.stdout.write(release.correctionNumber === undefined ? release.version : release.baseVersion);
        }
      ' "$baseline_version")" || return "$?"
      if [ -n "$companion_version" ]; then
        # Before May these plugins were bundled; 2026.9.1 exempts official plugin consent.
        # Intervening startup repairs need their published cohort; core corrections share it.
        for plugin in codex discord whatsapp; do
          phase "missing-load-path-baseline-$plugin" openclaw_prepublish_plugin_registry_run_published \
            openclaw_e2e_fixture_plugin_command openclaw -- \
            plugins install "@openclaw/$plugin@$companion_version" --force || return "$?"
        done
      fi
      phase missing-load-path-baseline-start openclaw_prepublish_plugin_registry_run_published start_missing_load_path_baseline
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
