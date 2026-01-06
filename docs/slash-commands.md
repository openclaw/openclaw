---
summary: "Slash commands: text vs native, config, and supported commands"
read_when:
  - Using or configuring chat commands
  - Debugging command routing or permissions
---
# Slash commands

Commands are handled by the Gateway. Send them as a **standalone** message that starts with `/`.
Inline text like `hello /status` is ignored.

## Config

```json5
{
  commands: {
    native: false,
    text: true,
    useAccessGroups: true
  }
}
```

- `commands.text` (default `true`) enables parsing `/...` in chat messages.
  - On surfaces without native commands (WhatsApp/WebChat/Signal/iMessage), text commands still work even if you set this to `false`.
- `commands.native` (default `false`) registers native commands on Discord/Slack/Telegram.
  - `false` clears previously registered commands on Discord/Telegram at startup.
  - Slack commands are managed in the Slack app and are not removed automatically.
- `commands.useAccessGroups` (default `true`) enforces allowlists/policies for commands.

## Command list

Text + native (when enabled):
- `/help`
- `/status`
- `/restart`
- `/activation mention|always` (groups only)
- `/send on|off|inherit` (owner-only)
- `/reset` or `/new`
- `/think <level>` (aliases: `/thinking`, `/t`)
- `/verbose on|off` (alias: `/v`)
- `/elevated on|off` (alias: `/elev`)
- `/model <name>`
- `/queue <mode>` (plus options like `debounce:2s cap:25 drop:summarize`)

Text-only:
- `/compact [instructions]`

## Surface notes

- **Text commands** run in the normal chat session (DMs share `main`, groups have their own session).
- **Native commands** use isolated sessions: `discord:slash:<userId>`, `slack:slash:<userId>`, `telegram:slash:<userId>`.
- **Slack:** `slack.slashCommand` is still supported for a single `/clawd`-style command. If you enable `commands.native`, you must create one Slack slash command per built-in command (same names as `/help`).
