---
summary: "Voice Call plugin: Twilio-backed outbound calls (plugin install + config + CLI)"
read_when:
  - You want to place an outbound voice call from Clawdbot
  - You are configuring or developing the voice-call plugin
---

# Voice Call (plugin)

Outbound voice calls for Clawdbot via a plugin.

If you’re new to plugins, start with [Plugins](/plugin): what they are, where
they live on disk, and how install/config works.

Current providers:
- `twilio` (real calls)
- `log` (dev fallback; no network)

Quick mental model:
- Install plugin
- Restart Gateway
- Configure under `plugins.entries.voice-call.config`
- Use `clawdbot voicecall …` or the `voice_call` tool

## Install

### Option A: install from npm (recommended)

```bash
clawdbot plugins install @clawdbot/voice-call
```

This downloads the package, extracts it into `~/.clawdbot/extensions/`, and enables it in `clawdbot.json`.

Restart the Gateway afterwards.

### Option B: install from a local folder (dev, no copying)

This keeps the plugin in-place (great for iterating locally) and adds the folder
to `plugins.load.paths`.

```bash
clawdbot plugins install /absolute/path/to/voice-call
```

If your plugin has dependencies, install them in that folder (so it has a
`node_modules`):

```bash
cd /absolute/path/to/voice-call && pnpm install
```

Restart the Gateway afterwards.

### Option C: copy into the global extensions folder (dev)

```bash
mkdir -p ~/.clawdbot/extensions
cp -R extensions/voice-call ~/.clawdbot/extensions/voice-call
cd ~/.clawdbot/extensions/voice-call && pnpm install
```

Restart the Gateway afterwards.

## Config

Set config under `plugins.entries.voice-call.config`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "…",
            from: "+15551234567",
            statusCallbackUrl: "https://example.com/twilio-status", // optional
            twimlUrl: "https://example.com/twiml" // optional
          }
        }
      }
    }
  }
}
```

Dev fallback:

```json5
{ provider: "log" }
```

Notes:
- `twilio.authToken` is treated as sensitive in the Control UI schema hints.

## CLI

```bash
clawdbot voicecall start --to "+15555550123" --message "Hello from Clawdbot"
clawdbot voicecall status --sid CAxxxxxxxx
```

## Agent tool

Tool name: `voice_call`

- `mode`: `"call" | "status"` (default: `call`)
- `to`: required for `call`
- `sid`: required for `status`
- `message`: optional

This repo ships a matching skill doc at `skills/voice-call/SKILL.md`.

## Gateway RPC

- `voicecall.start` (`to`, optional `message`)
- `voicecall.status` (`sid`)
