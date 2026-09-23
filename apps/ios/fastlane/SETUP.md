# fastlane setup (OpenClaw iOS)

Install the pinned Ruby bundle:

```bash
cd apps/ios
# Install Ruby 3.4.10 with mise or another .ruby-version-aware manager.
ruby --version
gem install bundler -v 2.6.9
bundle _2.6.9_ install
bundle _2.6.9_ check
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

`signing:setup` uses Fastlane `produce` and `modify_services` to create Developer Portal bundle IDs and enable required services before running `match`. The main app also requires App Attest, and the main app and share extension both require the shared App Group from `apps/ios/Config/AppStoreSigning.json`; associate that group with both bundle IDs in the Apple Developer Portal before regenerating profiles. If Fastlane does not already have a valid Apple Developer Portal session, run `cd apps/ios && BUNDLE_GEMFILE="$PWD/Gemfile" bundle _2.6.9_ exec fastlane spaceauth` for a release-owner Apple ID and export the resulting `FASTLANE_SESSION`.

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
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _2.6.9_ exec fastlane ios auth_check
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

Upload to App Store Connect:

```bash
node --import tsx scripts/mobile-release-version.ts --prepare --version 2026.8.2 --write
pnpm ios:release:plan -- --json > /tmp/ios-release-plan.json
node --import tsx scripts/mobile-release-version.ts --finalize --version 2026.8.2 --plan /tmp/ios-release-plan.json --write
# Review all five cutter outputs and commit every changed output.
pnpm ios:release:upload
```

Direct Fastlane upload is disabled. Use the package script so the release
wrapper, App Store push mode, and exported-IPA validation gate all run in the
same path.

## Protected beta CI

`iOS Beta Release` is a separate, manual workflow. Dispatch it from trusted
`main` with a canonical `release/YYYY.M.PATCH-mobile` branch and that branch's
exact full commit SHA. The workflow derives the frozen Code SHA from the release
branch and the dispatch's trusted Tooling SHA. That Tooling SHA must be an
ancestor of the observed `main` head, and `main` may only advance forward while
authority validates the candidate. Divergence, rewind, or an unstable ancestry
lookup fails closed. Every later candidate commit must be linear and may change
only the five generated mobile release metadata files. All five target files
must byte-match regeneration using the dispatch's trusted tooling and the frozen
Code SHA metadata. Approval of the `ios-beta-release` environment
gates all access to signing assets, App Store Connect credentials, and immutable
release-ref mutation.

Repository/environment secrets required by name:

- `GH_APP_PRIVATE_KEY`
- `MATCH_PASSWORD`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_KEY_CONTENT`

Protected `ios-beta-release` environment variable required:

- `TESTFLIGHT_INTERNAL_GROUP`: immutable App Store Connect beta-group ID

The CI lane must distribute the processed build to one pre-approved internal
TestFlight group. The value is ID-only and is never matched as a display name.
The lane fails before upload when the ID is blank, unknown, external, duplicated,
collides with another group's display name, or any other internal group does not
explicitly disable automatic all-build access. After processing, it freshly
resolves the exact group and uploaded build, then requires that build ID to be
assigned only to the approved group. Existing access is reconciled without
reassigning the build. An automatic target group must expose the exact build in
its live relationships; its all-build flag alone is not distribution proof. A
missing relationship permits one assignment only for a freshly validated manual
group. Unexpected access or unreadable state fails closed before assignment,
and successful reconciliation still requires fresh exclusive-access readback.
External distribution and Beta App Review submission remain disabled.

After verified internal distribution, the workflow writes a bounded signed
intent and records `refs/openclaw/mobile-releases/ios/<app-store-version>-<build>`
at the exact candidate SHA. A failed post-upload recording step may be recovered
with the workflow's `record-only` operation, the original failed run ID, and the
same release ref/SHA tuple. Recovery enters `ios-beta-release`, executes only
trusted workflow-SHA tooling, and admits the recovery dispatch against the
current `main` lineage. Candidate regeneration, receipts, and attestations remain
bound to the original upload run's Tooling SHA. Recovery fails on missing
artifacts, replay, moved refs, mismatched digests, divergent or rewound `main`,
or a conflicting immutable ref. App Review and production promotion remain
manual.

### Read-only protected inspection

After review and landing, dispatch `iOS Beta Release` from `main` with
`operation=inspect`, the approved `target_ref` and exact `target_sha`, and
`inspect_build_number` for the existing build. The App Store version comes from
that candidate's validated cutter output, not a free-form version override.
A fresh `ios-beta-release` environment approval is required. Inspection shares
the uploader's concurrency group and revalidates the live actor, original run
attempt, trusted workflow lineage, and unchanged candidate before credential
access and again before retaining observations.

Only the trusted workflow-SHA checkout executes Node, Fastlane 2.240.1, and
locked dependencies. The candidate checkout supplies version/changelog data;
none of its scripts, Fastfile, Gemfile, or actions execute. The canonical planner
runs against this data without a forced revision/build override. Its `plan.json`
selects the next live upload, not the historical build being inspected. A failed
planner produces no plan; `inspection.json` records `planValidation=failed`.

The separate `ios-release-inspection-<run>-1` artifact retains only the plan,
selected app/build IDs, group IDs/policy flags/exact build relationships, and
validation outcomes for seven days. It contains no tester lists, emails, group
names, signing data, intent, or authority receipt. Relationship API failures stop
inspection; planner failures produce no plan. Unsafe or missing relationships
are reported without repair. These are sequential observations, not an atomic
store snapshot. Even a successful
inspection always says `publicationVerified=false`: current relationships do
not prove historical upload provenance or authorize recording. The upload and
`record-only` contracts are unchanged, including rejection of a missing original
intent. No automatic-access toggle, group assignment, signing, screenshot,
archive, upload, App Review submission, or release-ref mutation runs here.

A green inspection job means observations were captured, not that its plan or
distribution passed. Review the report's plan and policy outcomes before making
a separate source, recovery-contract, audience, or publication decision. This
operation neither changes the selected source nor authorizes any such decision.

Maintainer recovery path for a fresh clone on the same Mac:

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
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _2.6.9_ exec fastlane ios auth_check
```

4. Prepare and finalize the shared mobile release:

```bash
node --import tsx scripts/mobile-release-version.ts --prepare --version 2026.8.2 --write
pnpm ios:release:plan -- --json > /tmp/ios-release-plan.json
node --import tsx scripts/mobile-release-version.ts --finalize --version 2026.8.2 --plan /tmp/ios-release-plan.json --write
```

5. Review all five cutter outputs, commit every changed output, then upload:

```bash
pnpm ios:release:upload
```

Quick verification after upload:

- confirm `apps/ios/build/app-store/OpenClaw-<version>.ipa` exists
- confirm Fastlane validates the exported IPA before upload
- confirm Fastlane prints `Uploaded iOS App Store build: version=<version> short=<short> build=<build>`
- remember that App Store Connect processing can take a few minutes after the upload succeeds

Versioning rules:

- App Store release uploads derive the gateway from `apps/mobile/version.json` and revision/build state from App Store Connect
- explicit `--version`, `--revision`, and `--build-number` values are checked overrides
- `apps/ios/CHANGELOG.md` is the iOS-only changelog and release-note source
- Gateway versions use CalVer: `YYYY.M.PATCH`
- Fastlane appends one unpadded revision digit: gateway `YYYY.M.PATCH`, revision `R`, becomes `YYYY.M.PATCHR`
- Gateway `2026.7.2`, revision `1` sets `CFBundleShortVersionString` to `2026.7.21`
- Fastlane resolves `CFBundleVersion` from the maximum awaiting, processing, failed, or complete build-upload record plus one
- Run the shared mobile cutter prepare/plan/finalize flow after changing `## Unreleased`, then review all five outputs and commit every changed output
- `pnpm ios:version:check` validates that release notes can be generated from the iOS changelog
- The release flow regenerates `apps/ios/OpenClaw.xcodeproj` from `apps/ios/project.yml` before archiving
- Local App Store signing uses a temporary generated xcconfig with profile names from `apps/ios/Config/AppStoreSigning.json` and leaves local development signing overrides untouched
- App Store release uses `OpenClawPushMode=appStore`, which derives the canonical production hosted relay, production APNs, production relay profile, and `appleStrict` proof. The release lane rejects custom production relay URL overrides.
- The exported IPA is validated before upload by inspecting its push mode, signed entitlements, and embedded App Store profile.
- `pnpm ios:release:upload` generates and uploads screenshots, release notes, and the App Review PDF attachment before uploading the IPA, waits for build processing, and does not submit for App Review or upload the App Store Connect `Notes` field
- See `apps/ios/VERSIONING.md` for the detailed workflow
