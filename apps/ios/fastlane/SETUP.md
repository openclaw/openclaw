# fastlane setup (OpenClaw iOS)

Install the pinned Ruby bundle:

```bash
cd apps/ios
# Install Ruby 4.0.7 with mise or another .ruby-version-aware manager.
ruby --version
gem install bundler -v 4.0.22
bundle _4.0.22_ install
bundle _4.0.22_ check
```

The expected runtime is recorded in `apps/ios/.ruby-version`, and the Gemfile
enforces the same Ruby version. Fastlane and dependency checksums are pinned in
`apps/ios/Gemfile.lock`.

Repository commands use that bundle automatically:

```bash
pnpm ios:screenshots
pnpm ios:release:plan -- --json
pnpm ios:release:archive -- --version 2026.7.2 --revision 1 --build-number 3
```

An inherited `BUNDLE_GEMFILE` does not override the repository bundle.
Repository commands require `apps/ios/Gemfile` and fail if it is missing.
Restore a missing Gemfile from the repository checkout. If the locked bundle is
unavailable, run the setup commands above and retry.

Create an App Store Connect API key:

- App Store Connect → Users and Access → Keys → App Store Connect API → Generate API Key
- Download the `.p8`, note the **Issuer ID** and **Key ID**

Recommended (macOS): store the private key in Keychain and write non-secret vars:

```bash
scripts/ios-app-store-connect-keychain-setup.sh \
  --key-path /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --issuer-id YOUR_ISSUER_ID \
  --write-env
```

This writes these auth variables in `apps/ios/fastlane/.env`:

```bash
APP_STORE_CONNECT_KEY_ID=YOUR_KEY_ID
APP_STORE_CONNECT_ISSUER_ID=YOUR_ISSUER_ID
APP_STORE_CONNECT_KEYCHAIN_SERVICE=openclaw-app-store-connect-key
APP_STORE_CONNECT_KEYCHAIN_ACCOUNT=YOUR_MAC_USERNAME
```

Important: `apps/ios/fastlane/.env` is only for Fastlane/App Store Connect auth and optional release-archive settings. It does **not** configure gateway-side direct APNs push delivery for local iOS builds.

Optional app targeting variables (helpful if Fastlane cannot auto-resolve app by bundle):

```bash
APP_STORE_CONNECT_APP_IDENTIFIER=ai.openclawfoundation.app
# or
APP_STORE_CONNECT_APP_ID=YOUR_APP_STORE_CONNECT_APP_ID
```

File-based fallback (CI/non-macOS):

```bash
APP_STORE_CONNECT_KEY_ID=YOUR_KEY_ID
APP_STORE_CONNECT_ISSUER_ID=YOUR_ISSUER_ID
APP_STORE_CONNECT_KEY_PATH=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
```

Code signing variable (optional in `.env`):

```bash
IOS_DEVELOPMENT_TEAM=YOUR_TEAM_ID
```

Tip: run `scripts/ios-team-id.sh --require-canonical` from repo root to verify the official OpenClaw iOS team (`FWJYW4S8P8`) is available locally. Fastlane uses the same official-team-only path when `IOS_DEVELOPMENT_TEAM` is missing, and rejects other teams for release archives.

App Store release signing is manual and profile-pinned. The signing manifest is `apps/ios/Config/AppStoreSigning.json`, and Fastlane `match` owns the encrypted signing repo and branch named there.

One-time or rotation setup:

```bash
pnpm ios:release:signing:plan
pnpm ios:release:signing:check
pnpm ios:release:signing:setup
```

`signing:setup` uses Fastlane `produce` and `modify_services` to create Developer Portal bundle IDs and enable required services before running `match`. The main app also requires App Attest, and the main app and share extension both require the shared App Group from `apps/ios/Config/AppStoreSigning.json`; associate that group with both bundle IDs in the Apple Developer Portal before regenerating profiles. If Fastlane does not already have a valid Apple Developer Portal session, run `cd apps/ios && BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.22_ exec fastlane spaceauth` for a release-owner Apple ID and export the resulting `FASTLANE_SESSION`.

Shared encrypted signing storage:

```bash
MATCH_PASSWORD=... pnpm ios:release:signing:sync:push
MATCH_PASSWORD=... pnpm ios:release:signing:sync:pull
```

The signing repo is private and encrypted. Store `MATCH_PASSWORD` in the release-owner vault, not in this product repo. `sync:pull` uses Fastlane `match` to decrypt, install profiles, and import the distribution signing identity into the local Keychain.

For local/manual iOS builds that stay on direct APNs, configure the gateway host separately with `OPENCLAW_APNS_TEAM_ID`, `OPENCLAW_APNS_KEY_ID`, and either `OPENCLAW_APNS_PRIVATE_KEY_P8` or `OPENCLAW_APNS_PRIVATE_KEY_PATH`. Those gateway runtime env vars are separate from Fastlane's `.env`.

Validate auth:

```bash
cd apps/ios
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.22_ exec fastlane ios auth_check
```

App Store Connect API auth is required when:

- uploading to App Store Connect
- planning the App Store revision and next build from App Store Connect

If you pass `--build-number` to `pnpm ios:release:archive`, the local archive path does not need App Store Connect API auth.

Archive locally without upload:

```bash
pnpm ios:release:archive -- --version 2026.7.2 --revision 1 --build-number 3
```

Generate repeatable App Store screenshots:

```bash
pnpm ios:screenshots
```

The screenshot lane runs the app with `--openclaw-screenshot-mode`, which enters the built-in connected screenshot fixture instead of pairing with a live gateway. By default it chooses an available large iPhone model and a 13-inch iPad model from the installed Xcode runtime; override the model selection with a comma-separated `OPENCLAW_SNAPSHOT_DEVICES` value when the requested simulators exist locally.

The lane builds the UI-test products once, creates a fresh simulator for each selected model and runtime, and runs each screenshot in an independent `xcodebuild test-without-building` session against those products. It shuts down and deletes each owned simulator before creating the next, including the final Watch capture, and refuses to start while another simulator is running. Xcode command logs stay in `apps/ios/build/SnapshotLogs`; result bundles and the capture-attempt ledger stay in `apps/ios/build/SnapshotTestResults`. See [screenshot-only validation](../VERSIONING.md#screenshot-only-validation) for hosted branch runs and opt-in sanitized diagnostics.

Each screenshot gets one capture attempt. A failed capture or Xcode test result stops the lane, retaining its attempt record and any result bundle for diagnosis. CI rejects replacement captures as passing release evidence.

Screenshot tests disable Xcode's verbose failure diagnostics, such as sysdiagnose, while retaining command logs, screenshots, and per-attempt result bundles.

CI pins SimSlim 0.11.0 for the `ios-build` iPhone test simulator and the SimSlim
arms of [native release qualification](#native-release-qualification) compare mode.
It disables only search and family services, and preparation must succeed before
tests run. Screenshot capture, Watch, and default local runs use stock simulators.

From a clean local `main` matching `origin/main`, upload to App Store Connect:

```bash
pnpm ios:release:upload
```

The entry point plans the release, generates reviewed notes from changes since
the latest public build, and uploads the unchanged source SHA. It saves the
notes artifact without editing tracked files or creating commits. After Apple
processing it stages the saved notes and selects the build. Direct Fastlane
upload is disabled. Notes generation requires `OPENAI_API_KEY`.

## Native release qualification

On an Apple Silicon Mac with `/Applications/Xcode.app`, an available iOS simulator
runtime supporting iPhone 17 Pro and arm64, and the repository's pinned native tools installed:

```bash
node --import ./scripts/tsx.mjs scripts/ios-release-e2e.ts \
  --mode stock --target-sha "$(git rev-parse HEAD)" --output /tmp/ios-e2e-stock.json \
  --gateway-selection /tmp/ios-e2e-gateway-selection

./scripts/install-simslim.sh /tmp/ios-e2e-tools
OPENCLAW_CI_SIMSLIM_BINARY=/tmp/ios-e2e-tools/simslim \
  node --import ./scripts/tsx.mjs scripts/ios-release-e2e.ts \
  --mode compare --target-sha "$(git rev-parse HEAD)" --output /tmp/ios-e2e-compare.json \
  --gateway-selection /tmp/ios-e2e-gateway-selection
```

The gate requires a clean tracked and untracked source tree at the exact SHA;
gitignored build outputs are allowed. It selects the newest available iOS runtime
that supports the test device and architecture, and records that runtime in its proof.
It qualifies the candidate iOS app against the published stable Gateway selected
from npm's `latest` tag. The first invocation saves the exact Gateway version,
package integrity, dependency lock, source SHA, and Node/npm versions in the
selection directory. Later invocations using that directory validate and reuse
the saved selection without resolving `latest` again. Without `--gateway-selection`,
the directory defaults to the output path with `.gateway` appended. Keep it for
replay; use a new directory to select a newer stable Gateway. Selection replay
requires the same source SHA and Node/npm versions.

The harness installs the selected package in an isolated directory using the saved
dependency lock and builds ad-hoc-signed Debug `OpenClawUITests` simulator products
once. Ad-hoc signing preserves Keychain
entitlements without certificates or provisioning profiles; this is not a signed
Release build. Each arm starts an isolated real Gateway, then prepares its setup
handler and state worker with `device.pair.setupStatus` before booting one new
simulator. This status preparation prunes expired completion records without issuing
a credential. After boot, the same Gateway issues the fresh setup code consumed by
the app. The live test pairs a fresh install and
verifies the `first` and `second` message round trips. It then terminates and
relaunches the app, verifies the `relaunch` message on the restored connection,
and opens native Overview. Each message must reach the fixed-response local
`openai/ios-e2e` provider fixture as the latest user request.

The harness then stops the Gateway and provider fixture and runs the repeatable
keyboard/transcript reader test on the same simulator. Its first fixture send checks
that the transcript remains rendered above the open keyboard and follows the new
reply. Its second, multiline send checks keyboard dismissal, retained draft text,
reply anchoring, jumping to the latest reply, and returning after manual scrolling.
Control UI is disabled; this does not replace external-provider validation.

To reuse native products for another complete qualification at the same source and
toolchain, pass `--build-dir /absolute/path/to/ios-e2e-build` to both invocations.
The build owner verifies the source, toolchain, build arguments, and product integrity
before reuse. Each qualification still creates fresh simulator and Gateway resources.
The explicit build directory retains native products and their receipt; it does not
retain raw XCTest results.

For a narrower local diagnostic, use either:

```bash
# Prepare native products without starting a simulator or Gateway.
node --import ./scripts/tsx.mjs scripts/ios-release-e2e.ts \
  --mode stock --target-sha "$(git rev-parse HEAD)" \
  --build-dir /tmp/ios-e2e-build --build-only --output /tmp/ios-e2e-build.json

# Exercise Gateway startup, setup-status preparation, and code issuance without native resources.
node --import ./scripts/tsx.mjs scripts/ios-release-e2e.ts \
  --mode stock --target-sha "$(git rev-parse HEAD)" \
  --gateway-only --output /tmp/ios-e2e-gateway.json \
  --gateway-selection /tmp/ios-e2e-gateway-selection
```

These diagnostics produce `native-build`/`built` or `gateway-probe`/`probe-passed`
proofs, respectively. Neither is release qualification. The Gateway check uses the
same published-package selection and installation path as full qualification.

The stock gate runs for the `release` operation in **iOS Store Release** after
native tool setup and before signing assets are accessed. Manual and scheduled
TestFlight runs skip this gate. The gate qualifies the checked-out `main` commit used for release
preparation and records the installed Xcode version and build without requiring
a specific Xcode version. Manual CI also requires the stock gate when
`validation_tier=full` and its checkout revision equals the workflow run's SHA.
Main-tier and alternate-target manual runs retain their existing coverage.
Existing compatibility admission still excludes historical and
pinned-target CI paths; this does not claim universal pinned-target FRV coverage.
Local direct upload behavior is unchanged.

Manual dispatch of `iOS Release E2E` qualifies the selected workflow revision;
it does not accept an alternate target SHA. CI callers must also use their own
revision.

Each fresh workflow run resolves the stable Gateway once and saves
`selection.json`, `package.json`, and `package-lock.json` in the
`ios-release-gateway-selection-RUN_ID` artifact before native tool installation
and qualification. The artifact is retained for 30 days. All qualification arms
and reruns, including **Re-run all jobs**, reuse that run's selection. A missing,
expired, invalid, or source-mismatched selection stops a rerun; start a new
workflow run to make a fresh selection. No workflow input is needed. To replay
locally, download and extract that artifact and pass its directory with
`--gateway-selection` at the same source SHA and Node/npm versions.

Compare runs four serial matched pairs in stock/slim, slim/stock, stock/slim,
slim/stock order, for eight independently prepared arms. SimSlim keeps the existing
conservative search/family-only profile. A preparation or live-test failure stops
that arm before the reader test; a reader failure also fails the arm. Neither
failures nor skipped tests are retried or dropped. Cleanup runs once per arm,
and unconfirmed cleanup stops the run. JSON retains each attempted test's outcome
and duration, plus preparation, arm, build, and overall durations; the workflow
also records shared toolchain installation time.

Qualification tests disable Xcode's verbose failure diagnostics, such as sysdiagnose,
while retaining ordinary XCTest output, result inspection, and sanitized proof.

Both comparison arms sample `simslim measure --json` every second after boot and
preparation, through the test window only. The peak is the largest sampled
simulator-process-tree `phys_footprint`, not RSS, whole-host memory, a continuous
peak, or reboot-preparation memory. Missing/invalid samples or gaps over three
seconds fail measurement. A stock gate without the meter requires no measurements.
Raw XCTest bundles and fixture logs stay private and are cleaned with owned
resources. If owned cleanup cannot be confirmed, the working root is retained.
Alongside the Gateway selection artifact, sanitized JSON proof is uploaded,
including on failure, as `ios-release-e2e-MODE-RUN_ID-RUN_ATTEMPT`. It records
the candidate source and selected Gateway identities, fixed operation labels,
phase durations, setup RPC progress, and bounded exit/error diagnostics.
Raw logs and setup codes are excluded. Setup-code timeouts are preparation failures
and prevent native test execution.

## Temporary resource investigation

Qualification, screenshot-only runs, CI screenshot capture, and store/TestFlight uploads collect a
bounded `ios-resource-timeline.jsonl` while their main command runs. This temporary
instrumentation investigates runner contention; it does not change test deadlines,
simulator services, build parallelism, or release admission.

The collector takes one serial sample approximately every 15 seconds. It records
host CPU counters, load, memory compression and swap activity, memory-pressure
level, disk activity, and at most twelve top CPU/RSS process rows. Process rows
contain PIDs, parent PIDs and roles, state, CPU time, and RSS. Roles use a fixed
allowlist plus bounded executable basenames from installed Apple simulator runtime
system directories. Device data, app bundles, containers, and other unknown names
remain `other`. Fixed origin categories distinguish runtime, Xcode,
and host-system executable locations where recognizable. Grouped counts and CPU
deltas cover every parsed process, including rows outside the top-process display.
`cpuObservedCount` identifies rows with a previous observation; a missing `ps`
probe leaves the summary null and resets that baseline. It never exports arguments, environment values, paths, or application
content. Fixed phase labels correlate samples with builds, simulator startup,
Gateway preparation, native tests, screenshots, archiving, and upload.

Each native observation requests termination after two seconds. A starved runner
can delay process termination and output closure beyond that deadline. Samples
record their start/end timestamps and phases plus each probe's elapsed wall time;
slow samples can span phases and must not be treated as instantaneous snapshots.
Collection is independent of the workload, never overlaps or catches up after a
slow sample, and stops at a 4 MiB output limit. Missing observations remain
diagnostics, not release failures.
The footer records collector Node CPU time and RSS; native observation subprocess
CPU is excluded. RSS is not physical memory footprint, CPU deltas miss processes
that start and exit between samples, and sparse sampling cannot establish a
continuous peak. Interpret memory pressure and swap activity alongside free memory.

The timeline is retained with the qualification proof or screenshot diagnostics,
including after failures. Store runs also preserve the existing sanitized screenshot
phase/startup/crash JSON before their temporary source checkout is removed.
Screenshot phases do not run synchronous resource probes; the background timeline
is the sole resource sampler. CI retains it alongside `screenshot-diagnostics.json`
in the existing screenshot diagnostics artifact.
Xcode build timing summaries appear in screenshot/archive logs; qualification
exports recognized task totals as `buildTimings` in its proof. Task totals can
overlap and must not be summed as wall time.

For a non-publishing comparison on one fixed candidate branch:

```bash
gh workflow run ios-release-e2e.yml --ref YOUR_BRANCH -f mode=stock -f resource_diagnostics=false
gh workflow run ios-release-e2e.yml --ref YOUR_BRANCH -f mode=stock -f resource_diagnostics=true
gh workflow run ios-store-release.yml --ref YOUR_BRANCH -f operation=screenshots -f resource_diagnostics=true
gh workflow run ios-store-release.yml --ref YOUR_BRANCH -f operation=screenshots -f resource_diagnostics=false
```

Wait for each arm of the same flow to finish before starting the next. Keep source,
Gateway selection, runner resources, Xcode, and simulator runtime matched; a single
pair checks integration, not a reliable performance percentile. The switch only
affects non-publishing dispatches. Real store/TestFlight operations keep collection
enabled. Locally the same wrapper accepts `OPENCLAW_IOS_RESOURCE_DIAGNOSTICS=0`:

```bash
node scripts/ios-resource-timeline.mjs --output /tmp/ios-resource-timeline.jsonl -- pnpm ios:screenshots
```

To distinguish simulator startup from OpenClaw and XCTest, the temporary startup
probe captures only iPhone screenshots. It observes 60 seconds after the build with
no simulator active, then 120 seconds after boot before app installation or tests:

```bash
gh workflow run ios-store-release.yml --ref YOUR_BRANCH -f operation=screenshots -f startup_probe=true
```

The probe enables the resource timeline even if `resource_diagnostics` is false.
After simulator cleanup, it also runs a bounded Spotlight experiment: five
interleaved pairs copy the built products into fresh ordinary and `.noindex`
directories, observing each for 45 seconds. `ios-spotlight-probe.json` retains
aggregate file/index counts, matched Spotlight CPU deltas, timing, and host load.
Only task-owned copies are removed; machine-wide indexing settings are unchanged.
Missing ordinary-directory positive controls make the result inconclusive. These
fresh-directory observations do not measure cold-host or release performance.

It is off by default and only configured by the screenshot job. These added waits
are diagnostic observations, not a performance improvement; include them in any
end-to-end comparison. Grouped process CPU is still a lower bound: newly observed
and short-lived processes have no measured delta. Roles and origin categories
can remain `other`; they are attribution hints, not a complete process inventory.

Remove the collector, phase markers, and comparison switches after the contention
cause and its improvement are verified. Do not make full Instruments recordings,
allocation tracing, or automatic sysdiagnose part of normal release runs.

## GitHub Actions

Run **iOS Store Release** from `main` with one of these operations:

| Operation | Environment | Outcome |
| --- | --- | --- |
| `release` (default) | `ios-store-release` | Upload screenshots, the App Review attachment, and the IPA; stage saved notes and select the processed build for manual App Review. |
| `testflight` | `ios-testflight` | Upload the IPA, assign the external group, and submit for TestFlight review when required; automatically notify testers after approval. |
| `screenshots` | None | Capture screenshots without signing or upload; candidate branches are allowed. |

Both upload operations use `pnpm ios:release:upload`, the pinned build tools,
readonly encrypted signing assets, a job-owned temporary keychain, and the shared
`ios-release` concurrency lock. TestFlight does not stage the App Store listing.
For a failure after upload, use [staging recovery](../VERSIONING.md#staging-recovery)
with the saved destination; do not repeat the upload.

The `release` path also runs every Monday at 11:00 AM Pacific, with native
qualification and the same store environment. Weekly runs send Discord results;
manual operations do not. See [weekly mobile releases](https://docs.openclaw.ai/ci/scheduled-workflows#weekly-mobile-store-releases)
for webhook setup and scheduling behavior.

Create `ios-testflight` as a GitHub environment restricted to `main` with no
required reviewers, and make the secrets below available to it. Keep the
`ios-store-release` environment's existing approval policy.

Set `OPENCLAW_TESTFLIGHT_GROUP_ID` as an `ios-testflight` environment variable to
the existing **External Testing** group's App Store Connect ID. Populate the
app's required TestFlight beta metadata in App Store Connect before the first
run, including feedback email, review contact, and reviewer access instructions.
The pipeline validates these values and never copies or stages App Store listing
metadata for a TestFlight run.

Daily TestFlight runs are scheduled at **7:00 AM America/Los_Angeles**, with
daylight saving time handled by GitHub. Initially leave the repository variable
`IOS_TESTFLIGHT_ENABLED` unset or `false`. Run one manual distribution:

```bash
gh workflow run ios-store-release.yml --ref main -f operation=testflight
```

Inspect `testflight-result.json` in the recovery artifact and the matching build
and group in App Store Connect. Once the manual flow is verified, set repository
variable `IOS_TESTFLIGHT_ENABLED` to `true` to enable daily TestFlight runs. Manual
TestFlight dispatch is available regardless of that activation variable. Set it
back to `false` to stop daily TestFlight jobs without disabling weekly or manual releases.

Repository/environment secrets required by name:

- `GH_APP_PRIVATE_KEY`
- `OPENAI_API_KEY`
- `MATCH_PASSWORD`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_KEY_CONTENT`

App Store Connect supplies the revision and next build number. The TestFlight
destination requires the external group variable; App Store staging does not.
Neither destination requires a prepared mobile release branch.

Local authentication setup for a fresh clone on the same Mac:

1. Reuse the existing Keychain-backed App Store Connect key on that machine.
2. Restore or recreate `apps/ios/fastlane/.env` so it contains the non-secret variables:

```bash
APP_STORE_CONNECT_KEY_ID=YOUR_KEY_ID
APP_STORE_CONNECT_ISSUER_ID=YOUR_ISSUER_ID
APP_STORE_CONNECT_KEYCHAIN_SERVICE=openclaw-app-store-connect-key
APP_STORE_CONNECT_KEYCHAIN_ACCOUNT=YOUR_MAC_USERNAME
```

3. Re-run auth validation:

```bash
cd apps/ios
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.22_ exec fastlane ios auth_check
```

4. Inspect the live plan if needed, then run the release entry point:

```bash
pnpm ios:release:plan -- --json
pnpm ios:release:upload
```

Quick verification after upload:

- confirm the exported IPA exists under `artifacts/` in the printed recovery directory
- confirm Fastlane validates the exported IPA before upload
- confirm Fastlane prints `Uploaded iOS App Store build: version=<version> short=<short> build=<build>`
- submit the processed build for App Review manually in App Store Connect

Versioning rules:

- App Store release uploads derive the gateway from root `package.json` and revision/build state from App Store Connect
- The planner accepts checked `--version`, `--revision`, and `--build-number` overrides; no release arguments are required
- Store notes come from the saved, reviewed Git-history artifact; `apps/ios/CHANGELOG.md` remains historical documentation
- Gateway versions use CalVer: `YYYY.M.PATCH`
- Fastlane appends one unpadded revision digit: gateway `YYYY.M.PATCH`, revision `R`, becomes `YYYY.M.PATCHR`
- Gateway `2026.7.2`, revision `1` sets `CFBundleShortVersionString` to `2026.7.21`
- Fastlane resolves `CFBundleVersion` from the maximum awaiting, processing, failed, or complete build-upload record plus one
- The notes baseline is the build attached to the latest public App Store version, independent of later TestFlight uploads
- `pnpm ios:version:check` validates version inputs without requiring changelog notes
- The release flow regenerates `apps/ios/OpenClaw.xcodeproj` from `apps/ios/project.yml` before archiving
- Local App Store signing uses a temporary generated xcconfig with profile names from `apps/ios/Config/AppStoreSigning.json` and leaves local development signing overrides untouched
- App Store release uses `OpenClawPushMode=appStore`, which derives the official production hosted relay, production APNs, production relay profile, and `appleStrict` proof. The release lane rejects custom production relay URL overrides.
- The exported IPA is validated before upload by inspecting its push mode, signed entitlements, and embedded App Store profile.
- The default `pnpm ios:release:upload` destination stages screenshots and the App Review PDF attachment before uploading the IPA, waits for processing, then stages saved notes and selects the build. It does not submit for App Review or upload the App Store Connect `Notes` field
- Screenshot processing allows two replacement rounds, ten minutes apart, for assets stuck in `UPLOAD_COMPLETE`. Completed screenshots are preserved, and the final set must match the local files in count, order, and checksum. Replacements do not reset the existing one-hour processing deadline (`DELIVER_SCREENSHOT_PROCESSING_TIMEOUT` overrides that total budget). Explicit processing failures and upload or deletion errors stop the release.
- See `apps/ios/VERSIONING.md` for the detailed workflow
