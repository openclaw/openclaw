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
4. Run `pnpm android:release:preflight` to validate Play auth, signing, synced versioning, and release notes.
5. Run `pnpm android:screenshots` to refresh raw Google Play screenshots.
6. Run `pnpm android:release:archive` to produce the signed Play AAB and third-party APK.
7. Run `pnpm android:release:upload` to upload metadata, screenshots, and the Play AAB to Google Play internal testing.
8. Promote to production manually in Google Play Console.

The third-party flavor is archived as a signed APK for non-Play distribution. It is not uploaded by the Play release lane.
