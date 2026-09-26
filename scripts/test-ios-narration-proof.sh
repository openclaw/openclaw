#!/bin/bash
# Verification-branch driver: real iOS app, synthetic loopback Gateway, exact source revisions.
set -euo pipefail
source_repo="$(cd "$1" && pwd)"
proof_repo="$(cd "$2" && pwd)"
output="$3"
baseline="$4"
candidate="$5"
device_family="${7:-iPhone}"
grouping_patch="${8:-}"
if [[ -n "$grouping_patch" ]]; then
  [[ "$baseline" == "$candidate" ]]
  [[ "${GROUPING_PATCH_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]
  test "$(shasum -a 256 "$grouping_patch" | awk '{print $1}')" = "$GROUPING_PATCH_SHA256"
fi
[[ "$device_family" == iPhone || "$device_family" == iPad ]]
stages=(before after)
if [[ "${6:-both}" != both ]]; then
  [[ "$6" == before || "$6" == after ]]
  stages=("$6")
fi
[[ "$baseline" =~ ^[0-9a-f]{40}$ && "$candidate" =~ ^[0-9a-f]{40}$ ]]
mkdir -p "$output"
output="$(cd "$output" && pwd)"
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-narration.XXXXXX")"
simulator=""
fixture_pid=""
recorder_pid=""
checkout=""
cleanup() {
  local status=$?
  if [[ -n "$recorder_pid" ]]; then kill -INT "$recorder_pid" 2>/dev/null || true; wait "$recorder_pid" || true; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" || true; fi
  if [[ -n "$simulator" ]]; then
    xcrun simctl shutdown "$simulator" 2>/dev/null || true
    xcrun simctl delete "$simulator" || true
  fi
  if [[ -n "$checkout" ]]; then git -C "$source_repo" worktree remove --force "$checkout" || true; fi
  rm -rf "$scratch"
  if [[ "$status" -ne 0 ]]; then printf '[ios-narration-proof] FAILED (exit %s)\n' "$status" >&2; fi
}
trap cleanup EXIT

test "$(git -C "$source_repo" rev-parse HEAD)" = "$candidate"
git -C "$source_repo" cat-file -e "$baseline^{commit}"
# Check physical devices before choosing a task-owned simulator on the hosted Mac.
xcrun devicectl list devices > "$output/physical-devices.txt"
xcrun simctl list devices available --json > "$scratch/devices.json"
xcrun simctl help io > "$output/simctl-io-contract.txt"
node -e '
const fs=require("node:fs");
const runtimes=Object.entries(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).devices);
const family=process.argv[2];
for(const [runtime,devices] of runtimes){
 const device=devices.find(d=>d.isAvailable&&d.name.startsWith(family));
 if(device){console.log(device.name);console.log(runtime);process.exit(0);}
}
throw new Error(`No available ${family} simulator`);
' "$scratch/devices.json" "$device_family" > "$scratch/device.txt"
device="$(sed -n '1p' "$scratch/device.txt")"
runtime="$(sed -n '2p' "$scratch/device.txt")"
printf 'Baseline: %s\nCandidate: %s\nDevice: %s\nRuntime: %s\n' \
  "$baseline" "$candidate" "$device" "$runtime" > "$output/provenance.txt"
if [[ -n "$grouping_patch" ]]; then
  printf 'Comparison: current PR versus grouping patch\nPatch SHA256: %s\n' "$GROUPING_PATCH_SHA256" >> "$output/provenance.txt"
fi
xcodebuild -version >> "$output/provenance.txt"
swift --version >> "$output/provenance.txt"

export TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY=1
export TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE='{"url":"ws://127.0.0.1:19876","token":"synthetic-navigation-token"}'
export TEST_RUNNER_OPENCLAW_IOS_NARRATION_FIXTURE_URL=http://127.0.0.1:19876

for stage in "${stages[@]}"; do
  revision="$baseline"
  [[ "$stage" == before ]] || revision="$candidate"
  checkout="$scratch/$stage"
  git -C "$source_repo" worktree add --detach "$checkout" "$revision"
  if [[ "$stage" == after && -n "$grouping_patch" ]]; then
    git -C "$checkout" apply --index "$grouping_patch"
  fi
  if [[ "$stage" == after && -n "$grouping_patch" ]]; then
    # Fail on source formatting before the expensive native dependency/build pass.
    swiftformat --lint "$checkout/apps/shared/OpenClawKit/Sources/OpenClawChatUI" \
      --config "$checkout/config/swiftformat" \
      --unexclude "$checkout/apps/shared/OpenClawKit/Sources/OpenClawChatUI"
  fi
  # The index freezes the reviewed product bytes, including newly added files.
  # Build helpers may change generated files, never the pinned native sources.
  expected_tree="$(git -C "$checkout" write-tree)"
  printf '%s source tree: %s\n' "$stage" "$expected_tree" >> "$output/provenance.txt"
  # Both trees run identical UI-test code; the candidate alone receives the patch.
  cp "$proof_repo/apps/ios/UITests/OpenClawSnapshotUITests.swift" "$checkout/apps/ios/UITests/"
  cp "$proof_repo/scripts/test-ios-shell-gateway.mjs" "$checkout/scripts/"
  (
    cd "$checkout"
    pnpm install --frozen-lockfile
    ./scripts/ios-configure-signing.sh
    ./scripts/ios-write-version-xcconfig.sh
    node scripts/ios-write-swift-filelist.mjs
    xcodegen generate --spec apps/ios/project.yml --project apps/ios
  ) > "$output/$stage-setup.log" 2>&1
  git -C "$checkout" diff --exit-code -- apps/ios/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests
  if [[ "$stage" == after && -n "$grouping_patch" ]]; then
    if ! swift test --package-path "$checkout/apps/shared/OpenClawKit" \
      --filter 'ChatAssistantRunGroupTests|ChatCompletedWorkTests|ChatTranscriptRowTests' \
      > "$output/$stage-shared-tests.log" 2>&1; then
      tail -n 100 "$output/$stage-shared-tests.log"
      exit 1
    fi
  fi
  simulator="$(xcrun simctl create "OpenClaw narration $device_family $stage $$" "$device" "$runtime")"
  xcrun simctl boot "$simulator"
  xcrun simctl bootstatus "$simulator" -b
  xcrun simctl status_bar "$simulator" override --time 09:41 --batteryState charged --batteryLevel 100
  xcrun simctl ui "$simulator" appearance dark
  args=(
    -project "$checkout/apps/ios/OpenClaw.xcodeproj" -scheme OpenClawUITests
    -configuration Debug -destination "platform=iOS Simulator,id=$simulator"
    -derivedDataPath "$scratch/derived-$stage"
    -clonedSourcePackagesDirPath "$scratch/packages"
    -testLanguage en -testRegion US -parallel-testing-enabled NO
    -only-testing:OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayInlineNarrationAndRecovery
  )
  if ! xcodebuild "${args[@]}" build-for-testing > "$output/$stage-build.log" 2>&1; then
    tail -n 100 "$output/$stage-build.log"
    exit 1
  fi
  fixture_args=(--narration)
  if [[ -n "$grouping_patch" ]]; then fixture_args+=(--narration-pending-tool); fi
  node "$checkout/scripts/test-ios-shell-gateway.mjs" "${fixture_args[@]}" > "$output/$stage-gateway.log" 2>&1 &
  fixture_pid=$!
  for attempt in {1..30}; do
    if curl --fail --silent http://127.0.0.1:19876/narration > "$output/$stage-initial.json"; then break; fi
    kill -0 "$fixture_pid"
    sleep 1
  done
  curl --fail --silent http://127.0.0.1:19876/narration > "$output/$stage-initial.json"
  export TEST_RUNNER_OPENCLAW_IOS_NARRATION_STAGE="$stage"
  if [[ -n "$grouping_patch" ]]; then
    export TEST_RUNNER_OPENCLAW_IOS_GROUPING_COMPARISON=1
    unset TEST_RUNNER_OPENCLAW_IOS_NARRATION_BASELINE
  elif [[ "$stage" == before ]]; then
    export TEST_RUNNER_OPENCLAW_IOS_NARRATION_BASELINE=1
  else
    unset TEST_RUNNER_OPENCLAW_IOS_NARRATION_BASELINE
  fi
  node -e 'console.log(Date.now())' > "$output/$stage-recording-start.txt"
  xcrun simctl io "$simulator" recordVideo --codec=h264 --force "$output/$stage.mov" > "$output/$stage-recorder.log" 2>&1 &
  recorder_pid=$!
  status=0
  xcodebuild "${args[@]}" -collect-test-diagnostics never \
    -resultBundlePath "$output/$stage.xcresult" test-without-building > "$output/$stage-test.log" 2>&1 || status=$?
  kill -INT "$recorder_pid"
  wait "$recorder_pid"
  recorder_pid=""
  curl --fail --silent http://127.0.0.1:19876/narration > "$output/$stage-events.json"
  xcrun xcresulttool get test-results summary --path "$output/$stage.xcresult" --compact > "$output/$stage-summary.json"
  xcrun xcresulttool export attachments --path "$output/$stage.xcresult" --output-path "$output/$stage-images"
  tail -n 80 "$output/$stage-test.log"
  if [[ "$stage" == before && -z "$grouping_patch" ]]; then
    [[ "$status" -ne 0 ]]
    grep -q NARRATION_MISSING_WHILE_RUNNING "$output/$stage-test.log"
    node -e 'const r=require(process.argv[1]);if(r.result!=="Failed"||r.failedTests!==1||r.passedTests!==0)process.exit(1)' "$output/$stage-summary.json"
  else
    [[ "$status" -eq 0 ]]
    node -e 'const r=require(process.argv[1]);if(r.result!=="Passed"||r.failedTests!==0||r.passedTests!==1)process.exit(1)' "$output/$stage-summary.json"
  fi
  git -C "$checkout" diff --exit-code -- apps/ios/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests
  test "$(git -C "$checkout" write-tree)" = "$expected_tree"
  test -z "$(git -C "$checkout" ls-files --others --exclude-standard -- apps/ios/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests)"
  kill "$fixture_pid"
  wait "$fixture_pid"
  fixture_pid=""
  xcrun simctl shutdown "$simulator"
  xcrun simctl delete "$simulator"
  simulator=""
  git -C "$source_repo" worktree remove --force "$checkout"
  checkout=""
done
