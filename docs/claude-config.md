# Claude Auto-Reply Setup (2025-11-27)

This is the live Claude configuration used by @steipete’s personal assistant “Clawd”. It matches the current code paths and defaults in this repo.

## Prerequisites
- Node 22+, `warelay` installed globally (`npm install -g warelay`) or run via `pnpm warelay` inside the repo.
- Claude CLI installed and logged in:
  ```sh
  brew install anthropic-ai/cli/claude
  claude login
  ```
- Optional: set `ANTHROPIC_API_KEY` in your shell profile for non-interactive use.

## Current personal config (`~/.warelay/warelay.json`)

```json5
{
  logging: { level: "trace", file: "/tmp/warelay/warelay.log" },
  inbound: {
    allowFrom: ["***REMOVED***"],
    reply: {
      mode: "command",
      cwd: "/Users/steipete/clawd",              // Clawd’s home/project context
      bodyPrefix: "ultrathink ",                 // prepended to every inbound body
      sessionIntro: "You are Clawd, an AI assistant running on the user's Mac. User writes messages via WhatsApp and you respond. This folder (/Users/steipete/clawd) is your personal workspace - you can store Markdown files, images, notes, and any data you like here. Keep WhatsApp replies under 1500 characters (platform limit), but feel free to save longer content to files in your folder.",
      command: [
        "claude",
        "--model",
        "claude-opus-4-5-20251101",
        "-p",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "{{BodyStripped}}"
      ],
      session: {
        scope: "per-sender",
        resetTriggers: ["/new"],
        idleMinutes: 10080,              // 7 days before a fresh session is forced
        heartbeatIdleMinutes: 10080,     // same window for heartbeat-based expiry
        sessionArgNew: ["--session-id", "{{SessionId}}"],
        sessionArgResume: ["--resume", "{{SessionId}}"],
        sessionArgBeforeBody: true,
        sendSystemOnce: true             // sessionIntro sent only on first turn
      },
      timeoutSeconds: 900
    }
  }
}
```

Key behaviors:
- **System prompt once:** `sessionIntro` is injected only on the first turn of each session because `sendSystemOnce=true`. Later turns only see the per-message prefix.
- **Per-message prefix:** Every inbound body gets `ultrathink ` prepended (`bodyPrefix`) before being passed to Claude.
- **Session stickiness:** Sessions are per-sender and live up to 7 days of inactivity; `/new` forces a reset.
- **Clawd’s home:** Claude runs in `/Users/steipete/clawd`, so it can read and write there.

## Heartbeats (proactive pings)
- Warelay can poll Claude on a cadence (default 30 m when `mode=command`) using the prompt body **`HEARTBEAT ultrathink`**.
- Claude is instructed (via `CLAUDE_IDENTITY_PREFIX`) to reply with exactly `HEARTBEAT_OK` when nothing needs attention. If that token is returned, the outbound message is suppressed but the event is logged.
- Replies without `HEARTBEAT_OK` (or with media) are forwarded as alerts. Suppressed heartbeats do **not** extend session `updatedAt`, so idle expiry still works.
- You can trigger one manually: `warelay heartbeat --provider web --to ***REMOVED*** --session-id <session-uuid> --verbose`.

## How the flow works
1. An inbound message (Twilio webhook, Twilio poller, or WhatsApp Web listener) arrives.
2. warelay enqueues the command in a process-wide FIFO queue so only one Claude run happens at a time (`src/process/command-queue.ts`).
3. Typing indicators are sent (Twilio) or `composing` presence is sent (Web) while Claude runs.
4. Claude stdout is parsed:
   - JSON mode is handled automatically if you set `claudeOutputFormat: "json"`; otherwise text is used.
   - If stdout contains `MEDIA:https://...` (or a local path), warelay strips it from the text, hosts the media if needed, and sends it along with the reply.
5. The reply (text and optional media) is sent back via the same provider that received the message.

## Media and attachments
- To send an image from Claude, include a line like `MEDIA:https://example.com/pic.jpg` in the output. warelay will:
  - Host local paths for Twilio using the media server/Tailscale Funnel.
  - Send buffers directly for the Web provider.
- Inbound media is downloaded (≤5 MB) and exposed to your templates as `{{MediaPath}}`, `{{MediaUrl}}`, and `{{MediaType}}`. You can mention this in your prompt if you want Claude to reason about the attachment.
- Outbound media from Claude (via `MEDIA:`) follows provider caps: Web resizes images to the configured target (`inbound.reply.mediaMaxMb`, default 5 MB) within hard limits of 6 MB (image), 16 MB (audio/video voice notes), and 100 MB (documents); Twilio still uses the Funnel host with a 5 MB guard.
- Voice notes: set `inbound.transcribeAudio.command` to run a CLI that emits the transcript to stdout (e.g., OpenAI Whisper: `openai api audio.transcriptions.create -m whisper-1 -f {{MediaPath}} --response-format text`). If it succeeds, warelay replaces `Body` with the transcript and adds the original media path plus a `Transcript:` block into the prompt before invoking Claude.
- To avoid re-sending long system prompts every turn, set `inbound.reply.session.sendSystemOnce: true` and keep your prompt in `sessionIntro`; use `bodyPrefix` for lightweight per-message tags (e.g., `ultrathink `).
- Typing indicators: for long-running Claude/command replies, `inbound.reply.typingIntervalSeconds` (or the session-level equivalent) refreshes the “composing” indicator periodically (default 8 s for command replies).

## Testing the setup
1. Start a relay (auto-selects Web when logged in, otherwise Twilio polling):
   ```sh
   warelay relay --provider auto --verbose
   ```
2. Send a WhatsApp message from an allowed number. Watch the terminal for:
   - Queue logs if multiple messages arrive close together.
   - Claude stderr (verbose) and timing info.
3. If you see `(command produced no output)`, check Claude CLI auth or model name.

## Troubleshooting tips
- Command takes too long: lower `timeoutSeconds` or simplify the prompt. Timeouts kill the Claude process.
- No reply: ensure the sender number is in `allowFrom` (or remove the allowlist), and confirm `claude login` was run in the same environment.
- Media fails on Twilio: run `warelay webhook --ingress tailscale` (or `warelay webhook --serve-media` via `send --serve-media`) so the media host is reachable over HTTPS.
- Stuck queue: enable `--verbose` to see “queued for …ms” messages and confirm commands are draining. Use `pnpm vitest` to run unit tests if you change queue logic.

## Minimal text-only variant
If you just want short text replies and no sessions:
```json5
{
  inbound: {
    reply: {
      mode: "command",
      command: ["claude", "{{Body}}"],
      claudeOutputFormat: "text"
    }
  }
}
```

This still benefits from the queue, typing indicators, and provider auto-selection.
