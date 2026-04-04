# MEMORY.md - Max

## Seat Mandate

- Max is the implementation owner, system repair lead, and infrastructure stabilizer for the OpenClaw Company runtime.
- Max turns technical ambiguity into diagnosis, fixes, verification, and runbooks.
- Max does not confuse "implemented" with "verified".

## Core Outputs

- code
- repair note
- runbook
- verification
- remaining risk summary

## Standard Response Shape

- Symptom
- Scope or path
- Fix or plan
- Verification
- Remaining risk

## Collaboration Map

- Pull `Arthur` when delivery sequence or ownership must change.
- Pull `Cyrus` when product scope or acceptance is still ambiguous.
- Pull `Gaga` when implementation needs design precision.
- Pull `Aiden` for QA, security review, and release gates.
- Pull `Edison` for external platform, permission, or compliance exposure.
- Escalate hard tradeoff calls to `KAISER`.

## Operating Rules

- No repro, no real fix.
- No verification, no closure.
- Prefer small, reversible changes.
- Automate repeat toil.
- Cross-seat handoffs in Discord must `@mention` the target seat.

## Current Product Directive

- The active release priority is GitHub first.
- Current user instruction: ship the GitHub surface first, continue Apple hardening in parallel, and do not falsely present the App Store path as already public.
- Current launch-scope refinement:
  - do not ship the Watch companion in this window
  - ship the App + GitHub path together
  - keep Watch targets in repo only as future work, not as a current release blocker
- Current implementation direction for environment variance:
  - prefer runtime self-detection plus adaptive defaults
  - avoid shipping different install packages per user/environment unless platform signing or entitlements make that unavoidable
  - for iOS specifically, treat signing, entitlements, push transport mode, and other build-time constraints as non-adaptive at runtime
- Current outward branding directive:
  - user-visible Apple branding should be `VeriClaw 爪印`
  - keep technical compatibility identifiers on `ai.vericlaw.*` unless a release constraint requires a narrower exception
- Current interaction directive:
  - freeze the interaction work produced in session `019d3825-4d57-7d72-a65c-6225857638c5`
  - do not let parallel sessions redesign, restyle, or overwrite that interaction pass without explicit user approval
  - preserve that session's `Summary / Seats needing attention / Detail / intervention` structure and send-confirmation flow unless the user explicitly reopens the scope
  - preserve that session's Apple-native visual direction and the warm sand `#eacda2` plus warm charcoal `#0e1011` palette alignment with the current logo
  - protected interaction surfaces for this freeze include `ui/src/ui/views/overview.ts`, `ui/src/ui/views/overview-cards.ts`, `ui/src/ui/views/overview-attention.ts`, `ui/src/ui/views/chat.ts`, `ui/src/ui/app-render.ts`, `ui/src/styles/components.css`, `ui/src/styles/chat/layout.css`
- Current correction-product directive from session `019d346c-c72f-77d1-83ec-5b36dbfb5e91`:
  - the app must not stop at alerting; it must perform real-time correction
  - use case-based precise correction as the product skeleton
  - augment that skeleton with professional-role contracts so the app can label
    occupational-role drift for named bots or seats
  - keep a per-bot medical record or casebook in OpenClaw storage
  - every active issue should resolve to evidence -> diagnosis -> prescription -> verification -> casebook update
  - where possible, diagnosis should also explain which professional-role
    boundary was crossed and what that role owes the team next
  - reusable correction templates must be empirically validated before promotion
  - template promotion standard:
    - at least three successful rounds across different bots before becoming a candidate template
    - once three candidates exist, test against a temporary randomized bot
    - three clean synthetic passes are required
    - any failed round disqualifies universal promotion
  - treat the approved `019d3825` UI as the native shell for the `019d346c` correction engine, not as a separate product
  - reference `CASE_BASED_CORRECTION_WORKSPACE.md` before changing app architecture or correction flows
- Current legal/release directive:
  - release materials should include a fuller IP protection pack, not just a single LICENSE file
  - allow forwarding/redistribution only when attribution, citation/origin link, copyright notice, and license/notice text are preserved
  - mimic common GitHub commercial/source-available practice: root LICENSE + NOTICE/ATTRIBUTION + trademark policy + patent position + takedown/enforcement instructions
- Current verified technical state:
  - Discord reconnect watchdog evidence chain is verified end-to-end at code/test level
  - timeout metadata now propagates into lifecycle error/status output
  - related regression tests are passing
  - first-use UX pass now strengthens the native shell:
    - Control uses a state-based `Start here` primary action instead of leaving all entry points equally weighted
    - Cases now surfaces a visible closed-loop strip for evidence -> diagnosis -> prescription -> verify -> casebook
    - hover widget now surfaces active case count and pending synthetic validation count
  - first-use UX audit doc:
    - `docs/design/first-use-ux-iteration.md`
  - market differentiation doc:
    - `docs/launch/market-differentiation.md`
  - macOS package tests now pass through the Xcode toolchain wrapper (`pnpm mac:test`): 436 tests across 108 suites green
  - the latest macOS release-gate repairs also closed two concrete regressions:
    - `ExecApprovalsStore.ensureFile()` now compares encoded on-disk bytes before rewriting, which stabilizes the no-op save path
    - `TalkAudioPlayer` now resolves stalled playback when the player stops without delivering the expected finish callback
  - current verification nuance:
    - a non-clean `pnpm mac:test` rerun did pass again at `436 tests / 108 suites`
    - subsequent clean rebuild attempts are noisy because Swift sometimes aborts with `input file ... was modified during the build` on live macOS source files; this looks like external workspace churn rather than a deterministic source-level compiler error
- Current release-gate concerns still open on the App side:
  - repository-side Apple blockers that were previously open are now closed:
    - the current Apple release gate no longer depends on Watch screenshot or watch asset-catalog closure for this ship point
    - `apps/ios/README.md` now describes the app as `Pre-Release Hardening`, not `Super Alpha`
    - full Xcode is available locally and wrapper scripts resolve it correctly even when `xcode-select` still points to CommandLineTools
    - `xcodegen` is installed locally
    - `pnpm release:apple:repo-check` is green
    - App Review contact files under `apps/ios/fastlane/metadata/review_information/` are now templated in repo and injected locally from `apps/ios/fastlane/.env`
  - remaining observed Apple environment blockers:
    - the signed-in Xcode Apple ID currently exposes only the free Personal Team `NU53Q73GR3` (`Jingting Yao (Personal Team)`)
    - the configured release Team `Y5PE65HELJ` is not available to the current Xcode account on this Mac
    - `security find-identity -p codesigning -v` now reports `1 valid identities found`, specifically `Apple Development: 820628124@qq.com (XUT4398C9A)`
    - the presence of that identity does not close the release gate because Xcode account/team linkage for `Y5PE65HELJ` is still missing
    - App Store Connect API auth is not configured yet
    - `apps/ios/fastlane/.env` now exists locally as a git-ignored scaffold, but real Team / ASC / review-contact values are still missing
  - current Apple readiness commands:
    - `pnpm release:apple:check`
    - `pnpm release:apple:submit-check`
    - `pnpm release:apple:repo-check`
    - `pnpm mac:test`
    - `pnpm ios:doctor`
    - `pnpm ios:review:local-check`
    - `pnpm ios:review:preview`
  - runtime progress update:
    - an iOS simulator runtime/device is available locally
    - `./scripts/resolve-ios-simulator.sh --json` now resolves `iPhone 17 Pro`
    - `pnpm ios:doctor` runtime gate is now green after fixing its simulator detection logic
    - App Review metadata can now be rendered locally into `apps/ios/build/app-store-metadata-preview` before any ASC upload
    - local review preflight now flags copied placeholder review-contact values for the current iPhone submission path
  - latest concrete device-build evidence from Xcode app automation:
    - simulator build enters real compilation and writes DerivedData products
    - device build fails with `No Account for Team "Y5PE65HELJ"` for the local signing override
    - Xcode preferences expose only `NU53Q73GR3` (`Jingting Yao (Personal Team)`) for the signed-in Apple ID, confirming the release Team `Y5PE65HELJ` is not actually accessible on this Mac
    - the same device build also reports missing iOS App Development provisioning profiles for:
      - `ai.openclaw.ios.test.alma-y5pe65helj`
      - `ai.openclaw.ios.test.alma-y5pe65helj.share`
      - `ai.openclaw.ios.test.alma-y5pe65helj.activitywidget`
      - `ai.openclaw.ios.test.alma-y5pe65helj.watchkitapp`
      - `ai.openclaw.ios.test.alma-y5pe65helj.watchkitapp.extension`
    - `security find-identity -p codesigning -v` now returns `1 valid identities found`
    - `defaults read com.apple.dt.Xcode IDEProvisioningTeams` is still empty
  - Apple closure runbook:
    - `docs/platforms/apple-release-readiness.md`

## Discord Mention Handles

- `KAISER / HQ`: `<@1486750046702796902>`
- `Arthur`: `<@1486791463831605279>`
- `Cyrus`: `<@1486792391896858664>`
- `Gaga`: `<@1486793283693973535>`
- `Cooper`: `<@1486794177277726932>`
- `Kevin`: `<@1486794424422760648>`
- `Aiden`: `<@1486796048297889953>`
- `VIVI`: `<@1486796443342864384>`
- `Edison`: `<@1486796755122262040>`
- `Max`: this workspace is Max. Other bots wake Max by posting in `dept-max-engineering` and mentioning `KAISER / HQ`.
