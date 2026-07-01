# OpenClaw Android Versioning

Android release builds use pinned app metadata instead of auto-bumping `build.gradle.kts`.

## Version model

- `apps/android/version.json` is the source of truth.
- `version` is the Play `versionName` and uses CalVer: `YYYY.M.D`.
- `versionCode` uses `YYYYMMDDNN`, where `NN` is a two-digit build number for that pinned app version.
- `apps/android/Config/Version.properties` is generated from `version.json` and read by Gradle.
- `apps/android/CHANGELOG.md` is the Android-only changelog and release-note source.
- `apps/android/fastlane/metadata/android/en-US/release_notes.txt` is generated from the changelog.

Examples:

- `version = 2026.6.2`
- `versionCode = 2026060201`
- another upload on the same release train: `versionCode = 2026060202`

## Commands

```bash
pnpm android:version
pnpm android:version:check
pnpm android:version:sync
pnpm android:version:pin -- --from-gateway
pnpm android:version:pin -- --version 2026.6.5 --version-code 2026060501
pnpm android:release:signing:plan
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:sync:pull
pnpm android:release:preflight
```

## Release-note resolution order

When generating `apps/android/fastlane/metadata/android/en-US/release_notes.txt`, the tooling reads the first available changelog section in this order:

1. exact pinned version, for example `## 2026.6.2`
2. `## Unreleased`

Recommended workflow:

- while iterating on a Play internal testing train, keep pending notes under `## Unreleased`
- before the production release, move or copy the final notes under `## <pinned version>` and run sync again

## Release Workflow

1. Pin Android to the intended release version.
2. Run `pnpm android:version:sync`.
3. Update `apps/android/CHANGELOG.md`, then run `pnpm android:version:sync` again if needed.
4. Run `MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:sync:pull` to materialize encrypted Android signing assets from `apps-signing`.
5. Run `pnpm android:release:preflight` to validate Play auth, signing, synced versioning, and release notes.
6. Run `ANDROID_SCREENSHOT_AVD=<avd-name> pnpm android:screenshots` to refresh raw Google Play screenshots with a script-managed emulator, or run `pnpm android:screenshots` when exactly one ADB device is already connected.
7. Run `pnpm android:release:archive` to produce the signed Play AAB and third-party APK.
8. When Play Console Data Safety answers change, review the CSV declaration and run `pnpm android:release:data-safety`, or set `GOOGLE_PLAY_UPLOAD_DATA_SAFETY=1` during release upload.
9. Run `pnpm android:release:upload` to upload metadata, screenshots, and the Play AAB to Google Play internal testing.
10. Promote to production manually in Google Play Console.

The third-party flavor is archived as a signed APK for non-Play distribution. It is not uploaded by the Play release lane.

## Release SHA tracking

Successful Play build uploads create a non-tag Git ref that records the source
commit for the uploaded store build:

```text
refs/openclaw/mobile-releases/android/<versionName>-<versionCode>
```

Example:

```text
refs/openclaw/mobile-releases/android/2026.6.10-2026061008
```

These refs are intentionally outside `refs/tags/*` and `refs/heads/*`. They do
not appear on GitHub release or tag pages, and they do not participate in the
core OpenClaw release machinery.

`pnpm android:release:upload` checks the ref before uploading the Play build and
records it only after `upload_to_play_store` succeeds. Existing refs are
immutable: the same ref at the same SHA is accepted, while the same ref at a
different SHA fails. `GOOGLE_PLAY_VALIDATE_ONLY=1` still checks the ref but does
not record it because no Play build is published.

Useful direct commands:

```bash
pnpm mobile:release:preflight -- --platform android --version 2026.6.10 --version-code 2026061008
pnpm mobile:release:resolve -- --platform android --version 2026.6.10 --version-code 2026061008
```

## Signing model

`apps/android/Config/ReleaseSigning.json` pins the Android signing assets in the shared private `apps-signing` repo. The Android pipeline uses the same `MATCH_PASSWORD` release-owner secret as iOS, but the Android files are managed by `scripts/android-release-signing.mjs` instead of Fastlane `match`.

`sync:pull` decrypts the Play upload keystore and Gradle signing properties into `apps/android/build/release-signing/`. That directory is gitignored, and Fastlane exports the materialized values as Gradle project properties for the current release command.

If `MATCH_PASSWORD` is not set, the existing manual Gradle-property signing path still works: provide `OPENCLAW_ANDROID_STORE_FILE`, `OPENCLAW_ANDROID_STORE_PASSWORD`, `OPENCLAW_ANDROID_KEY_ALIAS`, and `OPENCLAW_ANDROID_KEY_PASSWORD` through your local Gradle user properties before running release tasks.
