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

An ordinary archive uses the defaults in `apps/android/version.json` and
`Config/Version.properties`. To build a previously prepared store version, use
its saved plan at the recorded source commit; see
[Archive a saved store release](../VERSIONING.md#archive-a-saved-store-release).

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

Run **Android Store Release** from `main` in GitHub Actions without input parameters. The workflow
plans a release from the root Gateway version, selects the Android public
revision and sequential phone/Wear codes, and generates OpenAI release notes
from source changes since each form factor's public production release. It keeps tracked version
defaults and notes unchanged and passes the saved plan through
`OPENCLAW_ANDROID_RELEASE_PLAN` to select the build version and codes at runtime.
`OPENCLAW_MOBILE_RELEASE_NOTES` selects the saved generated notes artifact. The
local CLI uses the same flow. Android preparation is independent of iOS.

Public versions append a single revision digit to the Gateway patch: Gateway
`2026.9.4`, revision `0` becomes `2026.9.40`. Candidates keep that revision until
it is public on either phone or Wear, then advance it; revisions run from `0`
through `9`. Each revision starts at build `1`. Native codes increase separately:
phone uses the observed maximum plus `1`, Wear plus `2`, including the pinned
phone code plus `50` as a floor. See [Version model](../VERSIONING.md#version-model)
for limits and the distinction from ordinary pinned archives.

The environment supplies these secrets:

- `GH_APP_PRIVATE_KEY`
- `MATCH_PASSWORD`
- `GOOGLE_PLAY_JSON_KEY_DATA`
- `OPENAI_API_KEY`

The workflow uses the locked Fastlane bundle and the existing signing assets.
The upload lane commits phone and Wear bundles, metadata, and screenshots in one
Play edit to `internal` and `wear:internal`, then records the release commit at
`refs/openclaw/mobile-releases/android/v2/<G>/<R>/<buildNumber>/<phoneCode>-<wearCode>`.
Before the first new-format upload, it records the immutable
`android/cutover-v2/<legacyMaxCode>` marker under the same mobile-release ref prefix.
The marker distinguishes legacy codes and does not prove an upload succeeded.
Existing legacy refs remain unchanged.
The source SHA stays immutable and no preparation commit or follow-up PR is
created. Production promotion remains manual.

The release artifacts retain `android-plan.json` and `release-notes.json` for 30
days. Keep the plan and notes and use their recorded source commit for
[archive replay](../VERSIONING.md#archive-a-saved-store-release). If ref recording
fails after Play accepts the upload, the next run stops on the unmapped codes.
Keep the exact AABs and follow the authorized
[record-only recovery](../VERSIONING.md#release-sha-tracking); do not automatically
rerun or re-upload.

The Fastlane planner can be inspected without publishing:

```bash
cd apps/android
bundle _4.0.21_ exec fastlane android release_plan output_path:/tmp/android-release-plan.json
```

It lists uploaded APK and AAB version codes in a temporary edit and always aborts
that edit. The JSON contains the version identity, legacy cutover boundary, and
`releaseNotesBaselines` described in [Version model](../VERSIONING.md#version-model).
Baselines identify the actual public phone and Wear version codes, independent
of internal uploads; release names are not identities.
Staged, halted, and ambiguous public releases stop planning. The release command
binds the plan to the selected `sourceSha` and generates notes for that source. The build
validates the source and notes artifact before using the plan; the planner's
initial output alone is not a complete archive-replay plan. Upload checks the
production baselines again immediately before uploading the bundles.
Revision selection uses current public state: an unseen publication and rollback
between runs cannot be recovered from Play's incomplete release history.

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

- `apps/android/version.json` supplies the pinned defaults for APK publication and ordinary archives.
- `apps/android/Config/Version.properties` is generated from that source and supplies Gradle's defaults. Store releases override them at runtime without writing either file.
- The root `package.json` supplies the Gateway version for automatic preparation.
- `apps/android/CHANGELOG.md` supplies hand-authored notes for pinned APK/archive defaults, selecting the exact pinned version's section first, then `Unreleased`.
- `apps/android/fastlane/metadata/android/en-US/release_notes.txt` is generated for the pin by `pnpm android:version:sync`. Store uploads use separate generated phone and Wear notes from `OPENCLAW_MOBILE_RELEASE_NOTES` and leave this file unchanged.
- `apps/android/Config/ReleaseSigning.json` pins the encrypted Android signing assets in the shared signing repo.
- `apkCertificateSha256` in that manifest pins the upload certificate accepted for standalone release APKs; rotate it only with the encrypted keystore.
- `MATCH_PASSWORD` enables Fastlane to pull encrypted Android signing assets into `apps/android/build/release-signing/` before release validation or archive builds.
- Supported pinned Android versions use CalVer: `YYYY.M.PATCH`.
- Pinned phone `versionCode` uses `YYYYMMPPNN`, where `NN` is `01` through `49`; the matching Wear archive adds `50` and uses `51` through `99`. Store releases override these defaults with independent sequential codes, each at most `2,100,000,000`.
- `pnpm android:version:pin` writes the Android version and synchronizes its properties and notes.
- `pnpm android:version:sync` regenerates properties and notes from the Android pin and changelog.
- `pnpm android:version:check` validates properties and notes against the pin without changing files.
- `pnpm android:release:preflight` requires the saved store plan and generated notes, validates Google Play auth, production baselines, signing, and release identity, and prints the package/track/version/versionCode that will be uploaded.
- `pnpm android:release:signing:sync:pull` pulls encrypted Android signing assets from `apps-signing`.
- `pnpm android:release:signing:sync:push` creates or refreshes encrypted Android signing assets in `apps-signing`.
- `pnpm android:screenshots` builds and installs the phone and Wear OS debug
  apps, launches deterministic screenshot scenes, and writes Play-ready JPEGs
  to the matching `phoneScreenshots` and `wearScreenshots` metadata folders.
- `pnpm android:release:archive` builds the signed phone Play AAB, Wear AAB, and third-party APK into `apps/android/build/release-artifacts/`. It uses pinned defaults unless `OPENCLAW_ANDROID_RELEASE_PLAN` selects a saved plan matching the source commit; replay also requires the saved `OPENCLAW_MOBILE_RELEASE_NOTES` artifact.
- `pnpm android:release:upload` commits the phone AAB, Wear AAB, metadata, and screenshots in one Google Play edit across the configured phone and `wear:` form-factor tracks. The default tracks are `internal` and `wear:internal`.
- Stable GitHub Release APK publication is separate from Google Play: `OpenClaw Release Publish` dispatches `.github/workflows/android-release.yml`, whose protected `android-release` environment provides `MATCH_PASSWORD`; the repository GitHub App reads the encrypted signing repo.
- Production promotion remains manual in Google Play Console.
- If `pnpm android:release:upload` fails, agent-driven releases must stop and report the failing step. Do not fall back to `pnpm android:release:archive`, `pnpm android:release:metadata`, direct Fastlane lanes, Gradle release artifacts plus Google Play upload commands, or mobile release ref recording.
- Recovery needs explicit maintainer direction after the failure is reported. Record-only repair of a missing success ref requires verifying the saved plan and exact uploaded AAB hashes/codes against Play.

Screenshots:

- Android screenshot capture writes Play screenshots under
  `apps/android/fastlane/metadata/android/<locale>/images/phoneScreenshots/`
  and `apps/android/fastlane/metadata/android/<locale>/images/wearScreenshots/`.
- Set `SUPPLY_UPLOAD_SCREENSHOTS=1` to include those screenshots in `fastlane android metadata`.
- Do not commit generated screenshot captures unless they become intentional store metadata assets.
