#!/usr/bin/env bash
set -euo pipefail
source scripts/ci-collect-checks.sh

case "$1" in
  ratchets)
    prepare_ratchet_base_args "$BASE_SHA"
    run_check max-lines pnpm check:max-lines-ratchet "${ratchet_base_args[@]}"
    run_check assertion-safety pnpm check:assertion-safety "${ratchet_base_args[@]}"
    run_check database-worker pnpm check:database-worker-ratchet "${ratchet_base_args[@]}"
    run_check database-dialect pnpm check:database-dialect-ratchet "${ratchet_base_args[@]}"
    run_check timeout-race pnpm check:test-timeout-race-ratchet "${ratchet_base_args[@]}"
    run_check mock-exports pnpm check:test-mock-exports "${ratchet_base_args[@]}"
    run_check test-lines pnpm check:test-lines-ratchet "${ratchet_base_args[@]}"
    run_check protocol-additions node --import ./scripts/tsx.mjs scripts/check-protocol-since.mts
    ;;
  regressions)
    for runtime in node bun; do
      run_check "$runtime-shutdown" env OPENCLAW_VITEST_RUNTIME="$runtime" \
        node scripts/run-vitest.mjs src/cli/gateway-cli/run-loop.direct-stop-active-work.process.test.ts --maxWorkers=1
      run_check "$runtime-lint-suppressions" env OPENCLAW_VITEST_RUNTIME="$runtime" \
        node scripts/run-vitest.mjs test/scripts/lint-suppressions.test.ts --maxWorkers=1
    done
    ;;
  *) echo "Unknown main-push check group: $1" >&2; exit 2 ;;
esac
finish_checks
