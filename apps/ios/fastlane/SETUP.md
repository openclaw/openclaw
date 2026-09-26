# fastlane setup (OpenClaw iOS)

Install the pinned Ruby bundle:

```bash
cd apps/ios
# Install Ruby 3.4.10 with mise or another .ruby-version-aware manager.
ruby --version
gem install bundler -v 4.0.21
bundle _4.0.21_ install
bundle _4.0.21_ check
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

Tip: run `scripts/ios-team-id.sh --require-canonical` from repo root to verify the canonical OpenClaw iOS team (`FWJYW4S8P8`) is available locally. Fastlane uses the same canonical-only path when `IOS_DEVELOPMENT_TEAM` is missing, and rejects non-canonical teams for release archives.

App Store release signing is manual and profile-pinned. The canonical manifest is `apps/ios/Config/AppStoreSigning.json`, and Fastlane `match` owns the encrypted signing repo and branch named there.

One-time or rotation setup:

```bash
pnpm ios:release:signing:plan
pnpm ios:release:signing:check
pnpm ios:release:signing:setup
```

`signing:setup` uses Fastlane `produce` and `modify_services` to create Developer Portal bundle IDs and enable required services before running `match`. The main app also requires App Attest, and the main app and share extension both require the shared App Group from `apps/ios/Config/AppStoreSigning.json`; associate that group with both bundle IDs in the Apple Developer Portal before regenerating profiles. If Fastlane does not already have a valid Apple Developer Portal session, run `cd apps/ios && BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane spaceauth` for a release-owner Apple ID and export the resulting `FASTLANE_SESSION`.

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
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane ios auth_check
```

App Store Connect API auth is required when:

- uploading to App Store Connect
- planning the App Store revision and next build from App Store Connect

If you pass `--build-number` to `pnpm ios:release:archive`, the local archive path does not need App Store Connect API auth.

Archive locally without upload:

```bash
pnpm ios:release:archive -- --version 2026.7.2 --revision 1 --build-number 3
```

Generate deterministic App Store screenshots:

```bash
pnpm ios:screenshots
```

The screenshot lane runs the app with `--openclaw-screenshot-mode`, which enters the built-in connected screenshot fixture instead of pairing with a live gateway. By default it chooses one available large iPhone simulator and one available 13-inch iPad simulator from the installed Xcode runtime; override devices with a comma-separated `OPENCLAW_SNAPSHOT_DEVICES` value when the requested simulators exist locally.

The lane builds the UI-test products once, boots each selected simulator once, and runs each screenshot in an independent `xcodebuild test-without-building` session against those products. This avoids repeated Fastlane build-settings discovery and simulator reboots between captures. Xcode command logs stay in `apps/ios/build/SnapshotLogs`; result bundles and the capture-attempt ledger stay in `apps/ios/build/SnapshotTestResults`.

Each screenshot gets one capture attempt. A failed capture or Xcode test result stops the lane, retaining its attempt record and any result bundle for diagnosis. CI rejects replacement captures as passing release evidence.

CI pins SimSlim 0.8.0 for the selected iPhone test simulator and iPhone/iPad
screenshot devices. It disables only search and family services. Preparation
must succeed before capture; Watch and default local runs remain stock.

From a clean local `main` matching `origin/main`, upload to App Store Connect:

```bash
pnpm ios:release:upload
```

The entry point plans and cuts iOS release notes automatically, commits changed
notes locally for clean build provenance, and uploads the prepared commit.
After success it opens a metadata-only PR for squash auto-merge under the
existing `main` gates. The uploaded source SHA remains immutable. Failed uploads
leave `main` unchanged. Direct Fastlane upload is disabled.

## Native release qualification

On an Apple Silicon Mac with `/Applications/Xcode.app`, the iOS 26.5 runtime, iPhone 17 Pro
device type, and the repository's pinned native tools installed:

```bash
node --import ./scripts/tsx.mjs scripts/ios-release-e2e.ts \
  --mode stock --target-sha "$(git rev-parse HEAD)" --output /tmp/ios-e2e-stock.json

./scripts/install-simslim.sh /tmp/ios-e2e-tools
OPENCLAW_CI_SIMSLIM_BINARY=/tmp/ios-e2e-tools/simslim \
  node --import ./scripts/tsx.mjs scripts/ios-release-e2e.ts \
  --mode compare --target-sha "$(git rev-parse HEAD)" --output /tmp/ios-e2e-compare.json
```

The gate requires a clean tracked and untracked source tree at the exact SHA;
gitignored build outputs are allowed. It builds the Gateway runtime and ad-hoc-signed
Debug `OpenClawUITests` simulator products once. Ad-hoc signing preserves Keychain
entitlements without certificates or provisioning profiles; this is not a signed
Release build. Each of the two live Gateway UI tests gets a new simulator, isolated real
Gateway, and fresh setup code. Chat uses the deterministic local
`openai/ios-e2e` provider fixture. Native Overview runs with Control UI disabled;
this is not screenshot mode or a substitute for external-provider validation.

The stock gate runs in **iOS Release** after native tool setup and before signing
assets are accessed. It qualifies the checked-out `main` commit used for release
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

Compare runs four serial matched pairs in stock/slim, slim/stock, stock/slim,
slim/stock order, with both tests fresh in every arm. SimSlim keeps the existing
conservative search/family-only profile. Neither failures nor skipped tests are
retried or dropped. JSON reports preparation, test, arm, build, and overall
durations; the workflow additionally records shared toolchain installation time.

Both comparison arms sample `simslim measure --json` every second after boot and
preparation, through the test window only. The peak is the largest sampled
simulator-process-tree `phys_footprint`, not RSS, whole-host memory, a continuous
peak, or reboot-preparation memory. Missing/invalid samples or gaps over three
seconds fail measurement. A stock gate without the meter requires no measurements.
Raw XCTest bundles and fixture logs stay private and are cleaned with owned
resources. If owned cleanup cannot be confirmed, the working root is retained.
Only sanitized JSON proof is uploaded, including on failure, with fixed operation
labels and bounded exit/error diagnostics rather than raw logs or setup codes.

## GitHub Actions

Run **iOS Release** from `main` using the `ios-store-release` environment for
upload and Git finalization. The workflow has no input parameters and uses
the same `pnpm ios:release:upload` entry point. It installs the pinned build
tools, uses readonly encrypted signing assets and a job-owned temporary
keychain, and uploads screenshots, release notes, the App Review PDF attachment,
and the IPA. A separate finalization job opens the metadata PR and waits for
squash merging. App Review submission remains manual. If only finalization
fails, rerun that job or use the
[shared recovery commands](../VERSIONING.md#git-finalization-and-recovery); do not repeat the upload.

Repository/environment secrets required by name:

- `GH_APP_PRIVATE_KEY`
- `MATCH_PASSWORD`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_KEY_CONTENT`

App Store Connect supplies the revision and next build number. No TestFlight
group ID or manually prepared mobile release branch is required.

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
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane ios auth_check
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
- `apps/ios/CHANGELOG.md` is the iOS-only changelog and release-note source
- Gateway versions use CalVer: `YYYY.M.PATCH`
- Fastlane appends one unpadded revision digit: gateway `YYYY.M.PATCH`, revision `R`, becomes `YYYY.M.PATCHR`
- Gateway `2026.7.2`, revision `1` sets `CFBundleShortVersionString` to `2026.7.21`
- Fastlane resolves `CFBundleVersion` from the maximum awaiting, processing, failed, or complete build-upload record plus one
- The release entry point runs `pnpm ios:release:cut` automatically and persists the exact encoded heading only after upload succeeds
- `pnpm ios:version:check` validates that release notes can be generated from the iOS changelog
- The release flow regenerates `apps/ios/OpenClaw.xcodeproj` from `apps/ios/project.yml` before archiving
- Local App Store signing uses a temporary generated xcconfig with profile names from `apps/ios/Config/AppStoreSigning.json` and leaves local development signing overrides untouched
- App Store release uses `OpenClawPushMode=appStore`, which derives the canonical production hosted relay, production APNs, production relay profile, and `appleStrict` proof. The release lane rejects custom production relay URL overrides.
- The exported IPA is validated before upload by inspecting its push mode, signed entitlements, and embedded App Store profile.
- `pnpm ios:release:upload` generates and uploads screenshots, release notes, and the App Review PDF attachment before uploading the IPA, waits for build processing, and does not submit for App Review or upload the App Store Connect `Notes` field
- See `apps/ios/VERSIONING.md` for the detailed workflow
