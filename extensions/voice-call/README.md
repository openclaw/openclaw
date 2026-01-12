# @clawdbot/voice-call

Official Voice Call plugin for **Clawdbot**.

- Provider: **Twilio** (real outbound calls)
- Dev fallback: `log` (no network)

Docs: `https://docs.clawd.bot/plugins/voice-call`
Plugin system: `https://docs.clawd.bot/plugin`

## Install (local dev)

### Option A: install via Clawdbot (recommended)

```bash
clawdbot plugins install @clawdbot/voice-call
```

Restart the Gateway afterwards.

### Option B: copy into your global extensions folder (dev)

```bash
mkdir -p ~/.clawdbot/extensions
cp -R extensions/voice-call ~/.clawdbot/extensions/voice-call
cd ~/.clawdbot/extensions/voice-call && pnpm install
```

### Option C: add via config (custom path)

```json5
{
  plugins: {
    load: { paths: ["/absolute/path/to/voice-call/index.ts"] },
    entries: { "voice-call": { enabled: true, config: { provider: "log" } } }
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
