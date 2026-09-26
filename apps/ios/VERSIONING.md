# OpenClaw iOS Versioning

OpenClaw iOS releases retain their gateway association while allowing multiple
public App Store releases for one gateway version. The release planner derives
the active release identity from the repository and App Store Connect.

## Goals

- keep the associated gateway version recognizable
- support multiple public iOS releases per gateway version
- support multiple candidate builds per App Store version
- make every release identity deterministic and inspectable before upload
- keep Apple bundle fields valid for App Store Connect
- generate version-specific App Store release notes from changes since the last public build

## Version model

An iOS release has three independent identifiers:

- gateway version `G = YYYY.M.P`, for example `2026.7.2`
- App Store revision `R`, a single digit from `0` through `9`
- build number `B`, a positive integer scoped to the exact App Store version

The App Store version appends the revision directly to the gateway patch with no padding:

```text
AppStoreVersion(G, R) = YYYY.M.concat(P, R)
```

Examples:

| Gateway | Revision | App Store version | Candidate builds |
| --- | ---: | --- | --- |
| `2026.7.2` | legacy `0` | `2026.7.2` | closed history |
| `2026.7.2` | `1` | `2026.7.21` | `1`, `2`, `3` |
| `2026.7.2` | `2` | `2026.7.22` | `1`, `2`, ... |
| `2026.7.3` | `0` | `2026.7.30` | `1`, `2`, ... |

Historical exact versions through `2026.7.2` are grandfathered as read-only
release history and consume revision zero for their gateway. That explicit
cutover keeps later appended versions such as `2026.7.21` from being mistaken
for a future gateway's exact legacy release. The release tooling does not target
exact versions again; all future uploads use the appended single-digit format.

## Release commands

Run **iOS Store Release** in GitHub Actions from `main`, or use the same release entry
point from a clean local `main` checkout that matches `origin/main`:

```bash
pnpm ios:release:upload
```

GitHub releases freeze the `main` commit selected when the workflow is dispatched,
even if `main` advances while the run is queued. Local releases freeze current
`main`. The entry point freezes the live plan, generates and reviews release
notes from Git history, and saves them in an immutable JSON
artifact. It builds that source in an isolated worktree, uploads the IPA, waits
for processing, then stages the saved notes and selects the processed build on
the editable App Store version. The release does not edit tracked files, create
preparation commits, or open metadata PRs. App Review submission remains manual.

Notes generation requires `OPENAI_API_KEY` alongside the existing signing,
App Store Connect, and repository credentials.

Inspect the read-only plan separately:

```bash
pnpm ios:release:plan -- --json
```

The planner's `--version`, `--revision`, and `--build-number` options are checked
overrides, never alternate release identities. No release arguments are required. Local archive validation still requires explicit values:

```bash
pnpm ios:release:archive -- --version 2026.7.2 --revision 1 --build-number 3
```

## Apple bundle mapping

Gateway `2026.7.2`, revision `1`, build `3` maps to:

- `OpenClawCanonicalVersion = 2026.7.2`
- `CFBundleShortVersionString = 2026.7.21`
- `CFBundleVersion = 3`

Local development builds continue using the normalized gateway version as the
marketing version. Release preparation supplies the explicit revision and
therefore the appended App Store version.

## Revision and build lifecycle

- A revision is reserved once its App Store version record is created and is
  never reused.
- Awaiting, processing, failed, and complete uploads stay on the same App Store
  version and increment only the build number.
- After an App Store version is distributed, another public release for the
  same gateway uses the next revision and resets its build number to `1`.
- Build numbers come from the highest App Store Connect `buildUploads` record
  for the exact version plus one. Failed local archives do not consume build
  numbers; every Apple-visible upload reservation or attempt does.
- App Review submission remains manual.

Before screenshot or archive work, the upload lane checks App Store Connect:

- an absent version may be created during metadata staging
- the one editable version for the current gateway is reused
- a locked or in-review version fails the run
- an unreleased revision present only in build-upload history is retried
- a distributed version requires the next revision
- multiple active versions, a different active gateway, and unknown upload
  states fail closed for human resolution

Only one iOS release uploader may run at a time. The pipeline rechecks the
exact plan after local archive and Transporter validation, immediately before
its first App Store mutation. After upload it waits up to one hour for Apple
processing, then fails the attempt rather than polling indefinitely.

## Release notes

The notes baseline is the exact build attached to the latest public App Store
version. Later TestFlight candidates do not advance it. Previously public
versions that were replaced or removed from sale remain release history. A
missing or ambiguous attached build stops planning; an empty baseline is valid
only when the app has never had a public version.

The shared generator resolves that build's immutable source ref, examines the
changes through the selected source SHA, and saves reviewed en-US text in
`release-notes.json`. The artifact records its source, store identity, baseline,
and content hashes. Both the CLI and GitHub Action upload the same saved text.
Missing or mismatched artifacts fail before upload; the store path never falls
back to a changelog. A changed public baseline during preparation stops the
attempt before its first store write.

After Apple processes the IPA, the pipeline records its source ref, writes
What's New, selects that exact build, and reads both back. For the sole first
App Store version, Apple has no What's New field: the pipeline retains the
notes artifact and selects the build, reporting that omission explicitly.

`apps/ios/CHANGELOG.md`, `pnpm ios:release:cut`, and
`pnpm ios:version -- --field releaseNotes` remain historical changelog tools.
They do not supply notes or gate store uploads. Version checks and local archive
validation do not require changelog preparation.

## Source of truth and generated files

Source files:

- root `package.json`: default gateway version for local builds and release planning
- App Store Connect versions and build uploads: revision/build lifecycle state
- explicit release arguments: checked overrides only
- Git history and the latest public build source ref: release-note evidence
- `apps/ios/CHANGELOG.md`: historical human-maintained notes
- `apps/ios/VERSIONING.md`: versioning contract

Generated or derived files:

- `apps/ios/build/Version.xcconfig`
- `apps/ios/build/AppStoreRelease.xcconfig`
- `apps/ios/SwiftSources.input.xcfilelist`
- `ios-plan.json` and `release-notes.json` in the printed recovery directory
- temporary Fastlane metadata for screenshots and the App Review attachment

The canonical implementation is split across:

- `scripts/lib/ios-version.ts`: version validation, encoding, and historical changelog rendering
- `scripts/lib/ios-release-plan.ts`: deterministic revision/build selection and
  changelog cutting
- `scripts/ios-version.ts`: JSON, shell, and single-field queries
- `scripts/ios-release-plan.ts`: pure planner CLI used by the Fastlane adapter
- `scripts/ios-release-{plan,cut}.sh`: public planning and cutting entry points
- `scripts/ios-sync-versioning.ts`: version-input validation
- `scripts/lib/mobile-release-notes.ts`: shared notes generation, review, and artifact validation
- `scripts/mobile-release.mjs`: isolated preparation, upload orchestration, and staging recovery
- `scripts/ios-release-upload.sh`: guarded Fastlane upload wrapper invoked by the release entry point
- `apps/ios/fastlane/Fastfile`: remote preflight, build allocation, metadata,
  archive, validation, and upload

## Release SHA tracking

Successful uploads record the exact App Store version and build:

```text
refs/openclaw/mobile-releases/ios/<CFBundleShortVersionString>-<CFBundleVersion>
```

For example:

```text
refs/openclaw/mobile-releases/ios/2026.7.21-3
```

The ref is checked before archive/upload work and created only after App Store
Connect finishes processing the upload, before notes and build selection are
staged. Existing refs are immutable; their presence proves the uploaded source,
not successful completion of later staging.

## Normal workflow

1. Commit and land the app changes on `main`.
2. Run **iOS Store Release** from `main`, or run `pnpm ios:release:upload` locally.
3. The pipeline generates notes, captures screenshots, archives, uploads, and
   stages the processed build and saved notes for manual App Review submission.
4. If preparation or upload fails, inspect the failing step and store state
   before retrying. Every Apple-visible attempt consumes its build number.
5. Review and submit the selected build manually in App Store Connect.
6. After distribution, the next run allocates the next App Store revision.

## Staging recovery

If upload and processing succeeded but saving notes or selecting the build
failed, retain the printed recovery directory or download its workflow artifact.
Retry staging from a clean checkout using that original saved state:

```bash
node scripts/mobile-release.mjs stage --platform ios --recovery-dir /path/to/recovery
```

This verifies the immutable upload ref, restores the original source if needed,
and uses the saved notes and build identity. It does not generate new notes,
replan a release, build, or upload another IPA. App Store Connect credentials
are required. A locked version, invalid or expired build, newer selected build,
or mismatched source stops recovery for human resolution. Partial staging can
be retried with the same command after the cause is fixed.

The recovery directory contains the saved plan and notes, any exported signed
binaries under `artifacts/`, and screenshot fixture PNGs and the capture-attempt
ledger under `screenshot-diagnostics/`. Raw Xcode logs and XCTest results are
excluded because they can contain credentials. Failed local attempts also keep
their source worktree; staging recovery can restore source from the immutable
upload ref. CI retains the recovery, binary, and screenshot artifacts for 30 days.
Binary and screenshot ZIPs can contain their recovery subdirectories or matching
`source/apps/ios/` build paths when an interrupted command did not finish collection.
Keep the original notes artifact for staging recovery; a source SHA alone cannot
reconstruct the exact reviewed text.

If no successful upload ref exists, inspect App Store Connect before taking
further action. An uncertain upload must not be repeated blindly. A failed ref
write reports its record-only recovery command; reconcile that upload before
using staging recovery.

Agent-driven uploads must use `pnpm ios:release:upload`. Report the failing step
and use this recovery path only for an already uploaded build. App Review
submission remains manual.
