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
- generate version-specific App Store release notes from the iOS changelog

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

Run **iOS Release** in GitHub Actions from `main`, or use the same release entry
point from a clean local `main` checkout that matches `origin/main`:

```bash
pnpm ios:release:upload
```

The entry point selects the live plan, cuts `## Unreleased` notes with
`pnpm ios:release:cut`, and commits changed release metadata locally before
building in an isolated worktree. It uploads the exact prepared commit. After a
successful upload, it opens a metadata-only PR and enables squash auto-merge
under the existing `main` review and CI gates. The uploaded source commit remains
immutable even though the final commit on `main` has a different SHA. Failed
uploads do not change `main`; unchanged preparation needs no PR.

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

Production release notes require an exact App Store version heading:

```markdown
## 2026.7.21

- Fixed an iOS issue.
```

The generated App Store text automatically starts with:

```text
Gateway version: 2026.7.2
```

Production revision builds do not fall back to the gateway heading or
`## Unreleased`. Local version checks without `--revision` retain the existing
gateway/`Unreleased` fallback for development.

The cutter moves new notes into that exact heading and is idempotent:

```bash
pnpm ios:release:cut
```

## Source of truth and generated files

Source files:

- root `package.json`: default gateway version for local builds and release planning
- App Store Connect versions and build uploads: revision/build lifecycle state
- explicit release arguments: checked overrides only
- `apps/ios/CHANGELOG.md`: exact App Store release notes
- `apps/ios/VERSIONING.md`: versioning contract

Generated or derived files:

- `apps/ios/build/Version.xcconfig`
- `apps/ios/build/AppStoreRelease.xcconfig`
- `apps/ios/SwiftSources.input.xcfilelist`
- temporary Fastlane metadata rendered from `apps/ios/CHANGELOG.md`

The canonical implementation is split across:

- `scripts/lib/ios-version.ts`: validation, encoding, and release-note rendering
- `scripts/lib/ios-release-plan.ts`: deterministic revision/build selection and
  changelog cutting
- `scripts/ios-version.ts`: JSON, shell, and single-field queries
- `scripts/ios-release-plan.ts`: pure planner CLI used by the Fastlane adapter
- `scripts/ios-release-{plan,cut}.sh`: public planning and cutting entry points
- `scripts/ios-sync-versioning.ts`: release-note validation
- `scripts/mobile-release.mjs`: isolated preparation, upload orchestration, and Git finalization
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
Connect accepts the upload. Existing refs are immutable.

## Normal workflow

1. Add iOS release notes under `## Unreleased` and commit the app changes.
2. Run **iOS Release** from `main`, or run `pnpm ios:release:upload` locally.
3. The pipeline prepares and commits notes locally, uploads the planned build,
   and persists those notes only after success.
4. If preparation or upload fails, stop and inspect the failing step and store
   state before retrying. An Apple-visible attempt consumes its build number.
   If only Git finalization failed, use the recovery path below.
5. Select one processed build and submit it manually in App Store Connect.
6. After distribution, the next run allocates the next App Store revision.

## Git finalization and recovery

Both mobile pipelines use `scripts/mobile-release.mjs` for Git finalization.
After a successful upload, it applies only the prepared release metadata to
current `main`, opens a PR, and requests squash auto-merge. Existing reviews and
CI remain required. Finalization creates no merge commits and never force-pushes
branches or rewrites the immutable uploaded source ref.

If only finalization fails or waits for repository gates, rerun only the
**Finalize iOS release on main** job. Do not rerun the upload job or dispatch a
new release to repair Git bookkeeping. The finalizer reuses its existing PR and
recognizes a completed finalization.

The release command prints its recovery directory. It retains the prepared
source in `release.bundle` and copies any exported signed binaries into
`artifacts/`. CI uploads these as separate artifacts with 30-day retention.

For local recovery, keep that directory, or extract the workflow's recovery
artifact containing `release.bundle` into a directory. From a clean checkout, run:

```bash
node scripts/mobile-release.mjs finalize --platform ios --recovery-dir /path/to/recovery
```

If the artifact is unavailable, recover from the full source SHA printed by the
successful upload. The finalizer verifies and fetches its immutable release ref:

```bash
node scripts/mobile-release.mjs finalize --platform ios --source-sha <full-uploaded-source-sha>
```

Use `--platform android` for the same Android recovery commands. Finalization
requires repository access and performs no store calls or uploads. If no
successful release ref exists, inspect the store outcome before further action;
these commands cannot establish that an uncertain upload succeeded.

A conflict retains the finalization worktree at the reported path. Resolve only
the release metadata, preserve newer notes and version data, and finish the
cherry-pick. Keep the commit trailers `Mobile-Release-Platform: ios` (or
`android`) and `Mobile-Release-Source: <full-uploaded-source-sha>`, then rerun
finalization with the same recovery directory. Do not replace an existing
finalization branch with a force push.

Agent-driven uploads must use `pnpm ios:release:upload`. A failed upload is
terminal for that attempt: report the failing step rather than switching to a
lower-level archive, upload, staging, or submission command.
