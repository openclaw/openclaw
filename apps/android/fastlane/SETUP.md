# fastlane setup (OpenClaw Android)

For the standard local setup:

```bash
brew install fastlane
```

For a checksum-locked, reproducible setup:

```bash
cd apps/android
gem install bundler -v 4.0.21
bundle _4.0.21_ install
```

The expected reproducible runtime is recorded in `apps/android/.ruby-version`.
Fastlane and its transitive dependencies are checksum-locked in
`apps/android/Gemfile.lock`. Android release wrappers prefer that bundle when
it is installed. Normal local commands otherwise retain the direct Homebrew
Fastlane and rbenv fallbacks.

Create a Google Play service account JSON key with Google Play Developer API access, then grant that service account access to the OpenClaw app in Play Console.

Recommended local auth:

```bash
GOOGLE_PLAY_JSON_KEY=/absolute/path/to/google-play-service-account.json
```

Optional app targeting:

```bash
GOOGLE_PLAY_PACKAGE_NAME=ai.openclaw.app
```

Android release signing uses the same private `apps-signing` repository and `MATCH_PASSWORD` secret as iOS, but with Android-specific encrypted assets. Pull the shared upload key before release validation:

```bash
pnpm android:release:signing:plan
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:sync:pull
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:check
```

The pull command materializes decrypted signing files under `apps/android/build/release-signing/`, which is gitignored. Later Fastlane release commands reload those materialized values and export them to Gradle for the current process.

For the first setup or rotation, provide the Play upload keystore and a local signing properties file, then push encrypted assets to `apps-signing`:

```bash
MATCH_PASSWORD=<signing repo password> \
OPENCLAW_ANDROID_UPLOAD_KEYSTORE=<path-to-upload-keystore.jks> \
OPENCLAW_ANDROID_SIGNING_PROPERTIES=<path-to-android-signing.properties> \
pnpm android:release:signing:sync:push
```

The source signing properties file must contain:

```properties
OPENCLAW_ANDROID_STORE_PASSWORD=<store-password>
OPENCLAW_ANDROID_KEY_ALIAS=<upload-key-alias>
OPENCLAW_ANDROID_KEY_PASSWORD=<key-password>
```

Store the Google Play upload key, not the irreplaceable app signing key, when Play App Signing is enabled.

Validate auth:

```bash
cd apps/android
fastlane android auth_check
```

Use `BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane android auth_check`
when reproducing the protected CI toolchain exactly.

Archive locally without upload:

```bash
pnpm android:release:archive
```

This command is for local archive validation only. It is not a fallback upload
path after `pnpm android:release:upload` fails.

Generate deterministic phone and Wear OS Google Play screenshots:

```bash
pnpm android:screenshots
```

The script creates and boots retained Pixel 2 and Wear OS Large Round AVDs when
needed. Install `system-images;android-36;google_apis;<abi>` and
`system-images;android-34;android-wear;<abi>` first. Use
`--form-factor phone|wear` with `--avd <name>` or `--device <adb-serial>` to
capture one form factor from an explicitly selected emulator.

From a clean local `main` matching `origin/main`, prepare and upload the phone
and Wear bundles, metadata, and screenshots:

```bash
pnpm android:release:upload
```

## GitHub Actions release

Run **Android Release** from `main` in GitHub Actions without input parameters. The workflow
prepares a release from the root Gateway version and Android changelog, queries
Google Play for unused phone/Wear build numbers, and creates a clean release
commit locally before signing. The local CLI uses the same flow. Android
preparation is independent of iOS.

The environment supplies these secrets:

- `GH_APP_PRIVATE_KEY`
- `MATCH_PASSWORD`
- `GOOGLE_PLAY_JSON_KEY_DATA`

The workflow uses the locked Fastlane bundle and the existing signing assets.
The upload lane commits phone and Wear bundles, metadata, and screenshots in one
Play edit to `internal` and `wear:internal`, then records the release commit at
`refs/openclaw/mobile-releases/android/<version-name>-<phone-version-code>`.
After upload, a separate finalization job opens a metadata-only PR and requests
squash auto-merge under the existing `main` review and CI gates. The uploaded
source SHA stays immutable; failed uploads leave `main` unchanged. Production
promotion remains manual.

If only finalization fails, rerun only **Finalize Android release on main** or
use the [finalization recovery commands](../VERSIONING.md#git-finalization-and-recovery).
Keep the recovery bundle or full uploaded source SHA. Do not rerun the upload
to repair Git bookkeeping.

The Fastlane planner can be inspected without publishing:

```bash
cd apps/android
bundle _4.0.21_ exec fastlane android release_plan output_path:/tmp/android-release-plan.json
```

It lists uploaded APK and AAB version codes in a temporary edit and always aborts
that edit. The JSON contains `version`, `versionCode`, and `wearVersionCode`.
The pin/sync owner applies the plan before the release commit is created.

Direct Fastlane entry point:

```bash
cd apps/android
fastlane android release_upload
```

For the exact protected-CI toolchain:

```bash
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane android release_upload
```

Use these direct Fastlane entry points only for maintainer debugging when
explicitly requested. Agent-driven releases must use
`pnpm android:release:upload` and stop if it fails.

Release rules:

- `apps/android/version.json` is the pinned Android release version source.
- `apps/android/Config/Version.properties` is generated from that source and read by Gradle.
- The root `package.json` supplies the Gateway version for automatic preparation.
- `apps/android/CHANGELOG.md` supplies Android release notes.
- `apps/android/fastlane/metadata/android/en-US/release_notes.txt` is generated by `pnpm android:version:sync`.
- `apps/android/Config/ReleaseSigning.json` pins the encrypted Android signing assets in the shared signing repo.
- `apkCertificateSha256` in that manifest pins the upload certificate accepted for standalone release APKs; rotate it only with the encrypted keystore.
- `MATCH_PASSWORD` enables Fastlane to pull encrypted Android signing assets into `apps/android/build/release-signing/` before release validation or archive builds.
- Supported pinned Android versions use CalVer: `YYYY.M.PATCH`.
- Phone `versionCode` uses `YYYYMMDDNN`, where `NN` is `01` through `49`; the matching Wear APK adds `50` and uses `51` through `99`.
- `pnpm android:version:pin` writes the Android version and synchronizes its properties and notes.
- `pnpm android:version:sync` regenerates properties and notes from the Android pin and changelog.
- `pnpm android:version:check` validates checked-in Android version artifacts without changing them.
- `pnpm android:release:preflight` validates Google Play auth, Android release signing, synced Android metadata, release notes, and prints the package/track/version/versionCode that will be uploaded.
- `pnpm android:release:signing:sync:pull` pulls encrypted Android signing assets from `apps-signing`.
- `pnpm android:release:signing:sync:push` creates or refreshes encrypted Android signing assets in `apps-signing`.
- `pnpm android:screenshots` builds and installs the phone and Wear OS debug
  apps, launches deterministic screenshot scenes, and writes Play-ready JPEGs
  to the matching `phoneScreenshots` and `wearScreenshots` metadata folders.
- `pnpm android:release:archive` builds the signed phone Play AAB, Wear AAB, and third-party APK into `apps/android/build/release-artifacts/`.
- `pnpm android:release:upload` commits the phone AAB, Wear AAB, metadata, and screenshots in one Google Play edit across the configured phone and `wear:` form-factor tracks. The default tracks are `internal` and `wear:internal`.
- Stable GitHub Release APK publication is separate from Google Play: `OpenClaw Release Publish` dispatches `.github/workflows/android-release.yml`, whose protected `android-release` environment provides `MATCH_PASSWORD`; the repository GitHub App reads the encrypted signing repo.
- Production promotion remains manual in Google Play Console.
- If `pnpm android:release:upload` fails, agent-driven releases must stop and report the failing step. Do not fall back to `pnpm android:release:archive`, `pnpm android:release:metadata`, direct Fastlane lanes, Gradle release artifacts plus Google Play upload commands, or mobile release ref recording.

Screenshots:

- Android screenshot capture writes Play screenshots under
  `apps/android/fastlane/metadata/android/<locale>/images/phoneScreenshots/`
  and `apps/android/fastlane/metadata/android/<locale>/images/wearScreenshots/`.
- Set `SUPPLY_UPLOAD_SCREENSHOTS=1` to include those screenshots in `fastlane android metadata`.
- Do not commit generated screenshot captures unless they become intentional store metadata assets.
