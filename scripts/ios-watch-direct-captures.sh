#!/bin/bash
set -euo pipefail

output_dir="${1:?Expected a task-owned capture directory}"
mkdir -p "$output_dir"
simulator_id=""
bundle_id=""
console_pid=""

# Share the existing strict process-tree owner for captures and console launches.
managed_command='
import { runManagedCommand } from "./scripts/lib/managed-child-process.mts";
const [seconds, bin, ...args] = process.argv.slice(1);
const budget = Number(seconds) * 1000;
if (!(budget > 0)) process.exit(124);
try {
  process.exitCode = await runManagedCommand({
    bin, args, timeoutMs: budget, timeoutKillGraceMs: 1000,
    requireProcessTreeExit: true, timeoutForceKillOnLeaderExit: true,
  });
  console.error("watch-capture-managed-joined");
} catch (error) {
  console.error(error);
  process.exitCode = error.code === "ETIMEDOUT" ? 124 : 125;
}
'
run_for() {
  node --input-type=module -e "$managed_command" "$@"
}

cleanup_launch() {
  local failed=0 status=0
  if [ -n "$console_pid" ]; then
    if kill -0 "$console_pid" 2>/dev/null; then
      if ! run_for 5 xcrun simctl terminate "$simulator_id" "$bundle_id"; then
        echo "error: capture app termination failed" >&2
        failed=1
      fi
      # Signal the managed owner, never kill it before it can join its process tree.
      kill "$console_pid" 2>/dev/null || true
    fi
    # simctl can exit nonzero when its console app is intentionally terminated.
    # Reserved wrapper failures must not be mistaken for that ordinary app exit.
    wait "$console_pid" || status="$?"
    if [ "$status" -eq 124 ] || [ "$status" -eq 125 ] ||
      ! grep -qx "watch-capture-managed-joined" "$console_log"; then
      echo "error: capture console deadline or process-tree cleanup failed" >&2
      failed=1
    fi
    console_pid=""
  fi
  return "$failed"
}

cleanup() {
  local primary="$?" failed=0 state
  trap - EXIT
  trap '' INT TERM
  cleanup_launch || failed=1
  if [ -n "$simulator_id" ]; then
    state="$(run_for 10 xcrun simctl list devices --json | node --input-type=module -e '
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const matches = Object.values(JSON.parse(Buffer.concat(chunks)).devices).flat()
        .filter((device) => device.udid === process.argv[1]);
      if (matches.length !== 1) throw new Error("Missing capture-owned simulator");
      process.stdout.write(matches[0].state);
    ' "$simulator_id")" || failed=1
    if [ "$state" != "Shutdown" ]; then
      run_for 20 xcrun simctl shutdown "$simulator_id" || failed=1
    fi
    run_for 20 xcrun simctl delete "$simulator_id" || failed=1
    printf 'capture-device-cleanup:%s:%s\n' "$simulator_id" "$failed" >&2
  fi
  if [ "$failed" -ne 0 ]; then
    echo "error: capture cleanup failed (primary exit: $primary)" >&2
    if [ "$primary" -eq 0 ]; then primary=1; fi
  fi
  exit "$primary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Read the same destination used by the test script only to resolve its existing
# product and installed runtime/type. Never launch, erase, or clone that device.
read -r source_id runtime_id device_type_id < <(
  xcrun simctl list --json | node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const inventory = JSON.parse(Buffer.concat(chunks));
    for (const [runtimeID, devices] of Object.entries(inventory.devices)) {
      const device = devices.find((entry) => entry.isAvailable && entry.name.startsWith("Apple Watch"));
      if (!device) continue;
      const runtime = inventory.runtimes.find((entry) => entry.identifier === runtimeID && entry.isAvailable);
      const type = inventory.devicetypes.find((entry) => entry.identifier === device.deviceTypeIdentifier);
      if (!runtime || !type || !runtimeID.includes(".watchOS-") ||
          !type.identifier.startsWith("com.apple.CoreSimulator.SimDeviceType.Apple-Watch-")) {
        throw new Error("Expected explicit installed Watch runtime and device type identifiers");
      }
      console.log(device.udid, runtime.identifier, type.identifier);
      process.exit(0);
    }
    throw new Error("No available Watch simulator product destination");
  '
)
product="$(
  xcodebuild -project apps/ios/OpenClaw.xcodeproj -scheme OpenClawWatchApp \
    -configuration Debug -destination "platform=watchOS Simulator,id=${source_id}" \
    CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES \
    -showBuildSettings -json build-for-testing |
    node --input-type=module -e '
      import { execFileSync } from "node:child_process";
      import path from "node:path";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const targets = JSON.parse(Buffer.concat(chunks)).filter((entry) => entry.target === "OpenClawWatchApp");
      if (targets.length !== 1) throw new Error("Expected one existing Watch app target");
      const settings = targets[0].buildSettings;
      if (!path.isAbsolute(settings.TARGET_BUILD_DIR) || !settings.FULL_PRODUCT_NAME ||
          !settings.PRODUCT_BUNDLE_IDENTIFIER) throw new Error("Missing existing Watch product settings");
      const app = path.join(settings.TARGET_BUILD_DIR, settings.FULL_PRODUCT_NAME);
      execFileSync("codesign", ["--verify", "--strict", app], { stdio: "pipe" });
      const info = JSON.parse(execFileSync("plutil", [
        "-convert", "json", "-o", "-", path.join(app, "Info.plist"),
      ], { encoding: "utf8" }));
      if (info.CFBundleIdentifier !== settings.PRODUCT_BUNDLE_IDENTIFIER) {
        throw new Error("Existing Watch product identity does not match Xcode");
      }
      process.stdout.write(JSON.stringify({ app, bundleID: info.CFBundleIdentifier }));
    '
)"
app_path="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).app)' "$product")"
bundle_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).bundleID)' "$product")"
checker="$output_dir/watch-direct-capture-check"
# Host compilation is deliberately outside every twenty-second capture budget.
xcrun swiftc scripts/ios-watch-direct-capture-check.swift -o "$checker"

created_id="$(xcrun simctl create "OpenClaw Direct Captures" "$device_type_id" "$runtime_id")"
validated_id="$(node --input-type=module -e '
  const [created, source] = process.argv.slice(1);
  if (!/^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(created) ||
      created.toLowerCase() === source.toLowerCase()) {
    throw new Error("Create did not return one fresh simulator UUID; cleanup ownership is unknown");
  }
  process.stdout.write(created);
' "$created_id" "$source_id")"
simulator_id="$validated_id"
# Persist ownership before boot, including when a later boot/install/capture fails.
printf '%s\n' "$simulator_id" > "$output_dir/capture-device.udid"
node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { execFileSync } from "node:child_process";
  import { readFileSync } from "node:fs";
  import path from "node:path";
  const [udid, runtimeID, deviceTypeID, productJSON] = process.argv.slice(1);
  const product = JSON.parse(productJSON);
  const info = JSON.parse(execFileSync("plutil", [
    "-convert", "json", "-o", "-", path.join(product.app, "Info.plist"),
  ], { encoding: "utf8" }));
  const executableSHA256 = createHash("sha256")
    .update(readFileSync(path.join(product.app, info.CFBundleExecutable))).digest("hex");
  console.log(JSON.stringify({ udid, runtimeID, deviceTypeID, bundleID: product.bundleID, executableSHA256 }));
' "$simulator_id" "$runtime_id" "$device_type_id" "$product" > "$output_dir/capture-device.json"
xcrun simctl boot "$simulator_id"
xcrun simctl bootstatus "$simulator_id" -b
xcrun simctl install "$simulator_id" "$app_path"

for scenario in payment payment-terms standing-grant standing-grant-terms unsupported-context \
  creation-failed creation-unknown creation-succeeded no-conversation; do
  console_log="$output_dir/$scenario.log"
  deadline="$((SECONDS + 20))"
  node --input-type=module -e "$managed_command" "$((deadline - SECONDS))" \
    xcrun simctl launch --console "$simulator_id" "$bundle_id" \
    "--openclaw-watch-direct-proof=$scenario" >"$console_log" 2>&1 &
  console_pid="$!"
  until grep -q "watch-direct-proof-ready:$scenario" "$console_log"; do
    if [ "$SECONDS" -ge "$deadline" ] || ! kill -0 "$console_pid" 2>/dev/null; then
      echo "error: Watch direct capture did not reach its rendered scenario: $scenario" >&2
      exit 1
    fi
    sleep 0.1
  done
  run_for "$((deadline - SECONDS))" xcrun simctl io "$simulator_id" screenshot "$output_dir/$scenario.png"
  check_args=("$scenario" "$output_dir/$scenario.png")
  case "$scenario" in
    payment-terms) check_args+=("$output_dir/payment.png") ;;
    standing-grant-terms) check_args+=("$output_dir/standing-grant.png") ;;
  esac
  run_for "$((deadline - SECONDS))" "$checker" "${check_args[@]}" \
    > "$output_dir/$scenario.check.json"
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "error: Watch direct capture exceeded its scenario deadline: $scenario" >&2
    exit 1
  fi
  cleanup_launch
done
