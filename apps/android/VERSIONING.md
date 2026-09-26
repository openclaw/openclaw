# OpenClaw Android Versioning

Android APK publication and ordinary local archives use pinned app metadata.
Google Play releases calculate their version and build numbers for each run and
pass them to the build without changing those defaults.

## Version model

- Google Play uses the same public version format as iOS: for Gateway version `G = YYYY.M.P` and revision `R`, `versionName` is `YYYY.M.concat(P,R)`. Revision is one digit, `0` through `9`, and Android advances independently of iOS.
- Candidates reuse the highest revision for `G` until that revision is public on either the phone or Wear production track. The next candidate then advances the revision. A new Gateway version starts at revision `0`; an existing legacy public release of the same `G` counts as revision `0`. After revision `9` becomes public, advance the Gateway version.
- `buildNumber` starts at `1` for each revision and increases for each candidate. It identifies an attempt independently of the public version and native Android codes.
- Store `versionCode` values are sequential integers. Given the highest live APK/AAB code, recorded store code, legacy cutover code, or pinned phone code plus `50`, the next phone code is `max + 1` and Wear is `max + 2`. Both must be at most `2,100,000,000`. Store codes no longer pack a date or reserve two-digit form-factor ranges.
- Google Play releases save `schemaVersion: 2`, `gatewayVersion`, `revision`, `buildNumber`, `version`, `versionCode`, `wearVersionCode`, `legacyMaxVersionCode`, `sourceSha`, and `releaseNotesBaselines` in `android-plan.json`. `OPENCLAW_ANDROID_RELEASE_PLAN` selects that file for the build; its source SHA must match the checked-out commit.
- Store release notes are generated with OpenAI from source changes since each form factor's public release. `OPENCLAW_MOBILE_RELEASE_NOTES` selects the saved notes JSON artifact, bound to the source SHA and planned release identity.
- `apps/android/version.json` retains the pinned defaults for Gateway APK publication and ordinary local archives: version `YYYY.M.P` and phone code `YYYYMMPPNN`, where `NN` is `01` through `49`. The matching Wear archive adds `50`. `apps/android/Config/Version.properties` is generated from this pin and supplies Gradle's defaults.
- `apps/android/CHANGELOG.md` and `apps/android/fastlane/metadata/android/en-US/release_notes.txt` remain the hand-authored and generated notes for the pinned APK/archive defaults. `pnpm android:version:sync` uses the exact pinned version's section first, then `Unreleased`.

For example, Gateway `2026.9.4` produces public version `2026.9.40` at revision
`0`, then `2026.9.41` at revision `1`. If the highest native code is
`2026090451`, the next candidate uses phone `2026090452` and Wear `2026090453`.
Another candidate keeps its public version until that revision is public and
uses the next build number and native code pair.

Revision selection observes current public store state. Play does not expose a
complete history of obsolete releases, so a revision published and rolled back
between runs cannot be detected automatically. Staged, halted, or ambiguous
current production releases stop planning; resolve them before another run.

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

1. Run the manual **Android Store Release** GitHub Action from `main`. No input parameters are required. The upload uses the `android-store-release` environment and freezes the commit selected at dispatch, even if `main` advances while the run is queued.
2. The workflow derives the Gateway version from the root `package.json`, selects the Android revision from source refs and current public releases, and chooses the next sequential phone/Wear codes above the uploaded codes and pinned floor. It refuses a version regression, an exhausted revision or native code range, and uploaded new-format codes whose source refs are missing.
3. Planning identifies the public releases in `production` and `wear:production`. OpenAI generates separate phone and Wear notes from changes since those releases. Internal uploads do not advance the public baseline. Staged, halted, or ambiguous public releases stop preparation.
4. The workflow saves the plan and generated notes for the selected clean source commit. Fastlane and Gradle consume those artifacts at runtime. No tracked release files, preparation commits, or follow-up PRs are needed.
5. The upload lane validates auth, signing, version metadata, and generated notes; captures phone and Wear screenshots; and builds the signed phone AAB, Wear AAB, and third-party APK. It rechecks the public baselines before uploading both AABs, metadata, and screenshots in one Google Play edit. A changed baseline stops the upload.
6. Before the first new-format upload, the lane records the immutable legacy-code cutover marker. The phone and Wear bundles go to `internal` and `wear:internal`. Production promotion remains manual in Google Play Console. A successful upload records the unchanged source SHA and planned identity in its immutable release ref.

`pnpm android:release:upload` runs the same planning, note generation, and upload
flow from a clean local `main` matching `origin/main`, with no
required arguments.
The read-only Fastlane `release_plan` lane accepts an `output_path` for its JSON
plan. It opens a temporary Play edit to inspect both artifact inventories and
aborts that edit before returning. It never uploads or commits a Play edit.
Each run checks live state; build numbers and store codes do not come from dates
or workflow IDs. Both new codes exceed every previously observed uploaded code.

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
saved plan, notes, and exact AABs when investigating a failed or uncertain upload.
Agent-driven recovery requires explicit maintainer direction after reporting the
failure; do not automatically rerun the upload or record its ref.

The third-party flavor is archived as a signed APK for non-Play distribution. The Play release lane never uploads it. Official GitHub distribution is owned only by `.github/workflows/android-release.yml`, which publishes regular final and correction tags through the protected `android-release` environment as `OpenClaw-Android.apk`.

## Release SHA tracking

Successful Play build uploads create a non-tag Git ref that records the source
commit for the uploaded store build:

```text
refs/openclaw/mobile-releases/android/v2/<G>/<R>/<buildNumber>/<phoneCode>-<wearCode>
```

Example:

```text
refs/openclaw/mobile-releases/android/v2/2026.9.4/0/1/2026090452-2026090453
```

These refs are intentionally outside `refs/tags/*` and `refs/heads/*`. They do
not appear on GitHub release or tag pages, and they do not participate in the
core OpenClaw release machinery.

Before the first new-format upload, the lane creates one marker:

```text
refs/openclaw/mobile-releases/android/cutover-v2/<legacyMaxCode>
```

The marker records the highest legacy uploaded code, or `0` if there are no
uploads, at the first preparation's source SHA. It remains valid after an
abandoned upload and does not prove that an upload succeeded. Codes above the
cutover require a v2 source ref; their numeric shape must never be decoded as a
legacy date. Existing `android/<versionName>-<versionCode>` refs remain unchanged.

`pnpm android:release:upload` checks the success ref before uploading and records
it only after the atomic phone and Wear Play edit commits. Both kinds of ref
point to existing source commits; they create no commits or PRs. Existing refs
are immutable: the same ref at the same SHA is accepted, while a different SHA
fails. `GOOGLE_PLAY_VALIDATE_ONLY=1` does not record an uploaded-build ref.

For release-note generation, each public phone or Wear code resolves through its
v2 ref. Legacy Wear codes resolve to their paired phone ref by subtracting `50`.
Phone and Wear may have different public baselines. If a historical public
build lacks its ref, preparation stops and names the missing ref. A maintainer
must verify that build's actual source SHA against the store and release evidence
before seeding that one historical mapping with `pnpm mobile:release:record`.
Do not infer the source from the latest internal upload. When a form factor has
no public release, generated notes summarize capabilities supported by the
selected source instead.

If Play accepted an upload but recording its v2 ref failed, the next run stops on
the unmapped codes. Preserve `android-plan.json`, the notes, and both uploaded
AABs. Inspect the exact AAB codes and SHA256 hashes against Play's bundle records
and verify the saved source identity. After explicit recovery authorization,
record only the missing ref from the verified plan:

```bash
node --import tsx scripts/mobile-release-ref.ts record \
  --platform android --plan /absolute/path/to/recovery/android-plan.json \
  --root /absolute/path/to/repository
```

This command does not upload artifacts. Do not use it to bless a manual fallback
upload, rebuild different AABs as evidence, or bypass a failed release step.

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
and encodes the Gateway version, revision, build number, and both native codes.

## Signing model

`apps/android/Config/ReleaseSigning.json` pins the Android signing assets in the shared private `apps-signing` repo. The Android pipeline uses the same `MATCH_PASSWORD` release-owner secret as iOS, but the Android files are managed by `scripts/android-release-signing.mjs` instead of Fastlane `match`.

`sync:pull` decrypts the Play upload keystore and Gradle signing properties into `apps/android/build/release-signing/`. That directory is gitignored, and Fastlane exports the materialized values as Gradle project properties for the current release command.

If `MATCH_PASSWORD` is not set, the existing manual Gradle-property signing path still works: provide `OPENCLAW_ANDROID_STORE_FILE`, `OPENCLAW_ANDROID_STORE_PASSWORD`, `OPENCLAW_ANDROID_KEY_ALIAS`, and `OPENCLAW_ANDROID_KEY_PASSWORD` through your local Gradle user properties before running release tasks.

Agent-driven releases must not use those lower-level signing and upload surfaces
to bypass a failed `pnpm android:release:upload` attempt. Report the failing
step and wait for maintainer direction instead.
