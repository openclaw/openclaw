# OpenClaw iOS Versioning

OpenClaw iOS release uploads use an explicit CalVer release version. The
committed repo no longer has an iOS-only version manifest; release commands must
name the App Store train they are uploading to.

## Goals

- make App Store release intent explicit at upload time
- avoid stale committed iOS pins
- keep Apple bundle fields valid for App Store Connect
- keep normal local builds aligned with the current gateway release version
- generate App Store release notes from an iOS-owned changelog

## Version model

Release uploads require a version argument:

```bash
pnpm ios:release:upload -- --version 2026.6.11
```

Use `--build-number` when the build number is known or has been verified from
App Store Connect:

```bash
pnpm ios:release:upload -- --version 2026.6.11 --build-number 3
```

The release version must use `YYYY.M.D` CalVer, for example `2026.4.6` or
`2026.6.11`.

When no explicit release version is supplied to the version helper, iOS derives
its default version from root `package.json.version` after stripping supported
release suffixes:

- gateway `2026.4.10` -> iOS default `2026.4.10`
- gateway `2026.4.10-beta.3` -> iOS default `2026.4.10`
- gateway `2026.4.10-2` -> iOS default `2026.4.10`

## Apple bundle mapping

Release version `2026.6.11` maps to:

- `CFBundleShortVersionString = 2026.6.11`
- `CFBundleVersion = numeric build number only`

Fastlane can resolve the next build number by querying App Store Connect for the
explicit short version. Maintainers may still pass `--build-number` to make the
upload fully deterministic.

## Source of truth and generated files

### Source files

- `package.json`
  - default iOS version source for local builds and checked-in defaults
- explicit `--version`
  - release upload source of truth
- `apps/ios/CHANGELOG.md`
  - iOS-only changelog and release-note source
- `apps/ios/VERSIONING.md`
  - workflow and constraints

### Generated or derived files

- `apps/ios/Config/Version.xcconfig`
  - checked-in defaults derived from `package.json` or `pnpm ios:version:sync -- --version ...`
- `apps/ios/fastlane/metadata/en-US/release_notes.txt`
  - generated from `apps/ios/CHANGELOG.md`
- `apps/ios/build/Version.xcconfig`
  - local gitignored build override generated per build or release prep

## Tooling surfaces

- `scripts/lib/ios-version.ts`
  - validates iOS CalVer
  - normalizes gateway version -> iOS CalVer
  - renders checked-in xcconfig and release notes
- `scripts/ios-version.ts`
  - CLI for JSON, shell, or single-field version reads
  - accepts `--version YYYY.M.D` for explicit release queries
- `scripts/ios-sync-versioning.ts`
  - syncs checked-in derived files from the default or explicit iOS version
- `scripts/ios-write-version-xcconfig.sh`
  - writes the local numeric build override file in `apps/ios/build/Version.xcconfig`
- `scripts/ios-release-prepare.sh`
  - requires `--version` and prepares App Store distribution signing and bundle settings
- `apps/ios/fastlane/Fastfile`
  - resolves version metadata from the explicit release version
  - creates or verifies Developer Portal bundle IDs/services through Fastlane `produce`
  - syncs encrypted App Store signing assets with Fastlane `match`
  - resolves App Store Connect build numbers for the explicit short version when needed
  - uploads screenshots, release notes, and the rendered App Review PDF attachment before archiving

Agent-driven App Store uploads must use `pnpm ios:release:upload` as the only
release path. If that command fails, stop at the failing screenshot, metadata,
archive, validation, or upload step. Do not continue by archiving and uploading
manually with `pnpm ios:release:archive`, `asc builds upload`,
`asc release stage`, `asc publish appstore`, direct Fastlane lanes, or other App
Store Connect mutation commands.

## Release-note resolution order

When generating `apps/ios/fastlane/metadata/en-US/release_notes.txt`, the
tooling reads the first available changelog section in this order:

1. exact release version, for example `## 2026.6.11`
2. `## Unreleased`

Before production upload, prefer a final `## <release version>` section and run
sync with the same version:

```bash
pnpm ios:version:sync -- --version 2026.6.11
```

## Common commands

```bash
pnpm ios:version
pnpm ios:version -- --version 2026.6.11
pnpm ios:version:check
pnpm ios:version:sync -- --version 2026.6.11
pnpm ios:release:upload -- --version 2026.6.11 --build-number 3
```

## Normal TestFlight iteration workflow

1. choose the App Store release train explicitly, for example `2026.6.11`
2. update `apps/ios/CHANGELOG.md` under `## <release version>` or `## Unreleased`
3. run `pnpm ios:version:sync -- --version <release version>`
4. check App Store Connect for the latest build number when needed
5. upload another build with `pnpm ios:release:upload -- --version <release version> --build-number <next>`

This keeps the version decision at the release command instead of in a committed
state file.

## Release SHA tracking

Successful App Store Connect uploads create a non-tag Git ref that records the
source commit for the uploaded store build:

```text
refs/openclaw/mobile-releases/ios/<CFBundleShortVersionString>-<CFBundleVersion>
```

Example:

```text
refs/openclaw/mobile-releases/ios/2026.6.11-3
```

These refs are intentionally outside `refs/tags/*` and `refs/heads/*`. They do
not appear on GitHub release or tag pages, and they do not participate in the
core OpenClaw release machinery.

`pnpm ios:release:upload` checks the ref before archive/upload work and records
it only after `upload_to_testflight` succeeds. Existing refs are immutable: the
same ref at the same SHA is accepted, while the same ref at a different SHA
fails.

Do not create this ref after a manual fallback upload. The ref is release-lane
evidence, not a repair mechanism for a failed `pnpm ios:release:upload` run.

Useful direct commands:

```bash
pnpm mobile:release:preflight -- --platform ios --version 2026.6.11 --build 3
pnpm mobile:release:resolve -- --platform ios --version 2026.6.11 --build 3
```

## New release workflow

When you want the next production iOS release to align with the current gateway
release:

1. confirm the root gateway version:

```bash
node -e "console.log(require('./package.json').version)"
```

2. update `apps/ios/CHANGELOG.md` for that release
3. sync iOS generated files:

```bash
pnpm ios:version:sync -- --version 2026.6.11
```

4. verify live App Store Connect state and choose the next build number
5. upload with explicit release intent:

```bash
pnpm ios:release:upload -- --version 2026.6.11 --build-number 3
```

6. manually submit the reviewed build for App Review in App Store Connect
7. release the approved build to production

## Important invariant

App Store uploads must carry explicit version intent. Do not infer a release
train from checked-in generated files.

App Review submission remains manual. Automation may create/update the editable
App Store version, upload screenshots, upload release notes, upload the App
Review PDF attachment, and upload builds, but it should not upload the App
Store Connect `Notes` field or submit a build for review.

For agent-driven releases, a failed `pnpm ios:release:upload` is terminal for
that attempt. Agents must report the failed step and wait for maintainer
direction instead of switching to lower-level App Store Connect upload or
submission commands.
