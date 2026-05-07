# Local runtime / platform notes

Personal-machine ops trivia. Loaded on demand; not in the default agent prompt.

## Vocabulary

- "makeup" = "mac app".

## Doctor

- Rebrand/migration issues, legacy config/service warnings → `openclaw doctor` (see `docs/gateway/doctor.md`).

## Related skills

- `$openclaw-parallels-smoke` (`.agents/skills/openclaw-parallels-smoke/SKILL.md`) — Parallels smoke, rerun, upgrade, debug, and result-interpretation across macOS, Windows, Linux guests.
- `.agents/skills/parallels-discord-roundtrip/SKILL.md` — narrower macOS Discord roundtrip deep-dive.

## Editor / repo hygiene

- Never edit `node_modules` (global/Homebrew/npm/git installs too — updates overwrite). Skill notes go in `tools.md` or `AGENTS.md`.
- Local-only `.agents` ignores → use `.git/info/exclude`, not repo `.gitignore`.
- New `AGENTS.md` anywhere in the repo → also add a `CLAUDE.md` symlink: `ln -s AGENTS.md CLAUDE.md`.

## Fly

- "update fly" → `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` then `fly machines restart e825232f34d058 -a flawd-bot`.

## CLI / status output

- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner). No hand-rolled spinners/bars.
- Status output: tables + ANSI-safe wrapping (`src/terminal/table.ts`). `status --all` = read-only/pasteable, `status --deep` = probes.
- Lobster palette: shared CLI palette in `src/terminal/palette.ts` (no hardcoded colors). Apply to onboarding/config prompts and other TTY UI output as needed.

## macOS gateway

- Gateway runs only as the menubar app. No separate LaunchAgent/helper label installed.
- Restart via the OpenClaw Mac app or `scripts/restart-mac.sh`.
- Verify/kill: `launchctl print gui/$UID | grep openclaw` (don't assume a fixed label).
- Debugging on macOS: start/stop the gateway via the app, not ad-hoc tmux sessions. Kill any temporary tunnels before handoff.
- Do not rebuild the macOS app over SSH — rebuilds must run directly on the Mac.

## macOS logs

- `./scripts/clawlog.sh` queries unified logs for the OpenClaw subsystem (follow/tail/category filters; expects passwordless sudo for `/usr/bin/log`).

## Mac packaging

- Dev: `scripts/package-mac-app.sh` (defaults to current arch).
- Release signing/notary credentials managed outside the repo (private maintainer release docs).

## SwiftUI (iOS/macOS)

- Prefer the `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject` / `@StateObject`.
- Don't introduce new `ObservableObject` unless required for compatibility; migrate existing usages when touching related code.

## Connection providers

- Adding a new connection: update every UI surface and docs (macOS app, web UI, mobile if applicable, onboarding/overview docs) and add matching status + configuration forms so provider lists and settings stay in sync.

## Version locations

`package.json` (CLI), `apps/android/app/build.gradle.kts` (versionName/versionCode), `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `apps/macos/Sources/OpenClaw/Resources/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `docs/install/updating.md` (pinned npm version), Peekaboo Xcode projects/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION).

"Bump version everywhere" = all version locations above EXCEPT `appcast.xml` (only touch appcast when cutting a new macOS Sparkle release).

## Restart / device checks

- "Restart iOS/Android apps" = rebuild (recompile/install) and relaunch, not just kill/launch.
- Before testing, verify connected real devices (iOS/Android) before reaching for simulators/emulators.

## iOS Team ID lookup

`security find-identity -p codesigning -v` → use Apple Development (…) TEAMID. Fallback: `defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`.

## A2UI bundle hash

- `src/canvas-host/a2ui/.bundle.hash` is auto-generated; ignore unexpected changes.
- Regenerate via `pnpm canvas:a2ui:bundle` (or `scripts/bundle-a2ui.sh`) only when needed.
- Commit the hash as a separate commit.

## "Session" file

When asked to open a "session" file, open the Pi session logs at `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (use the `agent=<id>` value in the Runtime line of the system prompt; newest unless a specific ID is given) — not the default `sessions.json`. From another machine, SSH via Tailscale and read the same path.

## Voice wake forwarding

- Command template stays `openclaw-mac agent --message "${text}" --thinking low`. `VoiceWakeForwarder` already shell-escapes `${text}`. No extra quotes.
- launchd PATH is minimal — ensure the app's launch agent PATH includes standard system paths plus your pnpm bin (typically `$HOME/Library/pnpm`) so `pnpm`/`openclaw` binaries resolve when invoked via `openclaw-mac`.

## Pi sessions

- Pi sessions: `~/.openclaw/sessions/` by default; base dir is not configurable.

## Web provider

- Creds at `~/.openclaw/credentials/`. Rerun `openclaw login` if logged out.

## Env vars

- See `~/.profile`.

## Tool schema guardrails (google-antigravity)

- Avoid `Type.Union` in tool input schemas. No `anyOf` / `oneOf` / `allOf`.
- Use `stringEnum` / `optionalStringEnum` (Type.Unsafe enum) for string lists.
- Use `Type.Optional(...)` instead of `... | null`.
- Top-level tool schema stays `type: "object"` with `properties`.
- Avoid raw `format` property names — some validators treat `format` as reserved.

## External messaging surfaces

- Never send streaming/partial replies to WhatsApp, Telegram, etc. — only final replies. Streaming/tool events may still go to internal UIs / control channel.

## `!` in messages

- For manual `openclaw message send` messages containing `!`, use a heredoc to avoid shell escaping.
