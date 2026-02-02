# Agent-Specific Notes

## Vocabulary
- "makeup" = "mac app"

## General Rules
- Never edit `node_modules` (global/Homebrew/npm/git installs)
- Skill notes go in `tools.md` or `AGENTS.md`
- When answering questions, respond with high-confidence answers only: verify in code
- Bug investigations: read source code of dependencies and local code before concluding
- Print full GitHub URL at end of task when working on Issue/PR

## macOS Gateway
- Runs only as menubar app (no separate LaunchAgent)
- Restart via DNA Mac app or `scripts/restart-mac.sh`
- Verify/kill: `launchctl print gui/$UID | grep dna`
- **Debug on macOS:** start/stop via app, not ad-hoc tmux; kill temp tunnels before handoff
- **Never rebuild macOS app over SSH** — must run directly on Mac

## macOS Logs
```bash
./scripts/clawlog.sh  # Query unified logs for DNA subsystem
```
Supports follow/tail/category filters; expects passwordless sudo for `/usr/bin/log`.

## iOS/macOS Development
- SwiftUI: prefer `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`
- Migrate existing `ObservableObject` when touching related code
- iOS Team ID: `security find-identity -p codesigning -v`
- Fallback: `defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`

## Connection Providers
When adding new connection: update every UI surface and docs (macOS app, web UI, mobile, onboarding docs) with matching status + config forms.

## Version Locations
- `package.json` (CLI)
- `apps/android/app/build.gradle.kts` (versionName/versionCode)
- `apps/ios/Sources/Info.plist` + Tests (CFBundleShortVersionString/CFBundleVersion)
- `apps/macos/Sources/DNA/Resources/Info.plist`
- `docs/install/updating.md` (pinned npm version)
- `docs/platforms/mac/release.md` (APP_VERSION/APP_BUILD examples)
- Peekaboo Xcode projects/Info.plists

## A2UI Bundle
- `src/canvas-host/a2ui/.bundle.hash` is auto-generated
- Regenerate via `pnpm canvas:a2ui:bundle` (or `scripts/bundle-a2ui.sh`)
- Commit hash as separate commit

## Session Logs
When asked to open "session" file: open Pi session logs at `~/.dna/agents/<agentId>/sessions/*.jsonl` (use `agent=<id>` from Runtime line; newest unless specific ID given).

## Messaging Safety
Never send streaming/partial replies to external surfaces (WhatsApp, Telegram); only final replies. Streaming may go to internal UIs/control channel.

## Voice Wake Forwarding
- Command template: `dna-mac agent --message "${text}" --thinking low`
- `VoiceWakeForwarder` already shell-escapes `${text}` — don't add extra quotes
- Ensure launchd PATH includes pnpm bin (`$HOME/Library/pnpm`)

## Lint/Format Churn
- Formatting-only diffs: auto-resolve without asking
- If commit already requested: auto-stage formatting follow-ups
- Only ask when changes are semantic (logic/data/behavior)

## Release Guardrails
- Do NOT change version numbers without explicit consent
- Always ask permission before npm publish/release steps
- Read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` before release work
