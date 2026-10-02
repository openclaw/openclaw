#!/bin/bash
set -euo pipefail

result_bundle="${1:-apps/ios/build/LifecycleTestResults/OpenClawWatchOperationTests.xcresult}"
phase="${3:-suites}"
state_dir="${4:-}"
run_build_step() {
  local label="$1" status=0
  shift
  if [ "$phase" != "build" ]; then
    "$@"
    return
  fi
  printf 'OPENCLAW_WATCH_BUILD\tstart\t%s\n' "$label" >&2
  "$@" || status=$?
  printf 'OPENCLAW_WATCH_BUILD\tend\t%s\t%s\n' "$label" "$status" >&2
  return "$status"
}
if [ "$#" -gt 1 ]; then
  if [ "$#" -ne 4 ] || [[ ! "$2" =~ ^[A-Fa-f0-9-]{36}$ ]] || [[ "$state_dir" != /* ]]; then
    echo "Expected result bundle, owned simulator UUID, phase, and private state directory" >&2
    exit 1
  fi
  case "$phase" in build|identity|negative|positive|voice) ;; *) exit 1 ;; esac
  simulator_id="$2"
else
  simulator_id="$(
  xcrun simctl list devices available --json | node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const runtimes = JSON.parse(Buffer.concat(chunks).toString("utf8")).devices;
    const simulator = Object.values(runtimes)
      .flat()
      .find((device) => device.isAvailable && device.name.startsWith("Apple Watch"));
    if (!simulator) {
      console.error("No available Apple Watch simulator for operation lifecycle tests");
      process.exit(1);
    }
    process.stdout.write(simulator.udid);
  '
)"
fi
# Reuse existing products and resolve the selected target from Xcode, not DerivedData naming.
xcodebuild_args=(
  -project apps/ios/OpenClaw.xcodeproj
  -scheme OpenClawWatchApp
  -configuration Debug
  -destination "platform=watchOS Simulator,id=${simulator_id}"
  CODE_SIGNING_ALLOWED=YES
  CODE_SIGN_IDENTITY=-
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES
)
test_args=(
  -parallel-testing-enabled NO
  -only-testing:OpenClawWatchTests/WatchInboxStoreOperationTests
  -only-testing:OpenClawWatchTests/WatchSpeechPlaybackTests
  -only-testing:OpenClawWatchTests/WatchRealtimeMediaTests
  -only-testing:OpenClawWatchTests/WatchGatewayConfigurationTests
  -only-testing:OpenClawWatchTests/WatchDirectConversationTests
  -only-testing:OpenClawWatchTests/WatchGatewayControllerTests
)
if [ "$phase" != "suites" ]; then
  test_args=(-parallel-testing-enabled NO -only-testing:OpenClawWatchTests/WatchOperatorHTTPSQualificationTests)
fi
if [ "$phase" = "suites" ] || [ "$phase" = "build" ]; then
run_build_step build-for-testing xcodebuild "${xcodebuild_args[@]}" "${test_args[@]}" build-for-testing
# Finish the query before validation so a failed query cannot become a JSON-parser failure.
build_settings="$(run_build_step build-settings xcodebuild "${xcodebuild_args[@]}" "${test_args[@]}" -showBuildSettings -json build-for-testing)"
app_path="$(
  printf '%s\n' "$build_settings" |
    WATCH_QUALIFICATION_STATE="$state_dir" WATCH_QUALIFICATION_SIMULATOR="$simulator_id" run_build_step host-validation node --input-type=module -e '
      import { execFileSync } from "node:child_process";
      import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import path from "node:path";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const targets = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const targetMatches = Object.fromEntries(
        ["OpenClawWatchApp", "OpenClawWatchTests"].map((name) => [
          name, targets.filter((target) => target.target === name),
        ]),
      );
      console.error(JSON.stringify({
        watchBuildSettings: Object.fromEntries(
          Object.entries(targetMatches).map(([name, matches]) => [name, matches.length]),
        ),
      }));
      const settings = (name) => {
        const matches = targetMatches[name];
        if (matches.length !== 1) throw new Error(`Expected one ${name} target from Xcode, got ${matches.length}`);
        return matches[0].buildSettings;
      };
      const app = settings("OpenClawWatchApp");
      const tests = settings("OpenClawWatchTests");
      const product = (target) => {
        if (!path.isAbsolute(target.TARGET_BUILD_DIR) || !target.FULL_PRODUCT_NAME) {
          throw new Error("Expected an absolute Watch product from Xcode");
        }
        return path.join(target.TARGET_BUILD_DIR, target.FULL_PRODUCT_NAME);
      };
      const appPath = product(app);
      const testsPath = product(tests);
      if (!app.EXECUTABLE_NAME || tests.TEST_HOST !== path.join(appPath, app.EXECUTABLE_NAME)) {
        throw new Error("Watch tests must run in the verified Watch app host");
      }
      if (!app.DEVELOPMENT_TEAM) {
        throw new Error("Missing configured Watch app development team");
      }
      if (tests.DEVELOPMENT_TEAM !== app.DEVELOPMENT_TEAM) {
        throw new Error("Configured Watch test team does not match the app team");
      }
      if (!app.PRODUCT_BUNDLE_IDENTIFIER) {
        throw new Error("Missing configured Watch app bundle identifier");
      }
      for (const target of [app, tests]) {
        if (target.CODE_SIGNING_ALLOWED !== "YES" || target.CODE_SIGN_IDENTITY !== "-" ||
            target.CODE_SIGN_INJECT_BASE_ENTITLEMENTS !== "YES") {
          throw new Error("Expected ad-hoc simulator signing with platform entitlements");
        }
      }
      for (const bundle of [appPath, testsPath]) {
        execFileSync("codesign", ["--verify", "--strict", bundle], { stdio: "pipe" });
      }
      const readPlist = (filePath) => JSON.parse(execFileSync(
        "plutil", ["-convert", "json", "-o", "-", filePath], { encoding: "utf8" }));
      if (readPlist(path.join(appPath, "Info.plist")).CFBundleIdentifier !== app.PRODUCT_BUNDLE_IDENTIFIER) {
        throw new Error("Built Watch bundle identifier does not match its configuration");
      }
      if (!app.TARGET_TEMP_DIR || !path.isAbsolute(app.TARGET_TEMP_DIR)) {
        throw new Error("Expected an absolute Watch target intermediate directory from Xcode");
      }
      // The query may omit provisioning-derived AppIdentifierPrefix. Read the
      // generated linker input for this target instead of deriving a seed from its team.
      const generatedPath = path.join(app.TARGET_TEMP_DIR, app.FULL_PRODUCT_NAME + "-Simulated.xcent");
      const expectedApplicationID = readPlist(generatedPath)["application-identifier"];
      if (typeof expectedApplicationID !== "string" ||
          !/^[A-Za-z0-9]{10}\.[A-Za-z0-9.-]+$/.test(expectedApplicationID) ||
          expectedApplicationID.slice(11) !== app.PRODUCT_BUNDLE_IDENTIFIER) {
        throw new Error("Expected a fully evaluated generated Watch application identifier for the configured bundle");
      }
      const extractionDirectory = mkdtempSync(path.join(tmpdir(), "openclaw-watch-entitlements-"));
      try {
        // Simulator identity lives in the executable section, not its code signature.
        // segedit accepts only thin Mach-O inputs. Check every slice without changing the signed product.
        const architectures = execFileSync("xcrun", ["lipo", "-archs", tests.TEST_HOST],
          { encoding: "utf8" }).trim().split(/\s+/);
        for (const architecture of architectures) {
          let executable = tests.TEST_HOST;
          if (architectures.length > 1) {
            executable = path.join(extractionDirectory, `host-${architecture}`);
            execFileSync("xcrun", ["lipo", tests.TEST_HOST, "-thin", architecture, "-output", executable]);
          }
          // Use a real file: segedit stdout formats a C string instead of exact section bytes.
          const plistPath = path.join(extractionDirectory, `entitlements-${architecture}.plist`);
          execFileSync("xcrun", [
            "segedit", executable, "-extract", "__TEXT", "__entitlements", plistPath,
          ], { stdio: "pipe" });
          const entitlements = readPlist(plistPath);
          const applicationID = entitlements["application-identifier"];
          if (applicationID !== expectedApplicationID) {
            throw new Error("Simulated Watch host application identifier does not match its build identity");
          }
          // The application identifier supplies the private Keychain group when no
          // explicit groups are present. Never manufacture a sharing entitlement.
          const groups = entitlements["keychain-access-groups"];
          if (groups !== undefined &&
              (!Array.isArray(groups) || groups.some((group) => typeof group !== "string" || !group))) {
            throw new Error("Malformed Watch host Keychain access groups");
          }
          console.error(JSON.stringify({
            watchSigning: {
              architecture,
              team: app.DEVELOPMENT_TEAM,
              style: app.CODE_SIGN_STYLE,
              entitlementsFile: app.CODE_SIGN_ENTITLEMENTS ?? null,
              entitlementsSource: "__TEXT,__entitlements",
              applicationID,
              keychainAccessGroups: groups ?? null,
              testBundle: tests.PRODUCT_BUNDLE_IDENTIFIER,
              testStyle: tests.CODE_SIGN_STYLE,
              testEntitlementsFile: tests.CODE_SIGN_ENTITLEMENTS ?? null,
            },
          }));
        }
      } finally {
        rmSync(extractionDirectory, { recursive: true, force: true });
      }
      if (process.env.WATCH_QUALIFICATION_STATE) {
        writeFileSync(path.join(process.env.WATCH_QUALIFICATION_STATE, "build.json"),
          JSON.stringify({ simulator: process.env.WATCH_QUALIFICATION_SIMULATOR,
            appPath, bundleID: app.PRODUCT_BUNDLE_IDENTIFIER }), { mode: 0o600, flag: "wx" });
      }
      process.stdout.write(appPath);
    '
)"
if [ "$phase" = "suites" ]; then
companion_id="$(
  xcrun simctl list pairs --json | node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const pairs = Object.values(JSON.parse(Buffer.concat(chunks).toString("utf8")).pairs);
    const pair = pairs.find((entry) => entry.watch.udid === process.argv[1]);
    process.stdout.write(pair?.phone.udid ?? "");
  ' "$simulator_id"
)"
# XCTest connects through the selected Watch companion, not necessarily IOS_SIMULATOR_ID.
if [ -n "$companion_id" ]; then
  xcrun simctl bootstatus "$companion_id" -b
fi
xcrun simctl boot "$simulator_id" 2>/dev/null || true
xcrun simctl bootstatus "$simulator_id" -b
fi
run_build_step install xcrun simctl install "$simulator_id" "$app_path"
if [ "$phase" = "build" ]; then exit 0; fi
else
  # Only the coordinator's verified build may feed a phase; never rebuild or pick another device.
  node --input-type=module -e '
    import assert from "node:assert/strict";
    import { readFileSync, lstatSync } from "node:fs";
    import path from "node:path";
    const [state, simulator] = process.argv.slice(1);
    const file = path.join(state, "build.json");
    assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    const build = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(build.simulator, simulator);
    assert(path.isAbsolute(build.appPath) && typeof build.bundleID === "string");
  ' "$state_dir" "$simulator_id"
fi
xcodebuild "${xcodebuild_args[@]}" "${test_args[@]}" \
  -resultBundlePath "$result_bundle" \
  test-without-building
