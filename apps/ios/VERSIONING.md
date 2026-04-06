# OpenClaw iOS Versioning

OpenClaw iOS now uses its own version source, changelog, and release-note flow instead of deriving versions from the gateway release in root `package.json`.

## Goals

- version iOS independently from the gateway and npm package
- use semantic-version syntax for the canonical iOS version
- keep Apple bundle versions valid for App Store Connect
- generate App Store release notes from an iOS-owned changelog
- keep local build, Xcode, and Fastlane flows aligned

## Version model

Canonical iOS versions live in `apps/ios/version.json`.

Supported formats:

- stable: `x.y.z`
- beta: `x.y.z-beta.N`

Apple bundle mapping:

- canonical iOS version: `1.2.3-beta.4`
- `CFBundleShortVersionString`: `1.2.3`
- `CFBundleVersion`: numeric build number only

`CFBundleShortVersionString` stays Apple-compatible while the repo keeps the richer canonical version in `apps/ios/version.json`.

## Migration note

The initial migrated iOS version stays at `2026.4.6` so the repo can decouple version ownership without forcing an immediate App Store/TestFlight version reset.

## Source of truth and generated files

### Source files

- `apps/ios/version.json`
  - canonical iOS version source of truth
- `apps/ios/CHANGELOG.md`
  - iOS-only release history and release-note source
- `apps/ios/VERSIONING.md`
  - workflow, constraints, and ownership docs

### Generated or derived files

- `apps/ios/Config/Version.xcconfig`
  - checked-in default iOS version values derived from `apps/ios/version.json`
- `apps/ios/fastlane/metadata/en-US/release_notes.txt`
  - generated from `apps/ios/CHANGELOG.md`
- `apps/ios/build/Version.xcconfig`
  - local, gitignored build override generated per build or beta prep

## File-by-file implementation checklist

### Version parsing and sync tooling

- `scripts/lib/ios-version.ts`
  - validates the canonical iOS version
  - derives Apple marketing version
  - renders checked-in xcconfig and release notes
- `scripts/ios-version.ts`
  - CLI for JSON, shell, or single-field version reads
- `scripts/ios-sync-versioning.ts`
  - syncs checked-in derived files from the iOS version source

### Build and beta flow

- `scripts/ios-write-version-xcconfig.sh`
  - reads the canonical iOS version instead of root `package.json`
  - still owns the numeric local/build override file in `apps/ios/build/Version.xcconfig`
- `scripts/ios-beta-prepare.sh`
  - prepares beta signing and bundle settings against the iOS-owned version
- `apps/ios/fastlane/Fastfile`
  - resolves version metadata from the iOS helper instead of duplicating gateway version parsing

### Xcode and metadata surfaces

- `apps/ios/Config/Version.xcconfig`
  - checked-in defaults derived from `apps/ios/version.json`
- `apps/ios/fastlane/metadata/en-US/release_notes.txt`
  - generated from the matching iOS changelog section
- `apps/ios/project.yml`
  - continues to consume `OPENCLAW_MARKETING_VERSION` and `OPENCLAW_BUILD_VERSION`

### Docs and developer workflows

- `apps/ios/README.md`
  - points to the iOS-owned version source and changelog
- `apps/ios/fastlane/SETUP.md`
  - documents versioning and release-note generation
- `apps/ios/fastlane/metadata/README.md`
  - documents generated release notes

## Release-note resolution order

When generating `apps/ios/fastlane/metadata/en-US/release_notes.txt`, the tooling reads the first available changelog section in this order:

1. exact canonical version, for example `## 1.2.3-beta.4`
2. marketing version, for example `## 1.2.3`
3. `## Unreleased`

## Common commands

```bash
pnpm ios:version
pnpm ios:version:sync
pnpm ios:version:check
```

## Normal version bump workflow

1. update `apps/ios/version.json`
2. add or update the matching section in `apps/ios/CHANGELOG.md`
3. run `pnpm ios:version:sync`
4. review the generated diff in:
   - `apps/ios/Config/Version.xcconfig`
   - `apps/ios/fastlane/metadata/en-US/release_notes.txt`
5. run the normal iOS build or beta flow
