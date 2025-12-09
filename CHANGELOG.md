# Changelog

## 2.0.0 — Unreleased

First Clawdis release after the Warelay rebrand. This is a semver-major because we dropped legacy providers/agents and moved defaults to new paths while adding a full macOS companion app.

### Breaking
- Renamed to **Clawdis**: defaults now live under `~/.clawdis` (sessions in `~/.clawdis/sessions/`, IPC at `~/.clawdis/clawdis.sock`, logs in `/tmp/clawdis`). Launchd labels and config filenames follow the new name; legacy stores are copied forward on first run.
- Pi/Tau only: `inbound.reply.agent.kind` accepts only `"pi"`, and the agent CLI/CLI flags for Claude/Codex/Gemini were removed. The Pi CLI runs in RPC mode with a persistent worker.
- WhatsApp Web is the only transport; Twilio support and related CLI flags/tests were removed.
- Direct chats now collapse into a single `main` session by default (no config needed); groups stay isolated as `group:<jid>`.
- Relay background helpers were removed; run `clawdis relay --verbose` under your supervisor of choice if you want it detached.

### macOS companion app
- **Clawdis.app menu bar companion**: packaged, signed bundle with relay start/stop, launchd toggle, project-root and pnpm/node auto-resolution, live log shortcut, restart button, and status/recipient table plus badges/dimming for attention and paused states.
- **On-device Voice Wake**: Apple speech recognizer with wake-word table, language picker, live mic meter, “hold until silence,” animated ears/legs, and an SSH forwarder + test harness that runs `clawdis-mac agent --message …` on your target machine and surfaces errors clearly.
- **WebChat & Debugging**: bundled WebChat UI, Debug tab with heartbeat sliders, session-store picker, log opener (`clawlog`), relay restart, health probes, and scrollable settings panes.

### WhatsApp & agent experience
- Group chats fully supported: mention-gated triggers (including media-only captions), sender attribution, session primer with subject/member roster, allowlist bypass when you’re @‑mentioned, and safer handling of view-once/ephemeral media.
- Thinking/verbosity directives: `/think` and `/verbose` acknowledge and persist per session while allowing inline overrides; verbose mode streams tool metadata with emoji/args/previews and coalesces bursts to reduce WhatsApp noise.
- Heartbeats: configurable cadence with CLI/GUI toggles; directive acks suppressed during heartbeats; array/multi-payload replies normalized for Baileys.
- Reply quality: smarter chunking on words/newlines, fallback warnings when media fails to send, self-number mention detection, and primed group sessions send the roster on first turn.
- In-chat `/status`: prints agent readiness, session context usage %, current thinking/verbose options, and when the WhatsApp web creds were refreshed (helps decide when to re-scan QR); still available via `clawdis status` CLI for web session health.

### CLI, RPC, and health
- New `clawdis agent` command plus a persistent Pi RPC worker (auto-started) enables direct agent chats; `clawdis status` renders a colored session/recipient table.
- `clawdis health` probes WhatsApp link status, connect latency, heartbeat interval, session-store recency, and IPC socket presence (JSON mode for monitors).
- Added `--help`/`--version` flags; login/logout accept `--provider` (WhatsApp default). Console output is mirrored into pino logs under `/tmp/clawdis`.
- RPC stability: stdin/stdout loop for Tau/Pi, auto-restart worker, raw error surfacing, and deliver-via-RPC when JSON agent output is returned.

### Security & hardening
- Media server blocks symlink/path traversal, clears temporary downloads, and rotates logs daily (24h retention).
- Session store purged on logout; IPC socket directory permissions tightened (0700/0600).
- Launchd PATH and helper lookup hardened for packaged macOS builds; health probes surface missing binaries quickly.

### Docs
- Added `docs/telegram.md` outlining the Telegram Bot API provider (grammY) and how it shares the `main` session. Default grammY throttler keeps Bot API calls under rate limits.
- CLI relay now auto-starts WhatsApp and Telegram when configured (single `relay` command with `--provider` selector); text/media sends still use `--provider telegram`; webhook/proxy options documented.

## 1.5.0 — 2025-12-05

### Breaking
- Dropped all non-Pi agents (Claude, Codex, Gemini, Opencode); `inbound.reply.agent.kind` now only accepts `"pi"` and related CLI helpers have been removed.
- Removed Twilio support and all related commands/options (webhook/up/provider flags/wait-poll); CLAWDIS is Baileys Web-only.

### Changes
- Default agent handling now favors Pi RPC while falling back to plain command execution for non-Pi invocations, keeping heartbeat/session plumbing intact.
- Documentation updated to reflect Pi-only support and to mark legacy Claude paths as historical.
- Status command reports web session health + session recipients; config paths are locked to `~/.clawdis` with session metadata stored under `~/.clawdis/sessions/`.
- Simplified send/agent/relay/heartbeat to web-only delivery; removed Twilio mocks/tests and dead code.
- Tau RPC timeout is now inactivity-based (5m without events) and error messages show seconds only.
- Pi/Tau sessions now write to `~/.clawdis/sessions/` by default (legacy `~/.tau/agent/sessions/clawdis` files are copied over when present).
- Directive triggers (`/think`, `/verbose`, `/stop` et al.) now reply immediately using normalized bodies (timestamps/group prefixes stripped) without waiting for the agent.
- Directive/system acks carry a `⚙️` prefix and verbose parsing rejects typoed `/ver*` strings so unrelated text doesn’t flip verbosity.
- Batched history blocks no longer trip directive parsing; `/think` in prior messages won't emit stray acknowledgements.
- RPC fallbacks no longer echo the user's prompt (e.g., pasting a link) when the agent returns no assistant text.
- Heartbeat prompts with `/think` no longer send directive acks; heartbeat replies stay silent on settings.
- `clawdis sessions` now renders a colored table (a la oracle) with context usage shown in k tokens and percent of the context window.

## 1.4.1 — 2025-12-04

### Changes
- Added `clawdis agent` CLI command to talk directly to the configured agent using existing session handling (no WhatsApp send), with JSON output and delivery option.
- `/new` reset trigger now works even when inbound messages have timestamp prefixes (e.g., `[Dec 4 17:35]`).
- WhatsApp mention parsing accepts nullable arrays and flattens safely to avoid missed mentions.

## 1.4.0 — 2025-12-03

### Highlights
- **Thinking directives & state:** `/t|/think|/thinking <level>` (aliases off|minimal|low|medium|high|max/highest). Inline applies to that message; directive-only message pins the level for the session; `/think:off` clears. Resolution: inline > session override > `inbound.reply.thinkingDefault` > off. Pi/Tau get `--thinking <level>` (except off); other agents append cue words (`think` → `think hard` → `think harder` → `ultrathink`). Heartbeat probe uses `HEARTBEAT /think:high`.
- **Group chats (web provider):** Clawdis now fully supports WhatsApp groups: mention-gated triggers (including image-only @ mentions), recent group history injection, per-group sessions, sender attribution, and a first-turn primer with group subject/member roster; heartbeats are skipped for groups.
- **Group session primer:** The first turn of a group session now tells the agent it is in a WhatsApp group and lists known members/subject so it can address the right speaker.
- **Media failures are surfaced:** When a web auto-reply media fetch/send fails (e.g., HTTP 404), we now append a warning to the fallback text so you know the attachment was skipped.
- **Verbose directives + session hints:** `/v|/verbose on|full|off` mirrors thinking: inline > session > config default. Directive-only replies with an acknowledgement; invalid levels return a hint. When enabled, tool results from JSON-emitting agents (Pi/Tau, etc.) are forwarded as metadata-only `[🛠️ <tool-name> <arg>]` messages (now streamed as they happen), and new sessions surface a `🧭 New session: <id>` hint.
- **Verbose tool coalescing:** successive tool results of the same tool within ~1s are batched into one `[🛠️ tool] arg1, arg2` message to reduce WhatsApp noise.
- **Directive confirmations:** Directive-only messages now reply with an acknowledgement (`Thinking level set to high.` / `Thinking disabled.`) and reject unknown levels with a helpful hint (state is unchanged).
- **Pi/Tau stability:** RPC replies buffered until the assistant turn finishes; parsers return consistent `texts[]`; web auto-replies keep a warm Tau RPC process to avoid cold starts.
- **Claude prompt flow:** One-time `sessionIntro` with per-message `/think:high` bodyPrefix; system prompt always sent on first turn even with `sendSystemOnce`.
- **Heartbeat UX:** Backpressure skips reply heartbeats while other commands run; skips don’t refresh session `updatedAt`; web heartbeats normalize array payloads and optional `heartbeatCommand`.
- **Control via WhatsApp:** Send `/restart` to restart the launchd service (`com.steipete.clawdis`) from your allowed numbers.
- **Tau completion signal:** RPC now resolves on Tau’s `agent_end` (or process exit) so late assistant messages aren’t truncated; 5-minute hard cap only as a failsafe.

### Reliability & UX
- Outbound chunking prefers newlines/word boundaries and enforces caps (~4000 chars for web/WhatsApp).
- Web auto-replies fall back to caption-only if media send fails; hosted media MIME-sniffed and cleaned up immediately.
- IPC relay send shows typing indicator; batched inbound messages keep timestamps; watchdog restarts WhatsApp after long inactivity.
- Early `allowFrom` filtering prevents decryption errors; same-phone mode supported with echo suppression.
- All console output is now mirrored into pino logs (still printed to stdout/stderr), so verbose runs keep full traces.
- `--verbose` now forces log level `trace` (was `debug`) to capture every event.
- Verbose tool messages now include emoji + args + a short result preview for bash/read/edit/write/attach (derived from RPC tool start/end events).

### Security / Hardening
- IPC socket hardened (0700 dir / 0600 socket, no symlinks/foreign owners); `clawdis logout` also prunes session store.
- Media server blocks symlinks and enforces path containment; logging rotates daily and prunes >24h.

### Bug Fixes
- Web group chats now bypass the second `allowFrom` check (we still enforce it on the group participant at inbox ingest), so mentioned group messages reply even when the group JID isn’t in your allowlist.
- `logVerbose` also writes to the configured Pino logger at debug level (without breaking stdout).
- Group auto-replies now append the triggering sender (`[from: Name (+E164)]`) to the batch body so agents can address the right person in group chats.
- Media-only pings now pick up mentions inside captions (image/video/etc.), so @-mentions on media-only messages trigger replies.
- MIME sniffing and redirect handling for downloads/hosted media.
- Response prefix applied to heartbeat alerts; heartbeat array payloads handled for both providers.
- Tau RPC typing exposes `signal`/`killed`; NDJSON parsers normalized across agents.
- Tau (pi) session resumes now append `--continue`, so existing history/think level are reloaded instead of starting empty.

### Testing
- Fixtures isolate session stores; added coverage for thinking directives, stateful levels, heartbeat backpressure, and agent parsing.

## 1.3.0 — 2025-12-02

### Highlights
- **Pluggable agents (Claude, Pi, Codex, Opencode):** `inbound.reply.agent` selects CLI/parser; per-agent argv builders and NDJSON parsers enable swapping without template changes.
- **Safety stop words:** `stop|esc|abort|wait|exit` immediately reply “Agent was aborted.” and mark the session so the next prompt is prefixed with an abort reminder.
- **Agent session reliability:** Only Claude returns a stable `session_id`; others may reset between runs.

### Bug Fixes
- Empty `result` fields no longer leak raw JSON to users.
- Heartbeat alerts now honor `responsePrefix`.
- Command failures return user-friendly messages.
- Test session isolation to avoid touching real `sessions.json`.
- IPC reuse for `clawdis send/heartbeat` prevents Signal/WhatsApp session corruption.
- Web send respects media kind (image/audio/video/document) with correct limits.

### Changes
- IPC gateway socket at `~/.clawdis/ipc/gateway.sock` with automatic CLI fallback.
- Batched inbound messages with timestamps; typing indicator after IPC sends.
- Watchdog restarts WhatsApp after long inactivity; heartbeat logging includes minutes since last message.
- Early `allowFrom` filtering before decryption.
- Same-phone mode with echo detection and optional `inbound.samePhoneMarker`.

## 1.2.2 — 2025-11-28

### Changes
- Manual heartbeat sends: `clawdis heartbeat --message/--body` (web provider only); `--dry-run` previews payloads.

## 1.2.1 — 2025-11-28

### Changes
- Media MIME-first handling; hosted media extensions derived from detected MIME with tests.

### Planned / in progress (from prior notes)
- Heartbeat targeting quality: clearer recipient resolution and verbose logs.
- Heartbeat delivery preview (Claude path) dry-run.
- Simulated inbound hook for local testing.

## 1.2.0 — 2025-11-27

### Changes
- Heartbeat interval default 10m for command mode; prompt `HEARTBEAT /think:high`; skips don’t refresh session; session `heartbeatIdleMinutes` support.
- Heartbeat tooling: `--session-id`, `--heartbeat-now` (inline flag on `relay`) for immediate startup probes.
- Prompt structure: `sessionIntro` plus per-message `/think:high`; session idle up to 7 days.
- Thinking directives: `/think:<level>`; Pi uses `--thinking`; others append cue; `/think:off` no-op.
- Robustness: Baileys/WebSocket guards; global unhandled error handlers; WhatsApp LID mapping; hosted media MIME-sniffing and cleanup.
- Docs: README Clawd setup; `docs/claude-config.md` for live config.

## 1.1.0 — 2025-11-26

### Changes
- Web auto-replies resize/recompress media and honor `inbound.reply.mediaMaxMb`.
- Detect media kind, enforce provider caps (images ≤6MB, audio/video ≤16MB, docs ≤100MB).
- `session.sendSystemOnce` and optional `sessionIntro`.
- Typing indicator refresh during commands; configurable via `inbound.reply.typingIntervalSeconds`.
- Optional audio transcription via external CLI.
- Command replies return structured payload/meta; respect `mediaMaxMb`; log Claude metadata; include `cwd` in timeout messages.
- Web provider refactor; logout command; web-only relay start helper.
- Structured reconnect/heartbeat logging; bounded backoff with CLI/config knobs; troubleshooting guide.
- Relay help prints effective heartbeat/backoff when in web mode.

## 1.0.4 — 2025-11-25

### Changes
- Timeout fallbacks send partial stdout (≤800 chars) to the user instead of silence; tests added.
- Web relay auto-reconnects after Baileys/WebSocket drops; close propagation tests.

## 0.1.3 — 2025-11-25

### Changes
- Auto-replies send a WhatsApp fallback message on command/Claude timeout with truncated stdout.
- Added tests for timeout fallback and partial-output truncation.
