#!/bin/bash
# Proof-only driver: exact baseline or grouped native executable, external XCTest, loopback Gateway.
set -euo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]]
source_repo="$(cd "$1" && pwd)"
proof_repo="$(cd "$2" && pwd)"
output="$3"
stage="$4"
[[ "$stage" == before || "$stage" == after ]]
[[ "$BASELINE_SHA" =~ ^[0-9a-f]{40}$ && "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$BASELINE_SHA" == "$CANDIDATE_SHA" ]]
[[ "${GROUPING_PATCH_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]
grouping_patch="$proof_repo/scripts/ios-agent-grouping.patch"
test "$(shasum -a 256 "$grouping_patch" | awk '{print $1}')" = "$GROUPING_PATCH_SHA256"
mkdir -p "$output"
scratch="$(mktemp -d "$RUNNER_TEMP/mac-narration.XXXXXX")"
fixture_pid=""
checkout=""
cleanup() {
  local status=$?
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" || true; fi
  if [[ "$status" -ne 0 ]]; then printf '[mac-narration-proof] FAILED (exit %s)\n' "$status" >&2; fi
  # The disposable worker owns app/Keychain state; preserve failed-run diagnostics.
}
trap cleanup EXIT
revision="$CANDIDATE_SHA"
[[ "$stage" == after ]] || revision="$BASELINE_SHA"
test "$(git -C "$source_repo" rev-parse HEAD)" = "$CANDIDATE_SHA"
git -C "$source_repo" cat-file -e "$revision^{commit}"
checkout="$scratch/product"
git -C "$source_repo" worktree add --detach "$checkout" "$revision"
if [[ "$stage" == after ]]; then
  git -C "$checkout" apply --index "$grouping_patch"
fi
# Freeze all product bytes, including new files. Helpers cannot mutate native sources.
expected_tree="$(git -C "$checkout" write-tree)"
{
  printf 'Product revision: %s\nStage: %s\nProof revision: %s\n' "$revision" "$stage" "$(git -C "$proof_repo" rev-parse HEAD)"
  printf 'Grouping patch SHA256: %s\nSource tree: %s\n' "$GROUPING_PATCH_SHA256" "$expected_tree"
  sw_vers
  xcodebuild -version
  swift --version
  printf 'Native SwiftPM development app bundle; synthetic Gateway; no release/TCC/provider proof.\n'
} > "$output/provenance.txt"

# Match the native CI build's required generated resource preparation.
if ! (
  cd "$checkout"
  pnpm install --frozen-lockfile --prefer-offline --optional \
    --filter '@openclaw/mermaid-renderer...' --config.ignore-scripts=false \
    --config.engine-strict=false --config.enable-pre-post-scripts=true --config.side-effects-cache=true
  node scripts/prepare-apple-mermaid.mjs
) > "$output/assets.log" 2>&1; then
  tail -n 100 "$output/assets.log"
  exit 1
fi

if ! swift build --package-path "$checkout/apps/macos" --build-system native --product OpenClaw \
  > "$output/build.log" 2>&1; then
  tail -n 100 "$output/build.log"
  exit 1
fi
products="$(swift build --package-path "$checkout/apps/macos" --build-system native --show-bin-path)"
app="$scratch/OpenClaw.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
cp "$products/OpenClaw" "$app/Contents/MacOS/OpenClaw"
cp "$checkout/apps/macos/Sources/OpenClaw/Resources/Info.plist" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier ai.openclaw.mac.narration-proof' "$app/Contents/Info.plist"
for resource in "$products/"*.bundle; do
  [[ ! -d "$resource" ]] || cp -R "$resource" "$app/Contents/Resources/"
done
sparkle="$checkout/apps/macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
test -d "$sparkle"
cp -R "$sparkle" "$app/Contents/Frameworks/"
compat="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.2/macosx/libswiftCompatibilitySpan.dylib"
[[ ! -f "$compat" ]] || cp "$compat" "$app/Contents/Frameworks/"
# This dev bundle is solely a host for ordinary native UI. No permission capability is tested.
codesign --force --deep --sign - "$app" > "$output/signing.log" 2>&1
otool -L "$app/Contents/MacOS/OpenClaw" > "$output/linked-libraries.txt"
shasum -a 256 "$products/OpenClaw" "$app/Contents/MacOS/OpenClaw" > "$output/executable-hashes.txt"
git -C "$checkout" diff --exit-code -- apps/macos/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests

fixture="$scratch/fixture"
mkdir -p "$fixture"
cp "$proof_repo/scripts/test-ios-shell-gateway.mjs" "$fixture/gateway.mjs"
node -e 'const fs=require("node:fs");const p=require(process.argv[1]);fs.writeFileSync(process.argv[2],JSON.stringify({private:true,dependencies:{ws:p.dependencies.ws},packageManager:p.packageManager}))' \
  "$checkout/package.json" "$fixture/package.json"
pnpm --dir "$fixture" install --ignore-scripts > "$output/fixture-install.log" 2>&1
node "$fixture/gateway.mjs" --narration --narration-pending-tool > "$output/gateway.log" 2>&1 &
fixture_pid=$!
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:19876/narration > "$output/initial.json"; then break; fi
  kill -0 "$fixture_pid"
  sleep 1
done
curl --fail --silent http://127.0.0.1:19876/narration > "$output/initial.json"

app_home="$scratch/home"
state="$scratch/state"
mkdir -p "$app_home/Library/Preferences" "$app_home/Library/Keychains" "$state"
node -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({gateway:{mode:"remote",remote:{transport:"direct",url:"ws://127.0.0.1:19876",token:"synthetic-navigation-token"}}}))' "$state/openclaw.json"
for setting in 'openclaw.nativeExperienceEnabled' 'openclaw.onboardingSeen'; do
  HOME="$app_home" CFFIXED_USER_HOME="$app_home" defaults write ai.openclaw.mac.profile.macproof "$setting" -bool true
done
HOME="$app_home" CFFIXED_USER_HOME="$app_home" defaults write ai.openclaw.mac.profile.macproof openclaw.onboardingVersion -int 8
HOME="$app_home" CFFIXED_USER_HOME="$app_home" defaults read ai.openclaw.mac.profile.macproof \
  openclaw.nativeExperienceEnabled > "$output/native-experience-enabled.txt"
test "$(cat "$output/native-experience-enabled.txt")" = 1
keychain="$app_home/Library/Keychains/proof.keychain-db"
for action in create unlock; do
  HOME="$app_home" CFFIXED_USER_HOME="$app_home" security "$action-keychain" -p '' "$keychain"
done
HOME="$app_home" CFFIXED_USER_HOME="$app_home" security set-keychain-settings "$keychain"
HOME="$app_home" CFFIXED_USER_HOME="$app_home" security list-keychains -d user -s "$keychain"
HOME="$app_home" CFFIXED_USER_HOME="$app_home" security default-keychain -d user -s "$keychain"

test_project="$scratch/ui-tests"
mkdir -p "$test_project"
cp "$proof_repo/scripts/mac-narration-proof/NativeNarrationUITests.swift" "$test_project/"
cp "$proof_repo/scripts/mac-narration-proof/project.yml" "$test_project/"
xcodegen generate --spec "$test_project/project.yml" --project "$test_project"
export TEST_RUNNER_OPENCLAW_MAC_PROOF_APP="$app"
export TEST_RUNNER_OPENCLAW_MAC_PROOF_HOME="$app_home"
export TEST_RUNNER_OPENCLAW_MAC_PROOF_STATE="$state"
export TEST_RUNNER_OPENCLAW_MAC_PROOF_CONFIG="$state/openclaw.json"
export TEST_RUNNER_OPENCLAW_MAC_PROOF_STAGE="$stage"
export TEST_RUNNER_OPENCLAW_MAC_PROOF_PRODUCTS="$products"
export TEST_RUNNER_OPENCLAW_MAC_PROOF_TOOL_IMAGE="$output/live-tool.png"
args=(-project "$test_project/NativeNarrationProof.xcodeproj" -scheme NativeNarrationProof
  -destination 'platform=macOS' -derivedDataPath "$scratch/derived" -parallel-testing-enabled NO)
if ! xcodebuild "${args[@]}" build-for-testing > "$output/ui-build.log" 2>&1; then
  tail -n 100 "$output/ui-build.log"
  exit 1
fi
status=0
xcodebuild "${args[@]}" -resultBundlePath "$output/$stage.xcresult" test-without-building \
  > "$output/ui-test.log" 2>&1 || status=$?
/usr/bin/log show --last 8m --style compact --predicate 'process == "OpenClaw"' \
  > "$output/app-runtime.log" 2>&1 || true
curl --fail --silent http://127.0.0.1:19876/narration > "$output/events.json"
curl --fail --silent http://127.0.0.1:19876/ > "$output/requests.json"
xcrun xcresulttool get test-results summary --path "$output/$stage.xcresult" --compact > "$output/summary.json"
xcrun xcresulttool export attachments --path "$output/$stage.xcresult" --output-path "$output/images"
tail -n 100 "$output/ui-test.log"
git -C "$checkout" diff --exit-code -- apps/macos/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests
test "$(git -C "$checkout" write-tree)" = "$expected_tree"
test -z "$(git -C "$checkout" ls-files --others --exclude-standard -- apps/macos/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests)"
[[ "$status" -eq 0 ]]
# Check the exact live row, not fixture payloads; both arguments and active status must render.
tesseract "$output/live-tool.png" "$output/live-tool" -l eng --psm 6
grep -Fq 'Layout.swift' "$output/live-tool.txt"
grep -Fq 'Working' "$output/live-tool.txt"
node -e 'const r=require(process.argv[1]);if(r.result!=="Passed"||r.failedTests!==0||r.passedTests!==1)process.exit(1)' "$output/summary.json"
node -e 'const r=require(process.argv[1]);if(r.requests.filter(x=>x.method==="chat.send").length!==1)throw new Error("Expected exactly one UI chat.send")' "$output/requests.json"
