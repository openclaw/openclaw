#!/bin/bash

# Temporary diagnostic branch only; sourced by the existing macOS CI jobs.

run_l72_mac_node_diagnostics() {
  [[ "$TASK" == "test-2" && "$(git rev-parse HEAD)" == "$OPENCLAW_MACOS_NODE_EXPECTED_SHA" ]]
  source .ci-harness/scripts/lib/swift-toolchain.sh
  node_diagnostic_logs="$RUNNER_TEMP/openclaw-macos-node2-diagnostic-logs"
  mkdir -p "$node_diagnostic_logs"
  node_receipts="$node_diagnostic_logs/receipts.log"
  printf 'diagnostic_only=true\nhead=%s\nexpected_full_runs=1\nexpected_focused_runs=20\n' "$OPENCLAW_MACOS_NODE_EXPECTED_SHA" > "$node_receipts"
  uname -r >> "$node_receipts"
  sw_vers >> "$node_receipts"
  node --version >> "$node_receipts"
  pnpm --version >> "$node_receipts"
  printf 'phase\texit\tstartedUTC\tendedUTC\tlog\n' >> "$node_receipts"
  node_diagnostic_failed=0
  node_diagnostic_completed=0
  run_mac_node_diagnostic_phase() {
    local label="$1" log_path started code=0
    shift
    log_path="$node_diagnostic_logs/$label.log"
    started="$(date -u +%FT%TZ)"
    printf 'phase=%s command=' "$label" >> "$node_diagnostic_logs/commands.log"
    printf '%q ' "$@" >> "$node_diagnostic_logs/commands.log"
    printf '\n' >> "$node_diagnostic_logs/commands.log"
    run_apple_command_logged "$log_path" "$@" || code=$?
    printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$code" "$started" "$(date -u +%FT%TZ)" "$log_path" >> "$node_receipts"
    node_diagnostic_completed=$((node_diagnostic_completed + 1))
    if [[ "$code" == 0 ]]; then return; fi
    node_diagnostic_failed=1
    if [[ "$code" -ge 128 ]]; then
      echo "Mac Node command interrupted; remaining diagnostic phases are unexecuted." >&2
      exit 1
    fi
    # Inspect only a nonzero invocation; passing negative controls may log errors.
    node scripts/l72-native-diagnostic-log.mjs "$log_path"
  }
  run_mac_node_diagnostic_phase original-macos-node-2 pnpm test:macos:ci:2
  for ((node_iteration=1; node_iteration<=20; node_iteration++)); do
    printf -v node_label 'focused-elevation-%02d' "$node_iteration"
    run_mac_node_diagnostic_phase "$node_label" node scripts/run-vitest.mjs test/scripts/mac-elevation-artifact.test.ts -t 'rejects mismatched worker commit' --maxWorkers=2 --reporter=verbose
  done
  printf 'completed_phases=%s\nany_failure=%s\n' "$node_diagnostic_completed" "$node_diagnostic_failed" >> "$node_receipts"
  cat "$node_receipts"
  [[ "$node_diagnostic_completed" == 21 ]]
  exit "$node_diagnostic_failed"
}

run_l72_presence_diagnostics() {
  [[ "$(git rev-parse HEAD)" == "$OPENCLAW_PRESENCE_EXPECTED_SHA" ]]
  presence_receipts="$native_test_log_dir/presence-diagnostic-$native_test_log_id.log"
  printf 'diagnostic_only=true\nhead=%s\nexpected_runs=5\n' "$OPENCLAW_PRESENCE_EXPECTED_SHA" > "$presence_receipts"
  printf 'iteration\texit\tstartedUTC\tendedUTC\tlog\n' >> "$presence_receipts"
  presence_failed=0
  presence_completed=0
  for ((presence_iteration=1; presence_iteration<=5; presence_iteration++)); do
    presence_log="$native_test_log_dir/default-presence-$presence_iteration-$native_test_log_id.log"
    presence_started="$(date -u +%FT%TZ)"
    presence_code=0
    run_apple_command_logged "$presence_log" node scripts/test-macos-native.mts default "${swift_test_args[@]}" --skip "AppStateIsolationTests|ProfileChatPreferencesTests|QuickChatCatalogPresentationTests" || presence_code=$?
    presence_completed=$((presence_completed + 1))
    printf '%s\t%s\t%s\t%s\t%s\n' "$presence_iteration" "$presence_code" "$presence_started" "$(date -u +%FT%TZ)" "$presence_log" >> "$presence_receipts"
    if [[ "$presence_code" != 0 ]]; then presence_failed=1; fi
    if [[ "$presence_code" -ge 128 ]] || {
      [[ "$presence_code" != 0 ]] && grep -Eq '\[macos-native\] retained resources after incomplete launch/cleanup:|Managed command cleanup could not verify child, process group, and output closure' "$presence_log"
    }; then
      echo "Native lifetime is interrupted or uncertain; remaining diagnostic runs are unexecuted." >&2
      exit 1
    fi
  done
  printf 'completed_runs=%s\nany_failure=%s\n' "$presence_completed" "$presence_failed" >> "$presence_receipts"
  cat "$presence_receipts"
  [[ "$presence_completed" == 5 ]]
}
