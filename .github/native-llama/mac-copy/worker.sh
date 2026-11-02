#!/bin/bash
# Parent-reviewed manual-only native proof; no process-substitution logger.
set -euo pipefail
packet="$(cd "$(dirname "$0")" && pwd -P)"
[[ "$#" == 3 ]] || { echo 'worker.sh BEFORE AFTER OUTPUT' >&2; exit 2; }
before="$(cd "$1" && pwd -P)"; after="$(cd "$2" && pwd -P)"; output="$(cd "$3" && pwd -P)"
fail() { printf '::error::%s\n' "$*" >&2; exit 1; }
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]]
[[ "${LLAMA_GITHUB_HOSTED_ACK:-}" == task-owned-secretless-github-hosted ]]
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 && -d "${RUNNER_TEMP:?}" ]]
cd "$packet"
/usr/bin/shasum -a 256 -c INPUT-SHA256SUMS
cp INPUT-SHA256SUMS SOURCE-PINS.json copy-detect.json "$output/"
sw_vers > "$output/os-version.txt"
sysctl -n hw.logicalcpu hw.memsize > "$output/resources.txt"
df -Pk "$output" > "$output/disk-start.txt"
[[ "$(sysctl -n hw.logicalcpu)" -ge 3 && "$(sysctl -n hw.memsize)" -ge 7000000000 ]]
[[ "$(df -Pk "$output" | awk 'NR==2 {print $4}')" -ge 8388608 ]] || fail 'Need >=8 GiB free disk'
os="$(sw_vers -productVersion)"
awk -v v="$os" 'BEGIN {split(v,a,"."); exit !(a[1]>26 || (a[1]==26 && a[2]>=2))}'
[[ -d "${DEVELOPER_DIR:?}/Platforms/MacOSX.platform" && -x /usr/bin/sandbox-exec ]]
xcodebuild -version > "$output/xcode-version.txt"
grep -q '^Xcode 26.4.1$' "$output/xcode-version.txt"
swift --version > "$output/swift-version.txt"
grep -Eq 'Swift version 6\.3\.1([. ]|$)' "$output/swift-version.txt"
xcrun --sdk macosx --show-sdk-version > "$output/sdk-version.txt"
awk -v v="$(cat "$output/sdk-version.txt")" 'BEGIN {split(v,a,"."); exit !(a[1]>26 || (a[1]==26 && a[2]>=2))}'
[[ "$(node --version)" == v24.22.1 && "$(pnpm --version)" == 12.15.0 ]]
node --version > "$output/node-version.txt"; pnpm --version > "$output/pnpm-version.txt"
original_home="$(cd "$HOME" && pwd -P)"
for stage in before after; do
  checkout="$before"; [[ "$stage" == before ]] || checkout="$after"
  python3 -I -S "$packet/source.py" verify "$checkout" "$checkout" "$stage" "$output/source-$stage.jsonl" > "$output/source-$stage-receipt.json"
  cmp "$checkout/scripts/macos-health-render.sb" "$packet/macos-health-render.sb"
done
# Fail the named exact-tool prerequisite before dependency/build work.
tools="$(mktemp -d "$RUNNER_TEMP/mac-copy-tools.XXXXXX")"
"$after/scripts/install-swift-tools.sh" "$tools" > "$output/swift-tools-install.log" 2>&1
export PATH="$tools:$PATH"
"$after/scripts/check-swift-tools.sh" > "$output/swift-tools.log" 2>&1
# All executing source admitted before its dependency/install/build execution.
# shellcheck source=scripts/lib/swift-toolchain.sh
source "$before/scripts/lib/swift-toolchain.sh"
require_swift_toolchain
work="$(mktemp -d "$RUNNER_TEMP/mac-copy-build.XXXXXX")"
printf '%s\n' "$work" > "$output/build-root.txt"
git -C "$before" archive HEAD | tar -xf - -C "$work"
cd "$work"
node --input-type=module -e 'const m=await import("./node-version.mjs");if(!m.isSupportedOpenClawNodeVersion(process.version))throw Error(m.SUPPORTED_NODE_VERSIONS)'
node -e 'if(!require("./package.json").packageManager.startsWith("pnpm@12.15.0+"))throw Error("pnpm source pin")'
CI=true pnpm install --frozen-lockfile --prefer-offline --optional \
  --filter '@openclaw/mermaid-renderer...' --filter '@openclaw/gateway-protocol...' \
  --config.ignore-scripts=false --config.engine-strict=false \
  --config.enable-pre-post-scripts=true --config.side-effects-cache=true > "$output/dependencies.log" 2>&1
node "$packet/validate-fixture.mjs" "$work" > "$output/fixture-validation.json"
node scripts/prepare-apple-mermaid.mjs > "$output/mermaid-assets.log" 2>&1
node scripts/prepare-native-protocol.mjs --language swift > "$output/protocol-assets.log" 2>&1
test_file=apps/macos/Tests/OpenClawIPCTests/OnboardingAISetupTests.swift
cp "$after/$test_file" "$output/after-tests.swift"
cp "$packet/overlay/LlamaNativeCapture.swift.append" "$output/qualified-helper.swift.append"
cp "$packet/CopyPageCapture.swift.append" "$output/copy-helper.swift.append"
for stage in before after; do
  checkout="$before"
  if [[ "$stage" == after ]]; then
    checkout="$after"
    cp "$before/$test_file" "$test_file"
    python3 -I -S "$packet/source.py" advance "$before" "$after" "$work" > "$output/reviewed-delta.json"
    # Named prerequisite: exact pinned tools. Never install a different version or autoformat sealed source.
    (cd "$after" && scripts/lint-swift.sh macos) > "$output/swift-lint.log" 2>&1
    (cd "$after" && scripts/format-swift.sh macos) > "$output/swift-format.log" 2>&1
  fi
  python3 -I -S "$packet/source.py" verify "$checkout" "$work" "$stage" "$output/build-source-$stage.jsonl" > "$output/build-source-$stage-receipt.json"
  # Both stages use the SAME explicit test-only overlay AFTER canonical freeze.
  cat "$after/$test_file" "$packet/overlay/LlamaNativeCapture.swift.append" "$packet/CopyPageCapture.swift.append" > "$test_file"
  /usr/bin/shasum -a 256 "$test_file" > "$output/overlaid-$stage.sha256"
  [[ "$(/usr/bin/shasum -a 256 "$test_file" | cut -d' ' -f1)" == 46c2850464d659f8ae97abeb8a40832e62bf92d0c7454c36239858b3841a573c ]]
  /usr/bin/time -lp swift build --package-path apps/macos --build-system native --force-resolved-versions \
    --disable-index-store -Xswiftc -gline-tables-only --build-tests -j 2 > "$output/build-$stage.log" 2>&1
  /usr/bin/shasum -a 256 -c "$packet/LOCK-SHA256SUMS" > "$output/locks-$stage.txt"
  build="$(cd apps/macos/.build/debug && pwd -P)"
  swift_exe="$(xcrun --find swift)"
  platform="$(xcrun --sdk macosx --show-sdk-platform-path)/Developer"
  helper="$(dirname "$swift_exe")/../libexec/swift/pm/swiftpm-testing-helper"
  bundle="$build/OpenClawPackageTests.xctest/Contents/MacOS/OpenClawPackageTests"
  [[ -x "$helper" && -f "$bundle" && -f "$platform/Library/Frameworks/Testing.framework/Testing" ]]
  isolation="$(mktemp -d "$RUNNER_TEMP/mac-copy-render-$stage.XXXXXX")"
  mkdir -p "$isolation/home/state" "$isolation/home/Library/Preferences" "$isolation/tmp" "$isolation/pngs"
  cp "$packet/copy-detect.json" "$isolation/copy-detect.json"
  source_tree=12fe3ed2d4c8dfd6757dd54fd6220ba9b74162a3
  [[ "$stage" == before ]] || source_tree=4cafea0569bd7b0e77a939387a1b4713be805445
  run_native_test() {
    local filter="$1" events="$2" log="$3"
    env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      HOME="$isolation/home" CFFIXED_USER_HOME="$isolation/home" TMPDIR="$isolation/tmp/" \
      LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LLVM_PROFILE_FILE="$isolation/render-%p.profraw" \
      SWIFT_BACKTRACE=enable=yes,interactive=no,color=no,sanitize=yes,threads=crashed,registers=none,images=mentioned \
      NSUnbufferedIO=YES OPENCLAW_PROFILE=mac-copy OPENCLAW_STATE_DIR="$isolation/home/state" \
      OPENCLAW_CONFIG_PATH="$isolation/home/state/openclaw.json" \
      OPENCLAW_MAC_COPY_ROOT="$isolation" OPENCLAW_MAC_COPY_STAGE="$stage" \
      OPENCLAW_MAC_COPY_SOURCE_TREE="$source_tree" \
      OPENCLAW_MAC_COPY_FIXTURE_SHA256=d86cbbc380342d1c5804a67e3b2bbd1bc94131431376138d7188fe43fd546c4a \
      /usr/bin/sandbox-exec -D "ORIGINAL_HOME=$original_home" -D "REPO=$work" \
      -D "ISOLATED_ROOT=$isolation" -f "$packet/macos-health-render.sb" \
      /usr/bin/env DYLD_FRAMEWORK_PATH="$platform/Library/Frameworks:$platform/Library/PrivateFrameworks" \
      DYLD_LIBRARY_PATH="$build:$platform/usr/lib" \
      "$helper" --test-bundle-path "$bundle" --testing-library swift-testing \
      --filter "$filter" --event-stream-output-path "$events" --event-stream-version 6.3 > "$log" 2>&1
  }
  mounted_exit=0
  run_native_test 'OnboardingAISetupTests/prepare rows use plain copy and preserve wire actions' \
    "$isolation/mounted-events.jsonl" "$output/mounted-$stage.log" || mounted_exit=$?
  printf '%s\n' "$mounted_exit" > "$output/mounted-$stage-exit.txt"
  cp "$isolation/mounted-events.jsonl" "$output/mounted-events-$stage.jsonl"
  python3 -I -S "$packet/verify-results.py" events "$output" "$stage" mounted > "$output/mounted-verdict-$stage.json"
  capture_exit=0
  run_native_test 'LlamaNativeCaptureTests/nativePlainCopyPageCapture' \
    "$isolation/capture-events.jsonl" "$output/capture-$stage.log" || capture_exit=$?
  printf '%s\n' "$capture_exit" > "$output/capture-$stage-exit.txt"
  [[ ! -f "$isolation/capture-events.jsonl" ]] || cp "$isolation/capture-events.jsonl" "$output/capture-events-$stage.jsonl"
  mkdir "$output/$stage"
  for name in onboarding.png onboarding.accessibility.json receipt.json; do
    [[ ! -f "$isolation/pngs/$stage/$name" ]] || cp "$isolation/pngs/$stage/$name" "$output/$stage/$name"
  done
  [[ "$capture_exit" == 0 ]] || fail 'Native capture failed; partial evidence is not proof'
  python3 -I -S "$packet/verify-results.py" events "$output" "$stage" capture > "$output/capture-verdict-$stage.json"
done
cp "$after/$test_file" "$test_file"
python3 -I -S "$packet/source.py" verify "$after" "$work" after "$output/final-source-after.jsonl" > "$output/final-source-after-receipt.json"
df -Pk "$output" > "$output/disk-end.txt"
# Outer wrapper owns validation/status/sealing AFTER foreground pipeline joins.
