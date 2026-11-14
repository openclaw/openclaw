#!/usr/bin/env bash
# HOSTED PLAN ONLY. Runs at candidate checkout root; proof and harness are separate nested checkouts.
set -euo pipefail
umask 077
proof="$GITHUB_WORKSPACE/proof/scripts/swift-causal-proof"
mkdir -p "$PRIVATE_PROOF" "$SAFE_PROOF"
python3 "$proof/verify.py" bind "$PWD" "$GITHUB_WORKSPACE/harness"
source "$GITHUB_WORKSPACE/harness/scripts/lib/swift-toolchain.sh"
# Raw output, including the normal owner tail, never reaches the Actions log.
phase() {
  local name="$1"; shift
  local code=0
  "$@" >"$PRIVATE_PROOF/$name.log" 2>&1 || code=$?
  printf "%s\n" "$code" >"$PRIVATE_PROOF/$name.exit"
  return "$code"
}
phase select select_xcode_toolchain
phase xcode xcodebuild -version
phase swift swift --version
phase os sw_vers -productVersion
phase developer xcode-select -p
phase node node --version
phase pnpm pnpm --version
phase dependencies pnpm install --frozen-lockfile --prefer-offline --optional \
  --filter "@openclaw/mermaid-renderer..." --filter "@openclaw/gateway-protocol..." \
  --config.ignore-scripts=false --config.engine-strict=false \
  --config.enable-pre-post-scripts=true --config.side-effects-cache=true
phase assets node scripts/prepare-apple-mermaid.mjs
# Fail rather than build a mutated tracked source or a borrowed build tree.
python3 "$proof/verify.py" source "$PWD" "$GITHUB_WORKSPACE/harness"
[[ ! -e apps/macos/.build ]]
swift_test_args=(--package-path apps/macos --build-system native --enable-code-coverage --disable-index-store -Xswiftc -gline-tables-only)
phase build swift build "${swift_test_args[@]}" --build-tests
echo "debug-tests-built=true" >> "$GITHUB_OUTPUT"
swift_test_args+=(--skip-build)
logical_cpu="$(sysctl -n hw.logicalcpu)"
[[ "$logical_cpu" =~ ^[1-9][0-9]*$ ]]
swift_test_width=$(( logical_cpu < 12 ? logical_cpu : 12 ))
printf "%s\n" "$swift_test_width" >"$PRIVATE_PROOF/width"
swift_test_args+=(--experimental-maximum-parallelization-width "$swift_test_width")
source "$GITHUB_WORKSPACE/harness/scripts/ci-collect-checks.sh"
# Keep original run_check/finish_checks semantics; phase records the exact launcher exit.
run_check "selected native failure suite" phase native run_apple_command_logged \
  "$PRIVATE_PROOF/native-raw.log" node scripts/test-macos-native.mts default \
  "${swift_test_args[@]}" --filter DashboardNativeBrowserFailureTests
finish_checks
