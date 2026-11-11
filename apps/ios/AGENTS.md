# iOS app

## UI / Typography

- iOS SwiftUI text should use branded typography helpers, not bare system fonts. Use `OpenClawType` in `apps/ios/Sources/**`, `OpenClawChatTypography` in shared chat UI, `WatchClawType` in watch UI, and `OpenClawActivityType` in Live Activity UI.
- Apply branded fonts at the rendered text/control boundary when practical: `Text`, `Label`, `Button` labels, picker options, menu items, alert text/buttons, row titles/subtitles, placeholder overlays, chips, badges, and toolbar actions. Do not rely on distant parent `.font(...)` inheritance for user-visible text when a local modifier is cheap and clear.
- Avoid shorthand controls like `Button("Title")`, `Link("Title", ...)`, `TextField("Placeholder", ...)`, and `SecureField("Placeholder", ...)` when they make typography or placeholder styling implicit. Prefer explicit label builders with branded `Text`/`Label`.
- Secure-field placeholders need both branded visual styling and accessibility semantics. If using an overlay placeholder, keep the actual field semantically named with `.accessibilityLabel(...)` and hide the decorative placeholder from accessibility.
- System font modifiers are acceptable for SF Symbol `Image(systemName:)` sizing, not for user-visible text unless a platform control makes branded typography impossible. If an exception is intentional, keep it narrow and explain why.
- The typography scanner in `apps/ios/Tests/OpenClawTypographyTests.swift` enforces this rule across iOS sources (no per-surface pins to update); when touching iOS text surfaces, run the focused typography test.

## Concurrency

- Callbacks handed to Apple or third-party APIs must be `@Sendable` unless the API guarantees main-queue delivery. In `@MainActor` code, a closure literal passed to a callback parameter that is not `@Sendable` inherits main-actor isolation, and Swift 6 traps when the API calls it on another queue (the speech-permission crash fixed in #196822). Write `{ @Sendable ... in }` or build the closure in a `nonisolated` function, and hop back with `Task { @MainActor in ... }`. The SDK header states whether a callback is `NS_SWIFT_SENDABLE` and which queue calls it.
- Permission prompts go through `PermissionRequestBridge`: it checks the request is still current right before the OS prompt starts, resumes exactly once, and resumes on cancel. Apple's async permission APIs hop off the main actor before starting the prompt, which breaks that check.

## Licenses Screen

- Maintain the Settings Licenses screen when iOS app dependencies change.
- Bundled license files live in `apps/ios/Resources/Licenses/`.
- License files: UTF-8 `.txt`, each named after the dependency (`WebRTC.txt`).
- Do not add OpenClaw, OpenClaw Foundation, or other first-party/self-owned license entries. The screen is for third-party/open-source dependency acknowledgements.
- When adding, removing, or upgrading iOS dependencies, audit whether `apps/ios/Resources/Licenses/` needs updates.
- When adding, removing, or replacing redistributed font binaries under `apps/ios/Sources/Fonts/`, update `apps/ios/THIRD_PARTY_FONTS.md` with immutable upstream source URLs and SHA-256 checksums for each bundled file.
- Keep license detail bodies rendered as verbatim monospace text.
- Keep Licenses in the offline Settings fallback's Device section and in the Dashboard's This iPhone/This iPad page through the native bridge panel.
- When changing license loading or presentation, update `apps/ios/Tests/LicenseDocumentLoaderTests.swift` and `apps/ios/Tests/SwiftUIRenderSmokeTests.swift`, then run focused iOS tests.

## App Store and TestFlight Releases

- Agent-driven iOS uploads must use only `pnpm ios:release:upload`. The default destination is App Store staging; `--destination testflight` distributes to the configured external TestFlight group without staging the App Store listing.
- Run **iOS Store Release** from `main` with operation `release` or `testflight`, or use the matching `pnpm ios:release:upload` destination locally. The release entry point owns live planning, generated notes, the unchanged source SHA, upload, and staging of the processed build. It saves notes as an immutable artifact and does not edit tracked files or create preparation commits or metadata PRs.
- The planner derives the gateway version from root `package.json`. App Store staging reuses the one editable revision for that gateway, retries an unreleased revision found in App Store Connect build-upload history, and allocates the next revision only after released history. Historical exact gateway versions consume revision zero.
- Do not infer release identity from the current date, mobile-release refs, or generated local files.
- If `pnpm ios:release:upload` exits non-zero, stop immediately and report the failing step.
- After a failed `pnpm ios:release:upload`, do not continue with a lower-level upload path. For an already processed upload whose notes, build selection, or TestFlight distribution failed, use `node scripts/mobile-release.mjs stage --platform ios --recovery-dir DIR` with its saved artifacts; this must never reupload or regenerate notes. Otherwise inspect and reconcile App Store Connect state before another upload attempt.
- Daily TestFlight runs use the `ios-testflight` environment, the configured external group ID, and existing beta metadata. Submit for TestFlight beta review when required and enable automatic tester notification; preserve pending reviews and use saved-artifact recovery for partially completed distribution. See [TestFlight distribution](VERSIONING.md#testflight-distribution).
- Do not submit an iOS App Store version for App Review. App Review submission stays manual unless the user explicitly asks to submit a specific already-prepared version after the failed state has been reported.
- `pnpm ios:release:archive` is for local archive validation only. It is not a fallback release path after screenshot, metadata, or upload-lane failure.
