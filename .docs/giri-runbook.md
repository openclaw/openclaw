# Giri Runbook

## Branch and Scope

- Branch: `giri-corre-features`
- Scope: merged frontend (macOS Talk overlay) + backend (`evening-planner` extension)

## Prerequisites

- Node.js `22+`
- `pnpm` available (`corepack enable pnpm` if needed)
- For macOS app local run: Swift toolchain matching package requirement (`6.2.0`)
- Telegram bot token (BotFather)
- Optional: Swiggy CLI/auth for live booking path

## Install

```bash
cd /Users/aryanmadhavverma/Develop/projects/giri
pnpm install
```

## Credentials and Config

### OpenClaw config location

- Default config: `~/.openclaw/openclaw.json`
- State dir (sessions/credentials): `~/.openclaw/`

### Telegram

Set token and policy:

```bash
pnpm openclaw config set gateway.mode local
pnpm openclaw plugins enable telegram
pnpm openclaw config set channels.telegram.enabled true --json
pnpm openclaw config set channels.telegram.botToken "<BOT_TOKEN>"
pnpm openclaw config set channels.telegram.dmPolicy "pairing"
```

Approve DM sender once pairing code appears:

```bash
pnpm openclaw pairing list telegram
pnpm openclaw pairing approve telegram <CODE>
```

### Evening Planner plugin

Enable plugin and set config:

```bash
pnpm openclaw plugins enable evening-planner
pnpm openclaw config set 'plugins.entries["evening-planner"].config' '{
  enabled: true,
  deterministicDemo: true,
  telegramAccountId: "",
  timeoutSec: 120,
  maxTurns: 3,
  pollingIntervalSec: 5,
  fixtureMode: true,
  swiggyCommand: "swiggy",
  swiggyTimeoutMs: 15000,
  shubham: { username: "shubham", displayName: "Shubham" }
}' --json
```

Notes:

- Keep `fixtureMode: true` for deterministic demos.
- Set `fixtureMode: false` only when live Swiggy CLI path is ready.

## Run Backend (Gateway + plugins)

```bash
cd /Users/aryanmadhavverma/Develop/projects/giri
pnpm openclaw gateway run
```

Useful checks:

```bash
pnpm openclaw plugins list
pnpm openclaw gateway call eveningplanner.list
pnpm openclaw gateway call eveningplanner.status --params '{"sessionId":"<SESSION_ID>"}'
```

## Run Frontend (macOS app)

```bash
cd /Users/aryanmadhavverma/Develop/projects/giri/apps/macos
swift build
swift run OpenClaw
```

If build fails with tools-version mismatch, update local Swift toolchain to match package tools version.

## Integrated Flow (End-to-End)

1. Start gateway (`pnpm openclaw gateway run`).
2. Start macOS app (`swift run OpenClaw`).
3. Trigger planner session (`evening_planner` tool `start_session` through agent flow).
4. Shubham replies in Telegram; plugin ingests and updates session.
5. Poll status (`eveningplanner.status`) until `awaiting_confirmation`.
6. Run `prepare_booking` then `book_table(confirm=true)`.
7. Verify final `session.status` and `bookingResult`.

## Runtime Data Paths

- Planner sessions: `~/.openclaw/plugins/evening-planner/sessions.json`
- Pairing state: `~/.openclaw/credentials/*-pairing.json`
- Allowlist state: `~/.openclaw/credentials/*-allowFrom.json`

## Known Constraints

- Backend does not yet emit dedicated `demo.workflow.*` events from planner extension.
- Overlay currently relies on generic `tool`/`assistant` streams plus fallback timeline.
- PSTN/native call bridge is not implemented in this pass.
