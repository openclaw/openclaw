# Voice Call Plugin (Placeholder)

This is a **stub** plugin used to validate the Clawdbot plugin API.
It does not place real calls yet.

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
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } }
    }
  }
}
```

Restart the Gateway after changes.

## CLI

```bash
clawdbot voicecall status
clawdbot voicecall start --to "+15555550123" --message "Hello"
```

## Tool

Tool name: `voice_call`

Parameters:
- `mode`: `"call" | "status"`
- `to`: target string
- `message`: optional intro text

## Gateway RPC

- `voicecall.status`

## Skill

The repo includes `skills/voice-call/SKILL.md` for agent guidance. Enable it by
setting:

```json5
{ plugins: { entries: { "voice-call": { enabled: true } } } }
```

## Notes

- This plugin is a placeholder. Implement your real call flow in the tool and
  RPC handlers.
- Use `voicecall.*` for RPC names and `voice_call` for tool naming consistency.
