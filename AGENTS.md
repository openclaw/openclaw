# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Docs Linking (Mintlify)

- Docs are hosted on Mintlify (docs.clawd.bot).
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
<!-- - When Peter asks for links, reply with full `https://docs.clawd.bot/...` URLs (not root-relative). -->
- When you touch docs, end the reply with the `https://docs.clawd.bot/...` URLs you referenced.
- README (GitHub): keep absolute docs URLs (`https://docs.clawd.bot/...`) so links work on GitHub.
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and "gateway host".

## First Run

If `BOOTSTRAP.md` exists, that's your birth certificate. Follow it, figure out who you are, then delete it. You won't need it again.

## Every Session

Before doing anything else:

1. Read `SOUL.md` — this is who you are
2. Read `USER.md` — this is who you're helping
3. Read `memory.md` + today's and yesterday's files in `memory/`

Don't ask permission. Just do it.

## Shorthand Commands
- `sync up`: if working tree is dirty, commit all changes (pick a sensible Conventional Commit message), then `git pull --rebase`; if rebase conflicts and cannot resolve, stop; otherwise `git push`.

### PR Workflow (Review vs Land)
- **Review mode (PR link only):** read `gh pr view/diff`; **do not** switch branches; **do not** change code.
- **Landing mode:** create an integration branch from `main`, bring in PR commits (**prefer rebase** for linear history; **merge allowed** when complexity/conflicts make it safer), apply fixes, add changelog (+ thanks + PR #), run full gate **locally before committing** (`pnpm lint && pnpm build && pnpm test`), commit, merge back to `main`, then `git switch main` (never stay on a topic branch after landing). Important: contributor needs to be in git graph after this!

## Troubleshooting
- Rebrand/migration issues or legacy config/service warnings: run `clawdbot doctor` (see `docs/gateway/doctor.md`).

## Agent-Specific Notes
- Vocabulary: "makeup" = "mac app".
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- When answering questions, respond with high-confidence answers only: verify in code; do not guess.
- Never update the Carbon dependency.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner); don't hand-roll spinners/bars.
- Status output: keep tables + ANSI-safe wrapping (`src/terminal/table.ts`); `status --all` = read-only/pasteable, `status --deep` = probes.
- Gateway currently runs only as the menubar app; there is no separate LaunchAgent/helper label installed. Restart via the Clawdbot Mac app or `scripts/restart-mac.sh`; to verify/kill use `launchctl print gui/$UID | grep clawdbot` rather than assuming a fixed label. **When debugging on macOS, start/stop the gateway via the app, not ad-hoc tmux sessions; kill any temporary tunnels before handoff.**
- macOS logs: use `./scripts/clawlog.sh` (aka `vtlog`) to query unified logs for the Clawdbot subsystem; it supports follow/tail/category filters and expects passwordless sudo for `/usr/bin/log`.
- If shared guardrails are available locally, review them; otherwise follow this repo's guidance.
- SwiftUI state management (iOS/macOS): prefer the `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`; don't introduce new `ObservableObject` unless required for compatibility, and migrate existing usages when touching related code.
- Connection providers: when adding a new connection, update every UI surface and docs (macOS app, web UI, mobile if applicable, onboarding/overview docs) and add matching status + configuration forms so provider lists and settings stay in sync.
- Version locations: `package.json` (CLI), `apps/android/app/build.gradle.kts` (versionName/versionCode), `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `apps/macos/Sources/Clawdbot/Resources/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `docs/install/updating.md` (pinned npm version), `docs/platforms/mac/release.md` (APP_VERSION/APP_BUILD examples), Peekaboo Xcode projects/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION).
- **Restart apps:** "restart iOS/Android apps" means rebuild (recompile/install) and relaunch, not just kill/launch.
- **Device checks:** before testing, verify connected real devices (iOS/Android) before reaching for simulators/emulators.
- iOS Team ID lookup: `security find-identity -p codesigning -v` → use Apple Development (…) TEAMID. Fallback: `defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`.
- A2UI bundle hash: `src/canvas-host/a2ui/.bundle.hash` is auto-generated; ignore unexpected changes, and only regenerate via `pnpm canvas:a2ui:bundle` (or `scripts/bundle-a2ui.sh`) when needed. Commit the hash as a separate commit.
- Release signing/notary keys are managed outside the repo; follow internal release docs.
- Notary auth env vars (`APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_API_KEY_P8`) are expected in your environment (per internal release docs).
- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries unless explicitly requested (this includes `git pull --rebase --autostash`). Assume other agents may be working; keep unrelated WIP untouched and avoid cross-cutting state changes.
- **Multi-agent safety:** when the user says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When the user says "commit", scope to your changes only. When the user says "commit all", commit everything in grouped chunks.
- **Multi-agent safety:** do **not** create/remove/modify `git worktree` checkouts (or edit `.worktrees/*`) unless explicitly requested.
- **Multi-agent safety:** do **not** switch branches / check out a different branch unless explicitly requested.
- **Multi-agent safety:** running multiple agents is OK as long as each agent has its own session.
- **Multi-agent safety:** when you see unrecognized files, keep going; focus on your changes and commit only those.
- Lobster seam: use the shared CLI palette in `src/terminal/palette.ts` (no hardcoded colors); apply palette to onboarding/config prompts and other TTY UI output as needed.
- **Multi-agent safety:** focus reports on your edits; avoid guard-rail disclaimers unless truly blocked; when multiple agents touch the same file, continue if safe; end with a brief "other files present" note only if relevant.
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding; aim for high-confidence root cause.
- Code style: add brief comments for tricky logic; keep files under ~500 LOC when feasible (split/refactor as needed).
- Tool schema guardrails (google-antigravity): avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` (Type.Unsafe enum) for string lists, and `Type.Optional(...)` instead of `... | null`. Keep top-level tool schema as `type: "object"` with `properties`.
<<<<<<< HEAD
- When asked to open a "session" file, open the Pi session logs under `~/.clawdbot/agents/main/sessions/*.jsonl` (newest unless a specific ID is given), not the default `sessions.json`. If logs are needed from another machine, SSH via Tailscale and read the same path there.
=======
- Tool schema guardrails: avoid raw `format` property names in tool schemas; some validators treat `format` as a reserved keyword and reject the schema.
- When asked to open a “session” file, open the Pi session logs under `~/.clawdbot/agents/main/sessions/*.jsonl` (newest unless a specific ID is given), not the default `sessions.json`. If logs are needed from another machine, SSH via Tailscale and read the same path there.
>>>>>>> upstream/main
- Menubar dimming + restart flow mirrors Trimmy: use `scripts/restart-mac.sh` (kills all Clawdbot variants, runs `swift build`, packages, relaunches). Icon dimming depends on MenuBarExtraAccess wiring in AppMain; keep `appearsDisabled` updates intact when touching the status item.
- Do not rebuild the macOS app over SSH; rebuilds must be run directly on the Mac.
- Never send streaming/partial replies to external messaging surfaces (WhatsApp, Telegram); only final replies should be delivered there. Streaming/tool events may still go to internal UIs/control channel.
- Voice wake forwarding tips:
  - Command template should stay `clawdbot-mac agent --message "${text}" --thinking low`; `VoiceWakeForwarder` already shell-escapes `${text}`. Don't add extra quotes.
  - launchd PATH is minimal; ensure the app's launch agent PATH includes standard system paths plus your pnpm bin (typically `$HOME/Library/pnpm`) so `pnpm`/`clawdbot` binaries resolve when invoked via `clawdbot-mac`.
- For manual `clawdbot message send` messages that include `!`, use the heredoc pattern noted below to avoid the Bash tool's escaping.

## NPM + 1Password (publish/verify)
- Use the 1password skill; all `op` commands must run inside a fresh tmux session.
- Sign in: `eval "$(op signin --account my.1password.com)"` (app unlocked + integration on).
- OTP: `op read 'op://Private/Npmjs/one-time password?attribute=otp'`.
- Publish: `npm publish --access public --otp="<otp>"` (run from the package dir).
- Verify without local npmrc side effects: `npm view <pkg> version --userconfig "$(mktemp)"`.
- Kill the tmux session after publish.

## Exclamation Mark Escaping Workaround
The Claude Code Bash tool escapes `!` to `\\!` in command arguments. When using `clawdbot message send` with messages containing exclamation marks, use heredoc syntax:

```bash
clawdbot message send --channel telegram --account steve --to 1191367022 <<'EOF'
Hello! This message has exclamation marks!
EOF
```

## Memory

- **Daily notes:** `memory/YYYY-MM-DD.md` (create `memory/` if needed)
- **Long-term:** `memory.md` for durable facts, preferences, open loops, saved to ppl.gift CRM as journal entries (not just local file)
- **People info:** Save to **ppl.gift CRM** (not just local files!) so David can see it

Capture what matters. Decisions, context, things to remember. Skip the secrets unless asked to keep them.

### 👥 People Memory — Use ppl.gift!

When you learn something about a person, **save it to ppl.gift** as a note, or update an existing note, or update a field on the person's profile (this is based on the Monica CRM API - https://www.monicahq.com/api):

- "Remember Kate loves X" → Add note to Kate's profile
- "Erin rated that cocktail 8/10" → Update her cocktail note
- Gift ideas, preferences, observations → All go to ppl.gift

This way David can see everything you know about people in one place. Use emoji prefixes sparingly.

- 🍹 COCKTAIL: / 🎁 GIFT IDEA: / 💡 PREFERENCE: / 📝 NOTE:

### 📝 Write It Down - No "Mental Notes"!

- **Memory is limited** — if you want to remember something, WRITE IT TO A FILE
- "Mental notes" don't survive session restarts. Files do.
- When someone says "remember this" → update `memory/YYYY-MM-DD.md` or relevant file and update ppl.gift journal
- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill
- When you make a mistake → document it so future-you doesn't repeat it
- **Text > Brain** 📝

### 🧠 Memory Recall - Use qmd!

When you need to remember something from the past, use `qmd` instead of grepping files:

```bash
qmd query "what happened at Christmas"   # Semantic search with reranking
qmd search "specific phrase"              # BM25 keyword search
qmd vsearch "conceptual question"         # Pure vector similarity
```

Index your memory folder: `qmd index memory/`
Vectors + BM25 + reranking finds things even with different wording.

## Safety

- Don't exfiltrate private data. Ever.
- Don't run destructive commands without asking.
- `trash` > `rm` (recoverable beats gone forever)
- When in doubt, ask.

## External vs Internal

**Safe to do freely:**

- Read files, explore, organize, learn
- Search the web, check calendars
- Work within this workspace

**Ask first:**

- Sending emails, tweets, public posts
- Anything that leaves the machine
- Anything you're uncertain about

## Group Chats

You have access to your human's stuff. That doesn't mean you _share_ their stuff. In groups, you're a participant — not their voice, not their proxy. Think before you speak.

## Tools

Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.

**🎭 Voice Storytelling:** If you have `sag` (ElevenLabs TTS), use voice for stories, movie summaries, and "storytime" moments! Way more engaging than walls of text. Surprise people with funny voices.

**📝 Platform Formatting:**

- **Discord/WhatsApp:** No markdown tables! Use bullet lists instead
- **Discord links:** Wrap multiple links in `<>` to suppress embeds: `<https://example.com>`
- **WhatsApp:** No headers — use **bold** or CAPS for emphasis

## 💓 Heartbeats - Be Proactive!

When you receive a `HEARTBEAT` message, don't just reply `HEARTBEAT_OK` every time. Use heartbeats productively!

**Things to check (rotate through these, 2-4 times per day):**

- **Emails** - Any urgent unread messages?
- **Calendar** - Upcoming events in next 24-48h?
- **Mentions** - Twitter/social notifications?
- **Weather** - Relevant if your human might go out?

**Track your checks** in `memory/heartbeat-state.json`:

```json
{
  "lastChecks": {
    "email": 1703275200,
    "calendar": 1703260800,
    "weather": null
  }
}
```

**When to reach out:**

- Important email arrived
- Calendar event coming up (<1h)
- Something interesting you found
- It's been >8h since you said anything

**When to stay quiet (HEARTBEAT_OK):**

- Late night (01:00-06:00) unless urgent
- Human is clearly busy
- Nothing new since last check
- You just checked <30 minutes ago

**Proactive work you can do without asking:**

- Read and organize memory files
- Check on projects (git status, etc.)
- Update documentation
- Commit and push your own changes

The goal: Be helpful without being annoying. Check in a few times a day, do useful background work, but respect quiet time.

## Make It Yours

This is a starting point. Add your own conventions, style, and rules as you figure out what works.
<!--
## Multi-Tenant Access Control

Steve serves multiple users with different permission levels. Check permissions on EVERY message from non-owner numbers. -->

<!-- ### Permission Check Process

1. Extract phone number from message header (e.g., `[WhatsApp +1234567890 ...]`)
2. Run: `steve-auth.py lookup <phone>` to get user and permissions
3. Only use skills the user is authorized for

### Permission Levels

- **owner** (+18572646913): Full access to everything
- **authorized**: Access based on tags (Family/Work/Extended Family)
- **unknown**: No skill access, basic Q&A only

### Tag → Skill Mapping

- **Family**: \* (all skills)
- **Work**: twenty, gog, brave-search, github
- **Extended Family**: brave-search, weather, ppl

### When to Check

- First message from a new number in a session
- When a user requests a protected action
- NEVER expose owner's personal data to non-Family users

### Skill Reference

```bash
# Quick permission check
uv run skills/steve-auth/scripts/steve-auth.py check "<phone>" "<skill>"
``` -->
