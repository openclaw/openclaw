# fastlane setup (OpenClaw iOS)

Install:

```bash
brew install fastlane
```

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

`signing:setup` uses Fastlane `produce` and `modify_services` to create Developer Portal bundle IDs and enable required services before running `match`. The main app also requires App Attest, and the main app and share extension both require the shared App Group from `apps/ios/Config/AppStoreSigning.json`; associate that group with both bundle IDs in the Apple Developer Portal before regenerating profiles. If Fastlane does not already have a valid Apple Developer Portal session, run `fastlane spaceauth` for a release-owner Apple ID and export the resulting `FASTLANE_SESSION`.

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
fastlane ios auth_check
```

App Store Connect API auth is required when:

- uploading to App Store Connect
- auto-resolving the next build number from App Store Connect

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
pnpm ios:release:upload -- --version 2026.7.2 --revision 1
```

Direct Fastlane upload is disabled. Use the package script so the release
wrapper, App Store push mode, and exported-IPA validation gate all run in the
same path.

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
fastlane ios auth_check
```

4. For a new App Store revision, add an exact encoded-version changelog section and validate it:

```bash
pnpm ios:version:check -- --version 2026.7.2 --revision 1
```

5. Upload:

```bash
pnpm ios:release:upload -- --version 2026.7.2 --revision 1 --build-number 3
```

Quick verification after upload:

- confirm `apps/ios/build/app-store/OpenClaw-<version>.ipa` exists
- confirm Fastlane validates the exported IPA before upload
- confirm Fastlane prints `Uploaded iOS App Store build: version=<version> short=<short> build=<build>`
- remember that App Store Connect processing can take a few minutes after the upload succeeds

Versioning rules:

- App Store release uploads require an explicit gateway `--version` and App Store `--revision`
- local defaults derive from root `package.json`
- `apps/ios/CHANGELOG.md` is the iOS-only changelog and release-note source
- Gateway versions use CalVer: `YYYY.M.D`
- Fastlane derives the App Store version as `YYYY.M.(D * 100 + revision)`
- Gateway `2026.7.2`, revision `1` sets `CFBundleShortVersionString` to `2026.7.201`
- Fastlane resolves `CFBundleVersion` as the next integer build for that exact App Store version
- Run `pnpm ios:version:check -- --version <gateway-version> --revision <revision>` after changing `apps/ios/CHANGELOG.md`
- `pnpm ios:version:check` validates that release notes can be generated from the iOS changelog
- The release flow regenerates `apps/ios/OpenClaw.xcodeproj` from `apps/ios/project.yml` before archiving
- Local App Store signing uses a temporary generated xcconfig with profile names from `apps/ios/Config/AppStoreSigning.json` and leaves local development signing overrides untouched
- App Store release uses `OpenClawPushMode=appStore`, which derives the canonical production hosted relay, production APNs, production relay profile, and `appleStrict` proof. The release lane rejects custom production relay URL overrides.
- The exported IPA is validated before upload by inspecting its push mode, signed entitlements, and embedded App Store profile.
- `pnpm ios:release:upload` generates and uploads screenshots, release notes, and the App Review PDF attachment before archiving, then uploads the IPA without submitting it for App Review or uploading the App Store Connect `Notes` field
- See `apps/ios/VERSIONING.md` for the detailed workflow
