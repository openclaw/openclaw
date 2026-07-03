# iOS Release Agent Policy

Root rules still apply. This file adds the iOS release guardrails.

## App Store Releases

- Agent-driven App Store uploads must use only `pnpm ios:release:upload`.
- App Store uploads must include explicit release intent: `pnpm ios:release:upload -- --version <YYYY.M.D>` and `--build-number <n>` when a specific build has been chosen.
- If `pnpm ios:release:upload` exits non-zero, stop immediately and report the failing step.
- After a failed `pnpm ios:release:upload`, do not continue with `pnpm ios:release:archive`, `asc builds upload`, `asc release stage`, `asc publish appstore`, `asc review submit`, direct Fastlane lanes, or any manual App Store Connect mutation command.
- Do not submit an iOS App Store version for App Review. App Review submission stays manual unless the user explicitly asks to submit a specific already-prepared version after the failed state has been reported.
- `pnpm ios:release:archive` is for local archive validation only. It is not a fallback release path after screenshot, metadata, or upload-lane failure.
