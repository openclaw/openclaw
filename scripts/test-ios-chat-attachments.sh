#!/bin/bash
# Real native app proof against the existing loopback Gateway; no live credentials or providers.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
baseline="${1:-}"
output="$root/apps/ios/build/LifecycleTestResults"
mkdir -p "$output"
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/openclaw-attachments.XXXXXX")"
fixture_pid=""
simulator=""
before_checkout=""
cleanup() {
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" || true; fi
  if [[ -n "$simulator" ]]; then
    xcrun simctl shutdown "$simulator" 2>/dev/null || true
    xcrun simctl delete "$simulator"
  fi
  if [[ -n "$before_checkout" ]]; then git worktree remove --force "$before_checkout"; fi
  rm -rf "$scratch"
}
trap cleanup EXIT

# Choose one installed phone/runtime for both revisions, but create only task-owned devices.
xcrun simctl list devices available --json > "$scratch/devices.json"
node -e '
const f=require("node:fs");
const entries=Object.entries(JSON.parse(f.readFileSync(process.argv[1],"utf8")).devices);
for(const [runtime,devices] of entries){
  const phone=devices.find(d=>d.isAvailable&&d.name.startsWith("iPhone"));
  if(phone){console.log(phone.name);console.log(runtime);process.exit(0);}
}
throw new Error("No available iPhone simulator");
' "$scratch/devices.json" > "$scratch/device.txt"
device="$(sed -n '1p' "$scratch/device.txt")"
runtime="$(sed -n '2p' "$scratch/device.txt")"
printf 'Candidate: %s\nBaseline: %s\nDevice: %s\nRuntime: %s\n' \
  "$(git rev-parse HEAD)" "$baseline" "$device" "$runtime" > "$output/Attachment-provenance.txt"
shasum -a 256 apps/ios/Tests/Fixtures/managed-document-message.json >> "$output/Attachment-provenance.txt"

export TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY=1
export TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE='{"url":"ws://127.0.0.1:19876","token":"synthetic-navigation-token"}'
export TEST_RUNNER_OPENCLAW_IOS_ATTACHMENT_FIXTURE_URL=http://127.0.0.1:19876

run_test() {
  local tree="$1" stage="$2" suite="$3" expected_marker="$4"
  local scheme=OpenClaw result="$output/Attachment-${stage}-${suite}.xcresult"
  local log="$output/Attachment-${stage}-${suite}.log" status=0
  local tests=(-only-testing:OpenClawTests/ManagedDocumentEnvelopeTests)
  if [[ "$suite" == ui ]]; then
    scheme=OpenClawUITests
    tests=(-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testManagedDocumentDownloadAndSystemShare)
  elif [[ "$stage" == after ]]; then
    tests+=(-only-testing:OpenClawTests/IOSMediaArtifactLoaderTests -only-testing:OpenClawTests/OpenClawTypographyTests)
  fi
  # Keep Actions log backpressure outside the simulator, retaining complete logs and xcresults.
  xcodebuild -project "$tree/apps/ios/OpenClaw.xcodeproj" -scheme "$scheme" \
    -configuration Debug -destination "platform=iOS Simulator,id=$simulator" \
    -testLanguage en -testRegion US -parallel-testing-enabled NO \
    -resultBundlePath "$result" "${tests[@]}" test > "$log" 2>&1 || status=$?
  tail -c 8192 "$log"
  [[ -d "$result" ]] || return 1
  xcrun xcresulttool get test-results summary --path "$result" --compact > "$result.summary.json"
  if [[ "$suite" == ui ]]; then
    xcrun xcresulttool export attachments --path "$result" --output-path "$output/attachments-$stage"
  fi
  if [[ -n "$expected_marker" ]]; then
    # A compile/setup/crash failure is never behavioral red.
    [[ "$status" -ne 0 ]] || return 1
    grep -q "$expected_marker" "$log" || return 1
    node -e 'const r=require(process.argv[1]);if(r.result!=="Failed"||r.failedTests!==1||r.passedTests!==0)process.exit(1)' "$result.summary.json"
    printf 'Verified baseline behavioral red: %s\n' "$expected_marker"
  else
    [[ "$status" -eq 0 ]]
    node -e 'const r=require(process.argv[1]);if(r.result!=="Passed"||r.failedTests!==0||r.passedTests<1)process.exit(1)' "$result.summary.json"
  fi
}

run_revision() {
  local tree="$1" stage="$2"
  simulator="$(xcrun simctl create "OpenClaw attachments $stage $$" "$device" "$runtime")"
  xcrun simctl boot "$simulator"
  xcrun simctl bootstatus "$simulator" -b
  xcrun simctl status_bar "$simulator" override --time 09:41 --batteryState charged --batteryLevel 100
  (
    cd "$tree"
    ./scripts/ios-configure-signing.sh
    ./scripts/ios-write-version-xcconfig.sh
    node scripts/ios-write-swift-filelist.mjs
    xcodegen generate --spec apps/ios/project.yml --project apps/ios
  )
  node "$root/scripts/test-ios-shell-gateway.mjs" --attachments > "$output/Attachment-$stage-gateway.log" 2>&1 &
  fixture_pid=$!
  if [[ "$stage" == before ]]; then
    export TEST_RUNNER_OPENCLAW_IOS_ATTACHMENT_BASELINE=1
    run_test "$tree" "$stage" envelope MANAGED_DOCUMENT_METADATA_LOST
    run_test "$tree" "$stage" ui MANAGED_DOCUMENT_DOWNLOAD_MISSING
  else
    unset TEST_RUNNER_OPENCLAW_IOS_ATTACHMENT_BASELINE
    run_test "$tree" "$stage" envelope ""
    run_test "$tree" "$stage" ui ""
  fi
  kill "$fixture_pid"
  wait "$fixture_pid"
  fixture_pid=""
  xcrun simctl shutdown "$simulator"
  xcrun simctl delete "$simulator"
  simulator=""
}

if [[ -n "$baseline" ]]; then
  [[ "$baseline" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected an exact baseline SHA' >&2; exit 2; }
  git cat-file -e "$baseline^{commit}" || git -c gc.auto=0 fetch --no-tags --depth=1 origin "$baseline"
  # Initial introduction proves the pre-fix tree; later changes retain the candidate regression
  # without rebuilding an already-fixed baseline on every native PR.
  if ! git cat-file -e "$baseline:apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatFileAttachment.swift" 2>/dev/null; then
    before_checkout="$scratch/before"
    git worktree add --detach "$before_checkout" "$baseline"
    mkdir -p "$before_checkout/apps/ios/Tests/Fixtures"
    cp apps/ios/Tests/ManagedDocumentEnvelopeTests.swift "$before_checkout/apps/ios/Tests/"
    cp apps/ios/Tests/Fixtures/managed-document-message.json "$before_checkout/apps/ios/Tests/Fixtures/"
    cp apps/ios/UITests/OpenClawSnapshotUITests.swift "$before_checkout/apps/ios/UITests/"
    (cd "$before_checkout" && pnpm install --frozen-lockfile)
    git -C "$before_checkout" diff --exit-code -- apps/ios/Sources apps/shared/OpenClawKit/Sources
    run_revision "$before_checkout" before
    git -C "$before_checkout" diff --exit-code -- apps/ios/Sources apps/shared/OpenClawKit/Sources
  fi
fi
run_revision "$root" after
