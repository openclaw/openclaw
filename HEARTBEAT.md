# HEARTBEAT.md

- Check `dept-max-engineering` first when operating as Max.
- Check incident or shared company lanes where technical help is requested.
- If directly mentioned or a technical blocker is clearly waiting on Engineering, answer or hand off.
- If there is no real technical action to take, reply `HEARTBEAT_OK`.

## Current Shared Context

- Current launch priority is GitHub first. Apple App Store hardening continues in parallel, but GitHub is the present public release surface.
- Do not describe the Apple path as publicly live until the Apple gates actually close.
- Current synchronized launch scope excludes the Watch companion. Ship the App +
  GitHub path without making watchOS materials a release blocker; keep Watch
  code only as future work.
- Watchdog evidence chain for the Discord reconnect path is closed at code/test level: timeout meta -> lifecycle status/error -> forceStop -> cleanup has been verified.
- Current product freeze: the app must be a native case-based correction workspace, not just a watchdog dashboard.
- Correction diagnosis now needs a second layer: professional-role contract plus
  role-drift assistance, especially for named multi-agent bots.
- Preserve both approved directions together:
  - session `019d346c-c72f-77d1-83ec-5b36dbfb5e91` defines the correction engine and template-validation loop
  - session `019d3825-4d57-7d72-a65c-6225857638c5` defines the approved Apple-native logo and interaction shell
- Required correction loop: evidence -> diagnosis -> prescription -> per-bot casebook -> template validation -> promotion only after repeated success.
- Shared implementation note: see `CASE_BASED_CORRECTION_WORKSPACE.md`.
- Outward Apple-facing branding is `VeriClaw 爪印`; keep runtime/package compatibility on `ai.vericlaw.*` unless a build-time requirement forces a different exception.
- Environment adaptation should use one package/app with runtime environment probing and adaptive defaults, not per-user package forks, except where Apple signing/entitlements force build-time divergence.
- Before calling the synchronized launch "ready", require Apple-specific checks: `pnpm release:apple:check` plus `pnpm release:apple:submit-check`.
- Apple closure runbook: `docs/platforms/apple-release-readiness.md`.
- Current Apple verification state:
  - repo-side icon/catalog and README blockers are closed
  - App Review contact metadata is now templated in git and injected locally via `apps/ios/fastlane/.env` during `fastlane ios metadata`
  - local operator preflight now includes `pnpm ios:review:local-check` plus `pnpm ios:review:preview`
  - `ios:review:local-check` now rejects obvious copied placeholder review-contact values for the current iPhone submission path
  - `ios:review:preview` renders staged local App Review metadata into `apps/ios/build/app-store-metadata-preview` without uploading anything
  - macOS first-use UX is now stronger:
    - Control hero exposes a state-based `Start here` action
    - Cases detail exposes a visible closed-loop stage strip
    - the hover widget exposes active case and pending-trial counts
  - first-use UX audit doc: `docs/design/first-use-ux-iteration.md`
  - market differentiation doc: `docs/launch/market-differentiation.md`
  - macOS package tests pass under the Xcode toolchain wrapper (`pnpm mac:test`: 436 tests across 108 suites)
  - latest macOS test repairs now include:
    - `ExecApprovalsStore.ensureFile()` skips redundant rewrites by comparing the actual encoded file bytes before saving
    - `TalkAudioPlayer` now closes stalled playback when `AVAudioPlayer` stops without delivering the expected delegate callback
  - latest verification caveat:
    - a non-clean `pnpm mac:test` pass is still green at `436 tests / 108 suites`
    - clean rebuild attempts are currently noisy because Swift sometimes aborts with `input file ... was modified during the build` on active macOS source files such as `ControlDashboardView.swift`, `HoverHUD.swift`, or `MenuContentView.swift`
  - an iOS simulator runtime/device is available locally; `resolve-ios-simulator.sh --json` resolves a concrete simulator destination
  - `pnpm release:apple:repo-check` passes
  - remaining observed local blockers are release-team access in Xcode and App Store Connect API auth
  - `apps/ios/fastlane/.env` now exists locally as a git-ignored scaffold, but it still needs real Team / ASC / review-contact values
  - Xcode preferences now show the signed-in Apple ID only has access to `NU53Q73GR3` (`Jingting Yao (Personal Team)`), while the configured release Team `Y5PE65HELJ` is unavailable on this Mac
  - `security find-identity -p codesigning -v` now reports `1 valid identities found` (`Apple Development: 820628124@qq.com (XUT4398C9A)`)
  - latest concrete Xcode device-build failure on this Mac is `No Account for Team "Y5PE65HELJ"` plus missing development profiles for the local `ai.openclaw.ios.test.alma-y5pe65helj*` bundle IDs
  - global `xcode-select` may still point at CommandLineTools, but local wrapper scripts resolve full Xcode correctly
- Release/legal pack must include copyright and patent protection materials. Forwarding/redistribution may be allowed, but only with preserved attribution/citation/origin notices. Model the structure after commercial/source-available GitHub repos: root LICENSE plus NOTICE/attribution, trademark policy, and clear takedown/enforcement path.
