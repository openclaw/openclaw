# OpenClaw iOS Versioning

OpenClaw iOS uses a **pinned CalVer release version** instead of reading the current gateway version automatically on every build.

## Goals

- keep TestFlight submissions on one stable app version while iterating
- change only `CFBundleVersion` during normal TestFlight iteration
- promote the iOS release version to the current gateway version only when a maintainer chooses to do that
- keep Apple bundle fields valid for App Store Connect
- generate App Store release notes from an iOS-owned changelog

## Version model

The pinned iOS release version lives in `apps/ios/version.json`.

Supported pinned format:

- `YYYY.M.D`

Examples:

- `2026.4.6`
- `2026.4.10`

The root gateway version in `package.json` may still be one of:

- `YYYY.M.D`
- `YYYY.M.D-beta.N`
- `YYYY.M.D-N`

When you pin iOS from the gateway version, the iOS tooling strips the gateway suffix and keeps only the base CalVer.

Examples:

- gateway `2026.4.10` -> iOS `2026.4.10`
- gateway `2026.4.10-beta.3` -> iOS `2026.4.10`
- gateway `2026.4.10-2` -> iOS `2026.4.10`

## Apple bundle mapping

Pinned iOS version `2026.4.10` maps to:

- `CFBundleShortVersionString = 2026.4.10`
- `CFBundleVersion = numeric build number only`

`CFBundleShortVersionString` stays fixed for a TestFlight train until you intentionally pin a newer iOS release version.

## Source of truth and generated files

### Source files

- `apps/ios/version.json`
  - pinned iOS release version
- `apps/ios/CHANGELOG.md`
  - iOS-only changelog and release-note source
- `apps/ios/VERSIONING.md`
  - workflow and constraints

### Generated or derived files

- `apps/ios/Config/Version.xcconfig`
  - checked-in defaults derived from `apps/ios/version.json`
- `apps/ios/fastlane/metadata/en-US/release_notes.txt`
  - generated from `apps/ios/CHANGELOG.md`
- `apps/ios/build/Version.xcconfig`
  - local gitignored build override generated per build or beta prep

## Tooling surfaces

### Version parsing and sync tooling

- `scripts/lib/ios-version.ts`
  - validates pinned iOS CalVer
  - normalizes gateway version -> pinned iOS CalVer
  - renders checked-in xcconfig and release notes
- `scripts/ios-version.ts`
  - CLI for JSON, shell, or single-field version reads
- `scripts/ios-sync-versioning.ts`
  - syncs checked-in derived files from the pinned iOS version
- `scripts/ios-pin-version.ts`
  - explicitly pins iOS to a chosen release version or the current gateway version

### Build and beta flow

- `scripts/ios-write-version-xcconfig.sh`
  - reads the pinned iOS version
  - writes the local numeric build override file in `apps/ios/build/Version.xcconfig`
- `scripts/ios-beta-prepare.sh`
  - prepares beta signing and bundle settings against the pinned iOS version
- `apps/ios/fastlane/Fastfile`
  - resolves version metadata from the pinned iOS helper
  - increments TestFlight build numbers for the pinned short version

## Release-note resolution order

When generating `apps/ios/fastlane/metadata/en-US/release_notes.txt`, the tooling reads the first available changelog section in this order:

1. exact pinned version, for example `## 2026.4.10`
2. `## Unreleased`

Recommended workflow:

- while iterating on a TestFlight train, keep pending notes under `## Unreleased`
- before the production release, move or copy the final notes under `## <pinned version>` and run sync again

## Common commands

```bash
pnpm ios:version
pnpm ios:version:check
pnpm ios:version:sync
pnpm ios:version:pin -- --from-gateway
pnpm ios:version:pin -- --version 2026.4.10
```

## Normal TestFlight iteration workflow

1. keep `apps/ios/version.json` pinned to the current TestFlight train version
2. update `apps/ios/CHANGELOG.md` under `## Unreleased` while iterating
3. upload more betas with the usual flow
4. let Fastlane increment only `CFBundleVersion`

This keeps the TestFlight version stable while review is in flight.

## New release promotion workflow

When you want the next production iOS release to align with the current gateway release:

1. pin iOS from the root gateway version:

```bash
pnpm ios:version:pin -- --from-gateway
```

2. review the generated changes in:
   - `apps/ios/version.json`
   - `apps/ios/Config/Version.xcconfig`
   - `apps/ios/fastlane/metadata/en-US/release_notes.txt`
3. update `apps/ios/CHANGELOG.md` for the new release if needed
4. run `pnpm ios:version:sync` again if the changelog changed
5. submit the first TestFlight build for that newly pinned version
6. keep iterating only by build number until the release candidate is ready
7. release that reviewed TestFlight build to production

## Important invariant

Fastlane and Xcode should consume only the pinned iOS version from `apps/ios/version.json`.

Changing `package.json.version` alone must not change the iOS app version until a maintainer explicitly runs the pin step.
