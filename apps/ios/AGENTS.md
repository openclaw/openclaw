# iOS Release Agent Policy

Root rules still apply. This file adds the iOS release guardrails.

## Licenses Screen

- Maintain the Settings-tab Licenses screen when iOS app dependencies change.
- Bundled license files live in `apps/ios/Resources/Licenses/`.
- License files must be UTF-8 `.txt` files. Do not add Markdown, HTML, RTF, or generated plist license content.
- The Licenses screen discovers bundled `.txt` files at runtime through `LicenseDocumentLoader`; do not hardcode individual license rows in Swift.
- License rows are ordered alphabetically in code by derived display title. Do not use numeric filename prefixes for ordering.
- Filenames should be plain dependency names, for example `WebRTC.txt`; the filename is used only to derive the row title and must not be shown as a row subtitle.
- Do not add OpenClaw, OpenClaw Foundation, or other first-party/self-owned license entries. The screen is for third-party/open-source dependency acknowledgements.
- When adding, removing, or upgrading iOS dependencies, audit whether `apps/ios/Resources/Licenses/` needs updates. Exclude dependencies owned by OpenClaw Foundation from the published license list.
- Keep license detail bodies rendered as verbatim monospace text.
- Keep the Settings Licenses row at the bottom Settings section with no section title unless product direction changes.
- When changing license loading or presentation, update `apps/ios/Tests/LicenseDocumentLoaderTests.swift` and `apps/ios/Tests/SwiftUIRenderSmokeTests.swift`, then run focused iOS tests.

## App Store Releases

- Agent-driven App Store uploads must use only `pnpm ios:release:upload`.
- App Store uploads must include explicit release intent: `pnpm ios:release:upload -- --version <YYYY.M.D>` and `--build-number <n>` when a specific build has been chosen.
- If `pnpm ios:release:upload` exits non-zero, stop immediately and report the failing step.
- After a failed `pnpm ios:release:upload`, do not continue with `pnpm ios:release:archive`, `asc builds upload`, `asc release stage`, `asc publish appstore`, `asc review submit`, direct Fastlane lanes, or any manual App Store Connect mutation command.
- Do not submit an iOS App Store version for App Review. App Review submission stays manual unless the user explicitly asks to submit a specific already-prepared version after the failed state has been reported.
- `pnpm ios:release:archive` is for local archive validation only. It is not a fallback release path after screenshot, metadata, or upload-lane failure.
