# OpenClaw iOS Versioning

OpenClaw iOS releases retain their gateway association while allowing multiple
public App Store releases for one gateway version. Release commands name the
gateway version and the App Store revision explicitly.

## Goals

- keep the associated gateway version recognizable
- support multiple public iOS releases per gateway version
- support multiple candidate builds per App Store version
- make every release identity explicit and deterministic
- keep Apple bundle fields valid for App Store Connect
- generate version-specific App Store release notes from the iOS changelog

## Version model

An iOS release has three independent identifiers:

- gateway version `G = YYYY.M.P`, for example `2026.7.2`
- App Store revision `R`, an integer from `0` through `99`
- build number `B`, a positive integer scoped to the exact App Store version

The App Store version packs the revision into the third numeric component:

```text
AppStoreVersion(G, R) = YYYY.M.(P * 100 + R)
```

Examples:

| Gateway | Revision | App Store version | Candidate builds |
| --- | ---: | --- | --- |
| `2026.7.2` | legacy `0` | `2026.7.2` | closed history |
| `2026.7.2` | `1` | `2026.7.201` | `1`, `2`, `3` |
| `2026.7.2` | `2` | `2026.7.202` | `1`, `2`, ... |
| `2026.7.3` | `0` | `2026.7.300` | `1`, `2`, ... |

Historical exact versions are grandfathered as read-only release history. The
release tooling does not target them again. All future uploads use the packed
format, including revision zero.

## Release commands

Release uploads require the gateway version and App Store revision:

```bash
pnpm ios:release:upload -- --version 2026.7.2 --revision 1
```

Use `--build-number` only when the exact next remote build number has already
been verified:

```bash
pnpm ios:release:upload -- --version 2026.7.2 --revision 1 --build-number 3
```

During upload, an explicit build number must equal the next App Store Connect
build for the derived App Store version. Offline archive validation can accept
an explicit build number without remote validation:

```bash
pnpm ios:release:archive -- --version 2026.7.2 --revision 1 --build-number 3
```

## Apple bundle mapping

Gateway `2026.7.2`, revision `1`, build `3` maps to:

- `OpenClawCanonicalVersion = 2026.7.2`
- `CFBundleShortVersionString = 2026.7.201`
- `CFBundleVersion = 3`

Local development builds continue using the normalized gateway version as the
marketing version. Release preparation supplies the explicit revision and
therefore the packed App Store version.

## Revision and build lifecycle

- A revision is reserved once its App Store version record is created and is
  never reused.
- Rejected or replaced candidate builds stay on the same App Store version and
  increment only the build number.
- After an App Store version is distributed, another public release for the
  same gateway uses the next revision and resets its build number to `1`.
- Build numbers are derived from the highest uploaded build for the exact App
  Store version plus one. Failed local archives do not consume build numbers;
  accepted App Store Connect uploads do.
- App Review submission remains manual.

Before screenshot or archive work, the upload lane checks App Store Connect:

- an absent version may be created during metadata staging
- an editable version is reused
- a locked or in-review version fails the run
- a distributed version requires the next revision
- a missing revision below an existing higher version fails because revisions
  are never reused

## Release notes

Production release notes require an exact App Store version heading:

```markdown
## 2026.7.201

- Fixed an iOS issue.
```

The generated App Store text automatically starts with:

```text
Gateway version: 2026.7.2
```

Production revision builds do not fall back to the gateway heading or
`## Unreleased`. Local version checks without `--revision` retain the existing
gateway/`Unreleased` fallback for development.

Validate exact release notes with:

```bash
pnpm ios:version:check -- --version 2026.7.2 --revision 1
```

## Source of truth and generated files

Source files:

- root `package.json`: default gateway version for local builds
- explicit `--version`: gateway version for release commands
- explicit `--revision`: App Store revision for release commands
- `apps/ios/CHANGELOG.md`: exact App Store release notes
- `apps/ios/VERSIONING.md`: versioning contract

Generated or derived files:

- `apps/ios/build/Version.xcconfig`
- `apps/ios/build/AppStoreRelease.xcconfig`
- `apps/ios/SwiftSources.input.xcfilelist`
- temporary Fastlane metadata rendered from `apps/ios/CHANGELOG.md`

The canonical implementation is split across:

- `scripts/lib/ios-version.ts`: validation, encoding, and release-note rendering
- `scripts/ios-version.ts`: JSON, shell, and single-field queries
- `scripts/ios-sync-versioning.ts`: release-note validation
- `scripts/ios-release-upload.sh`: guarded upload entry point
- `apps/ios/fastlane/Fastfile`: remote preflight, build allocation, metadata,
  archive, validation, and upload

## Release SHA tracking

Successful uploads record the exact App Store version and build:

```text
refs/openclaw/mobile-releases/ios/<CFBundleShortVersionString>-<CFBundleVersion>
```

For example:

```text
refs/openclaw/mobile-releases/ios/2026.7.201-3
```

The ref is checked before archive/upload work and created only after App Store
Connect accepts the upload. Existing refs are immutable.

## Normal workflow

1. Choose the gateway version and App Store revision explicitly.
2. Add an exact encoded-version section to `apps/ios/CHANGELOG.md`.
3. Validate it:

```bash
pnpm ios:version:check -- --version 2026.7.2 --revision 1
```

4. Upload build `1`, or let Fastlane resolve the next build:

```bash
pnpm ios:release:upload -- --version 2026.7.2 --revision 1
```

5. Iterate on the same version for builds `2`, `3`, and so on.
6. Select one processed build and submit it manually in App Store Connect.
7. If another public release is needed after distribution, increment the App
   Store revision and start its build count at `1`.

Agent-driven uploads must use `pnpm ios:release:upload`. A failed upload is
terminal for that attempt: report the failing step rather than switching to a
lower-level archive, upload, staging, or submission command.
