# OpenClaw Android Versioning

Android APK publication and ordinary local archives use pinned app metadata.
Google Play releases calculate their version and build numbers for each run and
pass them to the build without changing those defaults.

## Version model

- `apps/android/version.json` supplies the default Android version and code for APK publication and local archives.
- `version` is the Play `versionName` and uses CalVer: `YYYY.M.PATCH`.
- `versionCode` uses `YYYYMMDDNN`, where phone build number `NN` is `01` through `49`.
- The matching Wear bundle reserves `51` through `99` by adding `50` to the phone code.
- `apps/android/Config/Version.properties` is generated from `version.json` and supplies Gradle's defaults.
- Google Play releases save `version`, `versionCode`, `wearVersionCode`, `sourceSha`, and `releaseNotesBaselines` in `android-plan.json`. `OPENCLAW_ANDROID_RELEASE_PLAN` selects that file for the build; its source SHA must match the checked-out commit.
- Store release notes are generated with OpenAI from source changes since each form factor's public release. `OPENCLAW_MOBILE_RELEASE_NOTES` selects the saved notes JSON artifact, bound to the source SHA and planned release identity.
- `apps/android/CHANGELOG.md` and `apps/android/fastlane/metadata/android/en-US/release_notes.txt` remain the hand-authored and generated notes for the pinned APK/archive defaults. `pnpm android:version:sync` uses the exact pinned version's section first, then `Unreleased`.

Examples:

- `version = 2026.6.2`
- `versionCode = 2026060201`
- matching Wear `versionCode = 2026060251`
- another upload on the same release train: `versionCode = 2026060202`

## Commands

```bash
pnpm android:version
pnpm android:version:check
pnpm android:version:pin -- --from-gateway
pnpm android:version:sync
pnpm android:release:signing:plan
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:sync:pull
pnpm android:release:preflight
```

`pnpm android:version:check` checks version properties and notes against the pin.
Store uploads validate their saved generated notes separately and leave these
tracked defaults unchanged.

## Release Workflow

1. Run the manual **Android Store Release** GitHub Action from `main`. No input parameters are required. The upload uses the `android-store-release` environment.
2. The workflow derives the app version from the root `package.json`, queries Google Play for uploaded APK and AAB codes, and chooses the next unused phone/Wear pair. It refuses a version older than the pinned or uploaded release, ambiguous code ranges, and exhaustion of the 49 pairs for one version.
3. Planning identifies the public releases in `production` and `wear:production`. OpenAI generates separate phone and Wear notes from changes since those releases. Internal uploads do not advance the public baseline. Staged, halted, or ambiguous public releases stop preparation.
4. The workflow saves the plan and generated notes for the selected clean source commit. Fastlane and Gradle consume those artifacts at runtime. No tracked release files, preparation commits, or follow-up PRs are needed.
5. The upload lane validates auth, signing, version metadata, and generated notes; captures phone and Wear screenshots; and builds the signed phone AAB, Wear AAB, and third-party APK. It rechecks the public baselines before uploading both AABs, metadata, and screenshots in one Google Play edit. A changed baseline stops the upload.
6. The phone and Wear bundles go to `internal` and `wear:internal`. Production promotion remains manual in Google Play Console. A successful upload records the unchanged source SHA in its immutable release ref.

`pnpm android:release:upload` runs the same planning, note generation, and upload
flow from a clean local `main` matching `origin/main`, with no
required arguments.
The read-only Fastlane `release_plan` lane accepts an `output_path` for its JSON
plan. It opens a temporary Play edit to inspect both artifact inventories and
aborts that edit before returning. It never uploads or commits a Play edit.
Each run checks live state; build numbers do not come from dates or workflow IDs.
Phone and Wear codes increase within their distinct form-factor ranges. A new
phone code can be lower than an earlier Wear code because those builds target
different devices.

For a regular final or correction OpenClaw release whose tagged Android pin
matches the stable train, `OpenClaw Release Publish` dispatches **Android APK
Artifact Publish** after core npm publishes successfully. A mismatched pin
records an explicit skip. This separate workflow attaches the signed third-party
APK, checksum manifest, and GitHub provenance; it may finish after the GitHub
release becomes public. A correction with its own package version needs a higher
pinned `versionCode` than the preceding APK. A same-commit fallback correction
reuses the base release's verified APK and adds provenance for the correction tag.

If `pnpm android:release:upload` fails, stop at that failure. Do not continue by
uploading archived artifacts through `pnpm android:release:archive`,
`pnpm android:release:metadata`, direct Fastlane lanes, Gradle release artifacts,
Google Play API mutation commands, or Play Console mutation commands. Fix the
failing release-lane step and inspect the store outcome before retrying. Keep the
saved plan and notes when investigating a failed or uncertain upload.

The third-party flavor is archived as a signed APK for non-Play distribution. The Play release lane never uploads it. Official GitHub distribution is owned only by `.github/workflows/android-release.yml`, which publishes regular final and correction tags through the protected `android-release` environment as `OpenClaw-Android.apk`.

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
records it only after the atomic phone and Wear Play edit commits. Existing refs are
immutable: the same ref at the same SHA is accepted, while the same ref at a
different SHA fails. `GOOGLE_PLAY_VALIDATE_ONLY=1` still checks the ref but does
not record it because no Play build is published.

Do not create this ref after a manual fallback upload. The ref is release-lane
evidence, not a repair mechanism for a failed `pnpm android:release:upload` run.

For release-note generation, the public phone code resolves directly to its
release ref; the public Wear code resolves to the paired phone ref by subtracting
50. Phone and Wear may have different public baselines. If a historical public
build lacks its ref, preparation stops and names the missing ref. A maintainer
must verify that build's actual source SHA against the store and release evidence
before seeding that one historical mapping with `pnpm mobile:release:record`.
Do not infer the source from the latest internal upload. When a form factor has
no public release, generated notes summarize capabilities supported by the
selected source instead.

Useful direct commands:

```bash
pnpm mobile:release:preflight -- --platform android --version 2026.6.10 --version-code 2026061008
pnpm mobile:release:resolve -- --platform android --version 2026.6.10 --version-code 2026061008
```

## Archive a saved store release

The workflow retains `android-plan.json` and `release-notes.json` for 30 days.
Keep both the plan and notes when you need to build that
store version again: the source commit retains the independent APK pin.

From a clean checkout of the plan's `sourceSha`, with the usual archive toolchain
and signing assets available, run:

```bash
OPENCLAW_ANDROID_RELEASE_PLAN=/absolute/path/to/recovery/android-plan.json \
OPENCLAW_MOBILE_RELEASE_NOTES=/absolute/path/to/recovery/release-notes.json \
pnpm android:release:archive
```

This builds with the saved version and phone/Wear codes without querying Play
for another pair or uploading artifacts. It refuses a plan for a different
source commit. Without `OPENCLAW_ANDROID_RELEASE_PLAN`, the archive command uses
the pinned defaults. The successful release ref also records the source commit
and encodes the store version and phone code in its name.

## Signing model

`apps/android/Config/ReleaseSigning.json` pins the Android signing assets in the shared private `apps-signing` repo. The Android pipeline uses the same `MATCH_PASSWORD` release-owner secret as iOS, but the Android files are managed by `scripts/android-release-signing.mjs` instead of Fastlane `match`.

`sync:pull` decrypts the Play upload keystore and Gradle signing properties into `apps/android/build/release-signing/`. That directory is gitignored, and Fastlane exports the materialized values as Gradle project properties for the current release command.

If `MATCH_PASSWORD` is not set, the existing manual Gradle-property signing path still works: provide `OPENCLAW_ANDROID_STORE_FILE`, `OPENCLAW_ANDROID_STORE_PASSWORD`, `OPENCLAW_ANDROID_KEY_ALIAS`, and `OPENCLAW_ANDROID_KEY_PASSWORD` through your local Gradle user properties before running release tasks.

Agent-driven releases must not use those lower-level signing and upload surfaces
to bypass a failed `pnpm android:release:upload` attempt. Report the failing
step and wait for maintainer direction instead.
