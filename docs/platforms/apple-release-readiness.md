---
summary: "Repository and local-environment closure steps for the synchronized GitHub + App Store ship gate"
read_when:
  - Preparing the Apple side for synchronized launch
  - Closing iOS or macOS release blockers
  - Handing off Apple release work between Engineering, QA, and release operators
title: "Apple Release Readiness"
---

# Apple release readiness

This runbook is the shortest path from the current state to an Apple-side ship
decision for the synchronized GitHub + App Store launch.

Scope:

- iOS app
- macOS app packaging and package-level test health
- Watch targets may remain in the repo for later, but they are excluded from the
  current synchronized launch gate

Observed status on 2026-04-04:

- `pnpm release:apple:repo-check` passed
- `pnpm mac:test` passed with `436 tests` across `108 suites`
- `pnpm ios:gen` passed and generated `apps/ios/OpenClaw.xcodeproj`
- `pnpm ios:doctor` is still blocked by `2` local Apple environment failures
- App Review contact files in `apps/ios/fastlane/metadata/review_information/`
  are now stored as repo templates and must be injected locally via
  `apps/ios/fastlane/.env` when running `fastlane ios metadata`
- Local Apple machine observations:
  - `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` resolves correctly through the wrapper scripts
  - `xcode-select` still points to CommandLineTools, but the local Apple scripts override it safely
  - `xcodegen` is installed
  - `fastlane` is installed
  - at least one iOS simulator runtime/device is available and `ios:doctor` auto-selects `iPhone 17 Pro`
- `apps/ios/fastlane/.env` now exists locally as a git-ignored scaffold, but the ASC/auth and App Review values are still not filled in
  - the signed-in Xcode Apple ID currently exposes only `NU53Q73GR3` (`Jingting Yao (Personal Team)`)
  - the configured release team `Y5PE65HELJ` is not available to the current Xcode account on this Mac
  - `security find-identity -p codesigning -v` now reports `1 valid identities found`
  - the currently visible local signing identity is `Apple Development: 820628124@qq.com (XUT4398C9A)`, which does not close the release-team access gap for `Y5PE65HELJ`

Current `ios:doctor` failures on 2026-04-03:

- the signed-in Xcode account does not have access to the configured release Team `Y5PE65HELJ`
- App Store Connect API auth not configured

Observed state on this Mac on 2026-04-04 after re-check:

- `pnpm ios:doctor` still fails with the same two environment blockers
- `bash scripts/ios-team-id.sh` still reports that only the free Personal Team
  `NU53Q73GR3` is visible in Xcode on this Mac
- local signing still pins `Y5PE65HELJ` in `apps/ios/.local-signing.xcconfig`,
  which confirms repo-side intent but does not prove Xcode account access
- `apps/ios/fastlane/.env` is still only a scaffold and does not yet contain ASC
  auth values
- `pnpm ios:review:preview` is now available to render the App Review contact
  metadata into `apps/ios/build/app-store-metadata-preview` without uploading
  anything to App Store Connect

## Ownership

One person can hold multiple roles, but the work should still be tracked with
these owners:

- `Max / Engineering`
  Owns repository-side fixes, wrapper scripts, validation commands, and any
  source-level blocker that appears after the Apple environment is repaired.
- `Apple machine owner / release operator`
  Owns local Xcode installation, simulator/runtime installation, and local
  reruns of the Apple gate commands.
- `Apple account admin`
  Owns Xcode account login, Team ID access, certificates, and provisioning
  prerequisites.
- `App Store Connect admin`
  Owns ASC API key creation, storage, and rotation.
- `Aiden / QA release gate`
  Owns final rerun of the Apple gate and confirms the Apple side is strong
  enough to stay aligned with the GitHub ship point.

## Final gate command

Use this command as the compact Apple readiness gate:

```bash
pnpm release:apple:check
```

It expands to:

```bash
pnpm release:apple:repo-check && pnpm mac:test && pnpm ios:doctor
```

Interpretation:

- if `release:apple:repo-check` fails, the blocker is repository content
- if `mac:test` fails, the blocker is macOS source or toolchain behavior
- if `ios:doctor` fails, the blocker is local Apple environment, signing, or
  App Store Connect setup

Use this command as the compact submission-side gate on the actual release Mac:

```bash
pnpm release:apple:submit-check
```

It expands to:

```bash
pnpm release:apple:check && pnpm ios:review:local-check && pnpm ios:review:preview
```

Interpretation:

- if `release:apple:check` fails, the blocker is still repository content,
  macOS source/toolchain, or Apple local environment
- if `ios:review:local-check` fails, the blocker is missing or placeholder local
  ASC/App Review input
- if `ios:review:preview` fails, the blocker is metadata token injection or
  malformed local review-contact values

Operator-side metadata preflight before any metadata upload:

```bash
pnpm ios:review:local-check
pnpm ios:review:preview
```

Interpretation:

- if `ios:review:local-check` fails, the blocker is missing or placeholder local
  App Review/ASC input
- if `ios:review:preview` fails, the blocker is metadata token injection or
  missing review-contact values
- if both pass, the local metadata payload is readable enough to stage into
  `fastlane deliver`

## Step 1: install the required iOS runtime

Owner:
`Apple machine owner / release operator`

Where:
`Xcode -> Settings -> Components`

Action:

1. Install the `iOS 26.4` simulator/runtime that matches the current Xcode
   project expectations.
2. Keep the full Xcode app installed at `/Applications/Xcode.app`.
3. On this machine, prefer the Xcode UI path. A direct CLI attempt with
   `xcodebuild -downloadPlatform iOS -buildVersion 26.4` returned
   `iOS 26.4 is not available for download`.

Verify:

```bash
./scripts/resolve-ios-simulator.sh --json
pnpm ios:doctor
```

Pass condition:

- `resolve-ios-simulator.sh` returns a device JSON payload
- `ios:doctor` no longer reports `iOS 26.4 is not installed`

## Step 2: resolve the Apple Team ID locally

Owner:
`Apple account admin`

Where:

- `Xcode -> Settings -> Accounts`
- optionally `apps/ios/fastlane/.env`
- bootstrap example: `apps/ios/fastlane/.env.example`

Action:

1. Sign into Xcode with the Apple Developer account that should own the release.
2. Confirm the account is attached to the intended Apple Developer team, not only a free `Personal Team`.
3. If needed, set `IOS_DEVELOPMENT_TEAM=YOUR_TEAM_ID` in the Fastlane env.
4. Treat `apps/ios/.local-signing.xcconfig` only as a local build override. It can pin a Team ID for build settings, but it does not replace Xcode persisting the Apple account/team mapping on the release Mac.
5. After the correct Team becomes visible in Xcode, run `./scripts/ios-configure-signing.sh` once so the local git-ignored signing override refreshes to that Team.

Helpful command:

```bash
bash scripts/ios-team-id.sh
```

Helper behavior:

- it prefers the configured release Team when that Team is available locally
- if the preferred Team has changed and exactly one other non-free Team is visible in Xcode, it falls back to that Team automatically
- if multiple non-free Teams are visible and the preferred Team is missing, set `IOS_DEVELOPMENT_TEAM` explicitly

Verify:

```bash
bash scripts/ios-team-id.sh
pnpm ios:doctor
```

Pass condition:

- `ios-team-id.sh` prints the intended release Team ID
- `ios:doctor` no longer reports that the configured Team is unavailable in the signed-in Xcode account
- the Apple Developer account page no longer shows the purchase-processing banner, and backend calls return at least one active team

Observed failure mode on this Mac:

- A direct Xcode device build for `OpenClaw` with the local team override still failed with:
  - `No Account for Team "Y5PE65HELJ"`
  - missing development provisioning profiles for the local bundle IDs under `ai.openclaw.ios.test.alma-y5pe65helj*`
- Xcode preferences now confirm the signed-in Apple ID exposes only `NU53Q73GR3` (`Jingting Yao (Personal Team)`), so the configured release team `Y5PE65HELJ` is not available on this Mac.
- This means the local `.local-signing.xcconfig` override is present, but the signed-in Xcode account is still not attached to that Apple Developer team on this machine.
- Do not treat the local override as proof that Xcode account linkage is ready.

## Step 3: install valid code-signing identities

Owner:
`Apple account admin`

Where:

- Xcode certificate management
- macOS Keychain

Action:

1. Create or import the required Apple signing certificates.
2. Make sure the certificates appear in the current user Keychain on the
   release Mac.
3. Prefer the identities needed for iOS release workflows and macOS signing
   workflows; do not rely on ad-hoc signing for release.

Verify:

```bash
security find-identity -p codesigning -v
pnpm ios:doctor
```

Pass condition:

- `security find-identity -p codesigning -v` reports at least one valid identity
- `ios:doctor` no longer reports `No valid code signing identities found in Keychain`

Observed failure mode on this Mac:

- Keychain now reports `1 valid identities found`, including `Apple Development: 820628124@qq.com (XUT4398C9A)`.
- This step is materially improved, but the Apple gate is still blocked because Xcode account/team linkage for `Y5PE65HELJ` is not ready and App Store Connect API auth is still missing.
- Fix the account/team linkage first, then confirm the release-relevant certificates and provisioning assets are available on the release Mac.

## Step 4: configure App Store Connect API auth

Owner:
`App Store Connect admin`

Where:

- `App Store Connect -> Users and Access -> Keys -> App Store Connect API`
- local Keychain or `apps/ios/fastlane/.env`
- bootstrap example: `apps/ios/fastlane/.env.example`

Action:

1. Generate or retrieve the ASC API key.
2. Store the `.p8` securely on the release Mac.
3. Run the repo helper to write the non-secret values and store the secret in
   Keychain:

```bash
scripts/ios-asc-keychain-setup.sh \
  --key-path /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --issuer-id YOUR_ISSUER_ID \
  --write-env
```

Verify:

```bash
cd apps/ios
../../scripts/with-xcode-developer-dir.sh fastlane ios auth_check
cd ../..
pnpm ios:review:local-check
pnpm ios:review:preview
pnpm ios:doctor
```

Pass condition:

- Fastlane reports `App Store Connect API auth loaded successfully`
- `ios:doctor` no longer reports a missing ASC API key

If you are preparing metadata for first submission, also set these local
Fastlane env vars before running `fastlane ios metadata`:

```bash
IOS_APP_REVIEW_FIRST_NAME=YOUR_FIRST_NAME
IOS_APP_REVIEW_LAST_NAME=YOUR_LAST_NAME
IOS_APP_REVIEW_EMAIL=YOUR_REVIEW_EMAIL
IOS_APP_REVIEW_PHONE=+1 415 555 0101
IOS_APP_REVIEW_NOTES_APPEND=PAIRING_OR_DEMO_ACCOUNT_DETAILS_FOR_THIS_SUBMISSION
```

These values are injected into a staged metadata directory under
`apps/ios/build/app-store-metadata`; they should not be committed directly into
the repository. For this app, `IOS_APP_REVIEW_NOTES_APPEND` should contain the
actual test-gateway, pairing, or demo-account path App Review needs to exercise
the full flow.

Local metadata preflight:

```bash
pnpm ios:review:local-check
```

## Step 5: rerun the compact Apple environment gate

Owner:
`Aiden / QA release gate` with `Max / Engineering`

Run:

```bash
pnpm release:apple:check
```

Pass condition:

- repository-side Apple check passes
- macOS package tests pass
- iOS doctor passes with no failures

## Step 6: rerun the compact Apple submission gate

Only do this on the actual submission Mac after Step 5 is green.

Run:

```bash
pnpm release:apple:submit-check
```

Pass condition:

- `release:apple:check` stays green
- local App Review contact values are present and do not look copied from the
  scaffold
- staged metadata preview renders successfully into
  `apps/ios/build/app-store-metadata-preview`

## Step 7: perform post-gate smoke validation

Only do this after Step 6 is green.

Run:

```bash
pnpm ios:beta:prepare
pnpm ios:beta:archive -- --build-number 1
scripts/package-mac-app.sh
```

Interpretation:

- if `ios:beta:prepare` fails, the Apple environment is still not fully closed
- if local archive/export fails, the App Store path is not ready yet
- if mac packaging/signing fails, the Apple synchronized ship point is still not
  ready

## What is already closed

These were previously blockers and are no longer the main issue:

- the current release gate no longer treats Watch-specific screenshots or watch
  asset catalogs as blockers for this ship point
- the iOS README no longer calls the app `Super Alpha`
- the repo has local Xcode wrapper scripts and a repo-side Apple readiness check
- macOS package tests pass when run through the full Xcode toolchain wrapper

## Decision rule

Do not call Apple ready just because the repo looks good.

Apple is only considered aligned with the GitHub ship point when all of the
following are true at the same time:

- `pnpm release:apple:check` is green
- `pnpm release:apple:submit-check` is green
- local iOS beta prepare/archive can complete
- macOS packaging can complete
- no new signing, entitlement, or App Store Connect issue appears during those
  smoke runs
