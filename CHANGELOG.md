# Changelog

## [Unreleased] (will be 1.3.1)

### Highlights
- **Thinking directives & state:** `/t|/think|/thinking <level>` (aliases off|minimal|low|medium|high|max/highest). Inline applies to that message; directive-only message pins the level for the session; `/think:off` clears. Resolution: inline > session override > `inbound.reply.thinkingDefault` > off. Pi/Tau get `--thinking <level>` (except off); other agents append cue words (`think` → `think hard` → `think harder` → `ultrathink`). Heartbeat probe uses `HEARTBEAT /think:high`.
- **Group chats (web provider):** New `inbound.groupChat` config (requireMention, mentionPatterns, historyLimit). Warelay now listens to WhatsApp groups, only replies when mentioned, injects recent group history into the prompt, and keeps group sessions separate from personal chats; heartbeats are skipped for group threads.
- **Group session primer:** The first turn of a group session now tells the agent it is in a WhatsApp group and lists known members/subject so it can address the right speaker.
- **Verbose directives + session hints:** `/v|/verbose on|full|off` mirrors thinking: inline > session > config default. Directive-only replies with an acknowledgement; invalid levels return a hint. When enabled, tool results from JSON-emitting agents (Pi/Tau, etc.) are forwarded as metadata-only `[🛠️ <tool-name> <arg>]` messages (now streamed as they happen), and new sessions surface a `🧭 New session: <id>` hint.
- **Verbose tool coalescing:** successive tool results of the same tool within ~1s are batched into one `[🛠️ tool] arg1, arg2` message to reduce WhatsApp noise.
- **Directive confirmations:** Directive-only messages now reply with an acknowledgement (`Thinking level set to high.` / `Thinking disabled.`) and reject unknown levels with a helpful hint (state is unchanged).
- **Pi/Tau stability:** RPC replies buffered until the assistant turn finishes; parsers return consistent `texts[]`; web auto-replies keep a warm Tau RPC process to avoid cold starts.
- **Claude prompt flow:** One-time `sessionIntro` with per-message `/think:high` bodyPrefix; system prompt always sent on first turn even with `sendSystemOnce`.
- **Heartbeat UX:** Backpressure skips reply heartbeats while other commands run; skips don’t refresh session `updatedAt`; web/Twilio heartbeats normalize array payloads and optional `heartbeatCommand`.
- **Control via WhatsApp:** Send `/restart` to restart the warelay launchd service (`com.steipete.warelay`) from your allowed numbers.
- **Tau completion signal:** RPC now resolves on Tau’s `agent_end` (or process exit) so late assistant messages aren’t truncated; 5-minute hard cap only as a failsafe.

### Reliability & UX
- Outbound chunking prefers newlines/word boundaries and enforces caps (1600 WhatsApp/Twilio, 4000 web).
- Web auto-replies fall back to caption-only if media send fails; hosted media MIME-sniffed and cleaned up immediately.
- IPC relay send shows typing indicator; batched inbound messages keep timestamps; watchdog restarts WhatsApp after long inactivity.
- Early `allowFrom` filtering prevents decryption errors; same-phone mode supported with echo suppression.
- All console output is now mirrored into pino logs (still printed to stdout/stderr), so verbose runs keep full traces.
- `--verbose` now forces log level `trace` (was `debug`) to capture every event.
- Verbose tool messages now include emoji + args + a short result preview for bash/read/edit/write/attach (derived from RPC tool start/end events).

### Security / Hardening
- IPC socket hardened (0700 dir / 0600 socket, no symlinks/foreign owners); `warelay logout` also prunes session store.
- Media server blocks symlinks and enforces path containment; logging rotates daily and prunes >24h.

### Bug Fixes
- Web group chats now bypass the second `allowFrom` check (we still enforce it on the group participant at inbox ingest), so mentioned group messages reply even when the group JID isn’t in your allowlist.
- `logVerbose` also writes to the configured Pino logger at debug level (without breaking stdout).
- Group auto-replies now append the triggering sender (`[from: Name (+E164)]`) to the batch body so agents can address the right person in group chats.
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
- IPC reuse for `warelay send/heartbeat` prevents Signal/WhatsApp session corruption.
- Web send respects media kind (image/audio/video/document) with correct limits.

### Changes
- IPC relay socket at `~/.warelay/relay.sock` with automatic CLI fallback.
- Batched inbound messages with timestamps; typing indicator after IPC sends.
- Watchdog restarts WhatsApp after long inactivity; heartbeat logging includes minutes since last message.
- Early `allowFrom` filtering before decryption.
- Same-phone mode with echo detection and optional `inbound.samePhoneMarker`.

## 1.2.2 — 2025-11-28

### Changes
- Manual heartbeat sends: `warelay heartbeat --message/--body --provider web|twilio`; `--dry-run` previews payloads.

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
- Heartbeat tooling: `--session-id`, `--heartbeat-now`, relay helpers `relay:heartbeat` and `relay:heartbeat:tmux`.
- Prompt structure: `sessionIntro` plus per-message `/think:high`; session idle up to 7 days.
- Thinking directives: `/think:<level>`; Pi uses `--thinking`; others append cue; `/think:off` no-op.
- Robustness: Baileys/WebSocket guards; global unhandled error handlers; WhatsApp LID mapping; Twilio media hosting via shared host module.
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
