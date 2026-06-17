# fastlane setup (OpenClaw Android)

Install:

```bash
brew install fastlane
```

Create a Google Play service account JSON key with Google Play Developer API access, then grant that service account access to the OpenClaw app in Play Console.

Recommended local auth:

```bash
GOOGLE_PLAY_JSON_KEY=/absolute/path/to/google-play-service-account.json
```

Optional app targeting:

```bash
GOOGLE_PLAY_PACKAGE_NAME=ai.openclaw.app
```

Validate auth:

```bash
cd apps/android
fastlane android auth_check
```

Archive locally without upload:

```bash
pnpm android:release:archive
```

Generate deterministic Google Play screenshots:

```bash
pnpm android:screenshots
```

Upload metadata, release notes, and the Play AAB to the internal testing track:

```bash
pnpm android:release:upload
```

Direct Fastlane entry point:

```bash
cd apps/android
fastlane android release_upload
```

Release rules:

- `apps/android/version.json` is the pinned Android release version source.
- `apps/android/Config/Version.properties` is generated from that source and read by Gradle.
- `apps/android/CHANGELOG.md` is the Android-only changelog and release-note source.
- `apps/android/fastlane/metadata/android/en-US/release_notes.txt` is generated from that changelog by `pnpm android:version:sync`.
- Supported pinned Android versions use CalVer: `YYYY.M.D`.
- `versionCode` uses `YYYYMMDDNN`, where `NN` is a two-digit build number for the pinned version.
- `pnpm android:version:pin -- --from-gateway` promotes the current root gateway version into the pinned Android release version.
- `pnpm android:version:pin -- --version 2026.6.5 --version-code 2026060502` increments another build on the same Android release train.
- `pnpm android:version:sync` updates generated version artifacts.
- `pnpm android:version:check` validates checked-in Android version artifacts.
- `pnpm android:release:preflight` validates Google Play auth, Android release signing, synced versioning, release notes, and prints the package/track/version/versionCode that will be uploaded.
- `pnpm android:screenshots` builds and installs the Play debug app, launches deterministic screenshot scenes, and captures raw PNGs.
- `pnpm android:release:archive` builds the signed Play AAB and third-party APK into `apps/android/build/release-artifacts/`.
- `pnpm android:release:upload` uploads the Play AAB to the configured Google Play track. The default track is `internal`.
- Production promotion remains manual in Google Play Console.

Screenshots:

- Android screenshot capture writes raw Play screenshots under `apps/android/fastlane/metadata/android/<locale>/images/phoneScreenshots/`.
- Set `SUPPLY_UPLOAD_SCREENSHOTS=1` to include those screenshots in `fastlane android metadata`.
- Do not commit generated screenshot captures unless they become intentional store metadata assets.
