# Voice Call Plugin

Twilio-backed outbound voice calls (with a log-only fallback for dev).

## Install (local dev)

Option 1: copy into your global extensions folder:

```bash
mkdir -p ~/.clawdbot/extensions
cp -R extensions/voice-call ~/.clawdbot/extensions/voice-call
cd ~/.clawdbot/extensions/voice-call && pnpm install
```

Option 2: add via config:

```json5
{
  plugins: {
    load: { paths: ["/absolute/path/to/extensions/voice-call"] },
    entries: { "voice-call": { enabled: true } }
  }
}
```

Restart the Gateway after changes.

## Config

Put under `plugins.entries.voice-call.config`:

```json5
{
  provider: "twilio",
  twilio: {
    accountSid: "ACxxxxxxxx",
    authToken: "your_token",
    from: "+15551234567",
    statusCallbackUrl: "https://example.com/twilio-status", // optional
    twimlUrl: "https://example.com/twiml" // optional, else auto-generates <Say>
  }
}
```

Dev fallback (no network):

```json5
{ provider: "log" }
```

## CLI

```bash
clawdbot voicecall start --to "+15555550123" --message "Hello from Clawdbot"
clawdbot voicecall status --sid CAxxxxxxxx
```

## Tool

Tool name: `voice_call`

Parameters:
- `mode`: `"call" | "status"` (default: `call`)
- `to`: target string (required for call)
- `sid`: call SID (required for status)
- `message`: optional intro text

## Gateway RPC

- `voicecall.start` (to, message?)
- `voicecall.status` (sid)

## Skill

The repo includes `skills/voice-call/SKILL.md` for agent guidance. Enable it by
setting:

```json5
{ plugins: { entries: { "voice-call": { enabled: true } } } }
```

## Notes

- Uses Twilio REST API via fetch (no SDK). Provide valid SID/token/from.
- Use `voicecall.*` for RPC names and `voice_call` for tool naming consistency.
