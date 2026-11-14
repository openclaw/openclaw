---
name: ios-e2e
description: iOS app on the simulator - build, run, pair with an isolated Gateway, drive the UI, screenshots, logs and crashes, focused tests, and end-to-end proof.
---

# iOS E2E

Work from the checkout root. A local `.mobilebuildmcp/config.yaml` ([Setup](#setup)) supplies the project, scheme and DerivedData, so `mobilebuildmcp` commands need no project flags.

Two values recur:

- `$sim`: the simulator UDID (`pnpm ios:sim:pair` prints one). Pass `--simulator-id "$sim"` to every `mobilebuildmcp` call; without it the config default targets the simulator named `iPhone 17`.
- `$bundle`: the bundle ID, which depends on the signing team. Read it from the build: `bundle=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/OpenClaw.app/Info.plist)`.

## Build and run

1. Build: `mobilebuildmcp simulator build`. After editing `apps/ios/project.yml`, run `pnpm ios:gen` first.
2. Install and launch with `simctl`, which takes launch arguments (`pnpm ios:run` takes none):

   ```sh
   xcrun simctl install "$sim" apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/OpenClaw.app
   xcrun simctl launch --terminate-running-process "$sim" "$bundle" --openclaw-reset-onboarding
   ```

   `mobilebuildmcp simulator build-and-run` and `launch-app` attach a log capture that never exits.

3. Debug launch arguments: `grep -rhoE '"--openclaw-[a-z-]+"' apps/ios/Sources | sort -u`. `--openclaw-screenshot-mode` plus an `--openclaw-*-fixture` flag shows a fixture screen without a Gateway; `-AppleLanguages "(de)" -AppleLocale de_DE` runs another language. The Debug URL scheme is `openclaw-debug://`.

## Drive the UI

1. `mobilebuildmcp ui-automation snapshot-ui --style minimal` lists tappable targets as `ref|action|role|label|value|id`. Text that is not a control (chat bubbles, row titles) appears only with `--output json`.
2. Act on a ref with `tap`, `type-text`, `long-press` (`--duration` is in milliseconds), `swipe` or `gesture`. Wait with `wait-for-ui`: `--predicate exists --label '…' --role button` for an element, `--predicate textContains --text '…'` for text. A wait selector that matches several elements fails; add `--role` or `--identifier`. Keep `--timeout-ms` under 30000: the daemon ends any request after 30 s with `DAEMON_TRANSPORT_FAILED`; repeat the wait for longer.
3. Refs belong to one snapshot; take a fresh one after every screen change.
4. See the screen: `mobilebuildmcp simulator screenshot`, then read the printed JPEG.

Gotchas:

- Onboarding and sheets also list the screens behind them; match by label or id and take the last match.
- On iPhone the sidebar overlays the content: tap `RootTabs.Sidebar.Show` before its rows.
- `xcrun simctl openurl` queues a system "Open in OpenClaw?" alert per call; tap `Open` or `Cancel` for each.
- System UI outside the app's process (photo picker, share sheet) is missing from snapshots. Tap it by coordinates with the AXe binary bundled in MobileBuildMCP: `"$(brew --prefix mobilebuildmcp)/libexec/bundled/axe" tap -x <x> -y <y> --udid "$sim"`. Coordinates are points: screenshot pixels × screen width in points ÷ screenshot width.

## Logs and crashes

Act first, then read a bounded window:

```sh
xcrun simctl spawn "$sim" log show --last 2m --style compact --predicate 'subsystem BEGINSWITH "ai.openclaw"'
```

Crashes land in `~/Library/Logs/DiagnosticReports/OpenClaw-*.ips`; the first `OpenClaw` frame of the `triggered` thread names the culprit. App preferences and databases live in the app container (`xcrun simctl get_app_container "$sim" "$bundle" data`); `simctl spawn … defaults read` cannot see them. LLDB and xctrace: [DEBUG.md](DEBUG.md).

## Tests

1. Run the touched suites: `pnpm ios:test <Suite>` (selectors and `IOS_SIM`: `apps/ios/README.md`).
2. Prove a regression test red on the base: commit the change, check out the base version of the changed source files (`git checkout <base> -- <paths>`), run the suite, then `git checkout HEAD -- <paths>`.

**Done:** the touched suites pass, and each new regression test fails on the base.

## Prove a change end to end

1. Start the isolated Gateway (one-time profile in [Setup](#setup)) as a long-running service: `node scripts/run-node.mjs --profile ios-sim gateway --bind loopback`. It never touches the operator's Gateway or `~/.openclaw`. While it runs, call the CLI as `node openclaw.mjs --profile ios-sim …`; `run-node` refuses to rebuild under a running Gateway.
2. Pair a fresh simulator through the real onboarding UI: `sim=$(pnpm --silent ios:sim:pair | tail -1)` (`--app` for another build, `--profile` for another profile).
3. Exercise the change through visible controls. A chat round trip: type into `chat-message-input`, tap `chat-send-message`, then wait for a word only the reply contains.
4. Compare builds: the same steps on `main` and on the change, each on its own fresh simulator, with matching screenshots.
5. Stop the Gateway and delete the simulators.

Node commands, permissions, auth failures, outages, rejected sends, upgrades and iPad layout: [PROOF.md](PROOF.md), which also lists what only a device proves. Chat scrolling, streaming, keyboard and relaunch stability (rows jumping, drifting or rebuilding), measured against a scripted model: [BEHAVIOR.md](BEHAVIOR.md).

**Done:** screenshots or recorded output show the behavior on the change and its absence on `main`; the Gateway port is closed and no `openclaw-pair-*` simulator remains.

## Setup

One-time per machine; each step ends on a check.

1. Xcode, simulator runtimes, `xcodegen` and the Watch Rust toolchain: `apps/ios/README.md` prerequisites. Check: `xcrun simctl list devices available` shows `iPhone 17`.
2. SwiftFormat and SwiftLint at the repo pin: `scripts/install-swift-tools.sh <dir on PATH>`. Check: `scripts/check-swift-tools.sh` exits 0.
3. MobileBuildMCP, Sentry's XcodeBuildMCP CLI: `brew tap getsentry/xcodebuildmcp && brew install getsentry/xcodebuildmcp/mobilebuildmcp`. These steps were written against 2.7.1. Check: `mobilebuildmcp --version`.
4. Checkout: `pnpm install --frozen-lockfile`, then `pnpm ios:gen` (the Xcode project is generated, not committed). Then create `.mobilebuildmcp/config.yaml` and add `/.mobilebuildmcp/` to `.git/info/exclude`:

   ```yaml
   schemaVersion: 1
   enabledWorkflows: [simulator, simulator-management, ui-automation, debugging]
   sentryDisabled: true
   sessionDefaults:
     projectPath: ./apps/ios/OpenClaw.xcodeproj
     scheme: OpenClaw
     configuration: Debug
     platform: iOS
     simulatorName: iPhone 17
     derivedDataPath: ./apps/ios/build/DerivedData # shared with pnpm ios:run
   ```

   Check: `mobilebuildmcp simulator list-schemes` lists `OpenClaw`, and `mobilebuildmcp simulator build` succeeds.

5. The `ios-sim` Gateway profile, with the Gateway stopped (`oc` = `node openclaw.mjs --profile ios-sim`): `oc config set gateway.mode local`, `oc config set gateway.port 19031`, `oc config set gateway.auth.mode token`, `oc config set gateway.auth.token "$(openssl rand -hex 24)"`. Chat replies need a model for its `main` agent: `oc models auth login` or `add` with test credentials. Check: the Gateway starts, and `pnpm ios:sim:pair` ends on the chat screen.
