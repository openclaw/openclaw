#!/bin/bash
set -euo pipefail
fail() { printf "::error::%s\n" "$*" >&2; exit 1; }
capture_error() { printf "Native Mac proof failed at line %s (exit %s); inspect retained evidence. No screenshot proof accepted.\n" "$2" "$1" >&2; }
trap 'capture_error "$?" "$LINENO"' ERR
# Manual presentation proof only. GitHub's disposable secretless native VM owns execution.
packet="$(cd "$(dirname "$0")" && pwd -P)"
[[ "$#" == 4 ]] || { echo "Usage: run-mac-ci.sh BEFORE_CHECKOUT AFTER_CHECKOUT CORE_CHECKOUT OUTPUT_DIR" >&2; exit 2; }
before="$(cd "$1" && pwd -P)"
after="$(cd "$2" && pwd -P)"
core="$(cd "$3" && pwd -P)"
[[ "$4" == /* && ! -e "$4" ]]
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]]
[[ "${LLAMA_GITHUB_HOSTED_ACK:-}" == task-owned-secretless-github-hosted ]]
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 && -d "${RUNNER_TEMP:?}" ]]
mkdir -p "$4"
output="$(cd "$4" && pwd -P)"
exec 3>&1 4>&2
exec > >(tee "$output/run.log") 2>&1
logger_pid=$!
capture_exit() {
  local code=$?
  if [[ "$code" != 0 ]]; then
    printf "FAILED exit=%s; inspect logs; never accept AX-only proof\n" "$code" > "$output/CAPTURE-STATUS.txt"
  fi
}
trap capture_exit EXIT
cd "$packet"
/usr/bin/shasum -a 256 -c INPUT-SHA256SUMS
cp INPUT-SHA256SUMS "$output/input-manifest.sha256"
sw_vers | tee "$output/os-version.txt"
uname -a
sysctl -n hw.logicalcpu hw.memsize | tee "$output/resources.txt"
df -Pk "$output" | tee "$output/disk-start.txt"
# macos-26 public standard runner contract: 3 M1 CPU / 7 GB RAM / 14 GB SSD.
# -j 2 and one incremental build tree avoid the prior arbitrary 8 CPU/16 GiB floor.
[[ "$(sysctl -n hw.logicalcpu)" -ge 3 && "$(sysctl -n hw.memsize)" -ge 7000000000 ]] || fail "Expected published standard runner resources: >=3 CPU and >=7 GB RAM"
[[ "$(df -Pk "$output" | awk 'NR==2 {print $4}')" -ge 8388608 ]] || fail "Need >=8 GiB currently-free disk for this qualified build candidate; retain resource evidence"
os="$(sw_vers -productVersion)"
awk -v v="$os" 'BEGIN {split(v,a,"."); exit !(a[1]>26 || (a[1]==26 && a[2]>=2))}' || fail "Requires macOS >=26.2; observed $os"
[[ -d "${DEVELOPER_DIR:?}/Platforms/MacOSX.platform" && -x /usr/bin/sandbox-exec ]]
xcodebuild -version | tee "$output/xcode-version.txt"
swift --version | tee "$output/swift-version.txt"
grep -Eq 'Swift version 6\.3([. ]|$)' "$output/swift-version.txt" || fail "Requires selected Swift 6.3.x; no toolchain fallback is allowed"
sdk="$(xcrun --sdk macosx --show-sdk-version)"
printf '%s\n' "$sdk" > "$output/sdk-version.txt"
awk -v v="$sdk" 'BEGIN {split(v,a,"."); exit !(a[1]>26 || (a[1]==26 && a[2]>=2))}' || fail "Requires macOS SDK >=26.2; observed $sdk"
swift build --help > "$output/swift-build-help.txt"
grep -q -- '--force-resolved-versions' "$output/swift-build-help.txt"
node --version
pnpm --version
[[ "$(node --version)" == v24.22.1 && "$(pnpm --version)" == 12.15.0 ]] || fail "Requires source-pinned Node 24.22.1 and pnpm 12.15.0"
original_home="$(cd "$HOME" && pwd -P)"
# Read every source blob, including symlink identity and executable mode; manifests are artifacts, not committed inputs.
for stage in before after core; do
  case "$stage" in before) checkout="$before";; after) checkout="$after";; core) checkout="$core";; esac
  python3 -I -S "$packet/source.py" verify "$checkout" "$checkout" "$stage" "$output/source-$stage.jsonl" > "$output/source-$stage-receipt.json"
done
cmp "$before/scripts/macos-health-render.sb" "$packet/macos-health-render.sb"
cmp "$after/scripts/macos-health-render.sb" "$packet/macos-health-render.sb"
# Source code is executed only after exact public checkout/blob admission.
# Static analysis follows the unchanged maintained helper copied into reference/.
# shellcheck source=reference/swift-toolchain.sh
source "$before/scripts/lib/swift-toolchain.sh"
require_swift_toolchain
work="$(mktemp -d "$RUNNER_TEMP/llama-mac-build.XXXXXX")"
printf '%s\n' "$work" > "$output/build-root.txt"
git -C "$before" archive HEAD | tar -xf - -C "$work"
cd "$work"
node --input-type=module -e 'const m=await import("./node-version.mjs");if(!m.isSupportedOpenClawNodeVersion(process.version))throw Error(m.SUPPORTED_NODE_VERSIONS)'
node -e 'const p=require("./package.json");if(!p.packageManager.startsWith("pnpm@12.15.0+"))throw Error("Unexpected pnpm contract")'
CI=true pnpm install --frozen-lockfile --prefer-offline --optional \
  --filter '@openclaw/mermaid-renderer...' --filter '@openclaw/gateway-protocol...' \
  --config.ignore-scripts=false --config.engine-strict=false \
  --config.enable-pre-post-scripts=true --config.side-effects-cache=true \
  > "$output/dependencies.log" 2>&1
# These three exact provider/Gateway source files and real wire schemas own fixture qualification.
# Core checkout shares the admitted immutable asset dependency closure; no core install or config writes.
node "$packet/validate-fixtures.mjs" "$work" "$work" "$core" > "$output/fixture-validation.json"
# Validate the admitted producer TS source, using the same source-pinned TypeBox/esbuild dependency closure.
node "$packet/validate-fixtures.mjs" "$core" "$work" "$core" > "$output/core-fixture-validation.json"
# Independently admit the After wire consumer against the same pinned producer.
node "$packet/validate-fixtures.mjs" "$after" "$work" "$core" > "$output/after-fixture-validation.json"
node scripts/prepare-apple-mermaid.mjs > "$output/mermaid-assets.log" 2>&1
node scripts/prepare-native-protocol.mjs --language swift > "$output/protocol-assets.log" 2>&1
test_file=apps/macos/Tests/OpenClawIPCTests/OnboardingAISetupTests.swift
cp "$test_file" "$output/original-onboarding-tests.swift"
for stage in before after; do
  cp "$output/original-onboarding-tests.swift" "$test_file"
  checkout="$before"
  if [[ "$stage" == after ]]; then
    checkout="$after"
    python3 -I -S "$packet/source.py" advance "$before" "$after" "$work" > "$output/reviewed-delta.json"
  fi
  python3 -I -S "$packet/source.py" verify "$checkout" "$work" "$stage" "$output/build-source-$stage.jsonl" > "$output/build-source-$stage-receipt.json"
  cat "$packet/overlay/LlamaNativeCapture.swift.append" >> "$test_file"
  /usr/bin/shasum -a 256 "$test_file" > "$output/overlaid-$stage.sha256"
  # Same native backend and reduced debug metadata as maintained macos-swift, locked dependencies.
  start=$SECONDS
  if ! /usr/bin/time -lp swift build --package-path apps/macos --build-system native --force-resolved-versions \
    --disable-index-store -Xswiftc -gline-tables-only --build-tests -j 2 > "$output/build-$stage.log" 2>&1; then
    df -Pk "$output" > "$output/disk-build-failure.txt"
    tail -c 16000 "$output/build-$stage.log"
    exit 1
  fi
  printf 'stage=%s buildWallSeconds=%s\n' "$stage" "$((SECONDS-start))" >> "$output/timing.txt"
  /usr/bin/shasum -a 256 -c "$packet/LOCK-SHA256SUMS" > "$output/locks-$stage.txt"
  build="$(cd apps/macos/.build/debug && pwd -P)"
  swift_exe="$(xcrun --find swift)"
  platform="$(xcrun --sdk macosx --show-sdk-platform-path)/Developer"
  helper="$(dirname "$swift_exe")/../libexec/swift/pm/swiftpm-testing-helper"
  bundle="$build/OpenClawPackageTests.xctest/Contents/MacOS/OpenClawPackageTests"
  [[ -x "$helper" && -f "$bundle" && -f "$platform/Library/Frameworks/Testing.framework/Testing" ]]
  isolation="$(mktemp -d "$RUNNER_TEMP/llama-mac-render-$stage.XXXXXX")"
  mkdir -p "$isolation/home/state" "$isolation/home/Library/Preferences" "$isolation/tmp" "$isolation/pngs" "$isolation/fixtures"
  cp "$packet/fixtures/"*.json "$isolation/fixtures/"
  # Do not relax this maintained sandbox to work around a capture failure.
  test_exit=0
  env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    HOME="$isolation/home" CFFIXED_USER_HOME="$isolation/home" TMPDIR="$isolation/tmp/" \
    LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
    LLVM_PROFILE_FILE="$isolation/render-%p.profraw" \
    SWIFT_BACKTRACE=enable=yes,interactive=no,color=no,sanitize=yes,threads=crashed,registers=none,images=mentioned \
    NSUnbufferedIO=YES OPENCLAW_PROFILE=llama-render OPENCLAW_STATE_DIR="$isolation/home/state" \
    OPENCLAW_CONFIG_PATH="$isolation/home/state/openclaw.json" \
    OPENCLAW_LLAMA_CAPTURE_ROOT="$isolation" OPENCLAW_LLAMA_CAPTURE_STAGE="$stage" \
    /usr/bin/sandbox-exec -D "ORIGINAL_HOME=$original_home" -D "REPO=$work" \
    -D "ISOLATED_ROOT=$isolation" -f "$packet/macos-health-render.sb" \
    /usr/bin/env DYLD_FRAMEWORK_PATH="$platform/Library/Frameworks:$platform/Library/PrivateFrameworks" \
    DYLD_LIBRARY_PATH="$build:$platform/usr/lib" \
    "$helper" --test-bundle-path "$bundle" --testing-library swift-testing \
    --filter 'LlamaNativeCaptureTests/nativeOnboardingCapture' \
    --event-stream-output-path "$isolation/events.jsonl" --event-stream-version 6.3 \
    > "$output/test-$stage.log" 2>&1 || test_exit=$?
  # Preserve completed failure evidence too; partial frames never count as success.
  if [[ -f "$isolation/events.jsonl" ]]; then
    cp "$isolation/events.jsonl" "$output/events-$stage.jsonl"
  fi
  mkdir "$output/$stage"
  for name in onboarding.png onboarding.accessibility.json install-note.png install-note.accessibility.json endpoint.png endpoint.accessibility.json receipt.json; do
    if [[ -f "$isolation/pngs/$stage/$name" ]]; then
      cp "$isolation/pngs/$stage/$name" "$output/$stage/$name"
    fi
  done
  if [[ "$test_exit" != 0 ]]; then
    tail -c 16000 "$output/test-$stage.log"
    fail "Native capture failed (exit $test_exit); partial evidence is not screenshot proof"
  fi
  for name in onboarding install-note endpoint; do
    [[ -s "$output/$stage/$name.png" && -s "$output/$stage/$name.accessibility.json" ]]
    /usr/bin/sips -g pixelWidth -g pixelHeight "$output/$stage/$name.png"
  done
  [[ -s "$output/$stage/receipt.json" ]]
done
cp "$output/original-onboarding-tests.swift" "$test_file"
df -Pk "$output" > "$output/disk-end.txt"
python3 -I -S "$packet/verify-results.py" "$output"
printf '%s\n' 'NATIVE_PRESENTATION_CAPTURE_COMPLETED_REQUIRES_PARENT_PIXEL_INSPECTION_AND_DELIVERY' > "$output/CAPTURE-STATUS.txt"
# Seal complete logs only after their writer exits, so hashes survive artifact download.
exec 1>&3 2>&4
wait "$logger_pid"
python3 -I -S "$packet/verify-results.py" --seal "$output"
# No upload, publication, cloud allocation, production services, or app/inference activation.
