# macOS app

- Native owns device-local capability, the offline Connection window, its About tab, and bridge-opened panels.
- Dashboard owns app and Gateway preferences. Keep About native; reject new Gateway-data or app-settings UI in Swift.
- Connection tabs: Connection, Gateways, About; Debug appears only while the developer toggle is enabled.
- Web bridges: device-local settings only through `openclawDeviceSettings` (`ui/src/app/native-device-settings.ts`), native browser tabs only through `openclawBrowser` (`ui/src/app/native-browser-bridge.ts`); keep wire keys and types aligned.
- Bridge mutations use existing native owners; never write `openclaw.json`.
- Preserve `AppLaunchRuntimePlan` (`AppLaunchPresentationPolicy.swift`) and `--background-only` startup behavior.
- Build app: `swift build --package-path apps/macos --build-system native --product OpenClaw`.
- Compile tests: `swift build --package-path apps/macos --build-system native --build-tests`.
- Swift checks: `scripts/lint-swift.sh macos`; `scripts/format-swift.sh macos`.
- Strings changed: `pnpm native:i18n:verify`.
- Generate localization inventory only with `pnpm native:i18n:baseline`; never edit translation memory.
- Native test isolation: follow `docs/platforms/mac/dev-setup.md#run-native-tests-safely`; never launch tests or the app against the operator's Gateway or `~/.openclaw`.
- Tests own unique defaults suites, temporary files, and nonpersistent WebKit stores; clean up resources.
- Local pure-logic filters must avoid AppDefaults, Keychain, windows, and operator state.
