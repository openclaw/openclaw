---
summary: "Slash commands: text vs native, config, and supported commands"
read_when:
  - Using or configuring chat commands
  - Debugging command routing or permissions
---
# Slash commands

Commands are handled by the Gateway. Most commands must be sent as a **standalone** message that starts with `/`.

There are two related systems:

- **Commands**: standalone `/...` messages.
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue`.
  - Directives are stripped from the message before the model sees it.
  - In normal chat messages (not directive-only), they are treated as “inline hints” and do **not** persist session settings.
  - In directive-only messages (the message contains only directives), they persist to the session and reply with an acknowledgement.

There are also a few **inline shortcuts** (allowlisted/authorized senders only): `/help`, `/commands`, `/status` (`/usage`), `/whoami` (`/id`).
They run immediately, are stripped before the model sees the message, and the remaining text continues through the normal flow.

## Config

```json5
{
  commands: {
    native: false,
    text: true,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true
  }
}
```

- `commands.text` (default `true`) enables parsing `/...` in chat messages.
  - On surfaces without native commands (WhatsApp/WebChat/Signal/iMessage/MS Teams), text commands still work even if you set this to `false`.
- `commands.native` (default `false`) registers native commands on Discord/Slack/Telegram.
  - `false` clears previously registered commands on Discord/Telegram at startup.
  - Slack commands are managed in the Slack app and are not removed automatically.
- `commands.config` (default `false`) enables `/config` (reads/writes `clawdbot.json`).
- `commands.debug` (default `false`) enables `/debug` (runtime-only overrides).
- `commands.useAccessGroups` (default `true`) enforces allowlists/policies for commands.

## Command list

Text + native (when enabled):
- `/help`
- `/commands`
- `/status` (show current status; includes a short usage line when available)
- `/usage` (alias: `/status`)
- `/whoami` (show your sender id; alias: `/id`)
- `/config show|get|set|unset` (persist config to disk, owner-only; requires `commands.config: true`)
- `/debug show|set|unset|reset` (runtime overrides, owner-only; requires `commands.debug: true`)
- `/cost on|off` (toggle per-response usage line)
- `/stop`
- `/restart`
- `/activation mention|always` (groups only)
- `/send on|off|inherit` (owner-only)
- `/reset` or `/new`
- `/think <level>` (aliases: `/thinking`, `/t`)
- `/verbose on|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; when on, sends a separate message prefixed `Reasoning:`; `stream` = Telegram draft only)
- `/elevated on|off` (alias: `/elev`)
- `/model <name>` (alias: `/models`; or `/<alias>` from `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus options like `debounce:2s cap:25 drop:summarize`; send `/queue` to see current settings)

Text-only:
- `/compact [instructions]` (see [/concepts/compaction](/concepts/compaction))

Notes:
- Commands accept an optional `:` between the command and args (e.g. `/think: high`, `/send: on`, `/help:`).
- `/status` and `/usage` show the same status output; for full provider usage breakdown, use `clawdbot status --usage`.
- `/cost` appends per-response token usage; it only shows dollar cost when the model uses an API key (OAuth hides cost).
- `/restart` is disabled by default; set `commands.restart: true` to enable it.
- `/verbose` is meant for debugging and extra visibility; keep it **off** in normal use.
- `/reasoning` (and `/verbose`) are risky in group settings: they may reveal internal reasoning or tool output you did not intend to expose. Prefer leaving them off, especially in group chats.
- **Fast path:** command-only messages from allowlisted senders are handled immediately (bypass queue + model).
- **Inline shortcuts (allowlisted senders only):** `/help`, `/commands`, `/status` (`/usage`), `/whoami` (`/id`) also work when embedded in text.
- Unauthorized command-only messages are silently ignored, and inline `/...` tokens are treated as plain text.

## Model selection (`/model`)

`/model` is implemented as a directive.

Examples:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:claude-cli
/model status
```

Notes:
- `/model` and `/model list` show a compact, numbered picker (model family + available providers).
- `/model <#>` selects from that picker (and prefers the current provider when possible).
- `/model status` shows the detailed view, including configured provider endpoint (`baseUrl`) and API mode (`api`) when available.

## Debug overrides

`/debug` lets you set **runtime-only** config overrides (memory, not disk). Owner-only. Disabled by default; enable with `commands.debug: true`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[clawdbot]"
/debug set whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notes:
- Overrides apply immediately to new config reads, but do **not** write to `clawdbot.json`.
- Use `/debug reset` to clear all overrides and return to the on-disk config.

## Config updates

`/config` writes to your on-disk config (`clawdbot.json`). Owner-only. Disabled by default; enable with `commands.config: true`.

Examples:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[clawdbot]"
/config unset messages.responsePrefix
```

Notes:
- Config is validated before write; invalid changes are rejected.
- `/config` updates persist across restarts.

## Surface notes

- **Text commands** run in the normal chat session (DMs share `main`, groups have their own session).
- **Native commands** use isolated sessions:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefix configurable via `slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (targets the chat session via `CommandTargetSessionKey`)
- **`/stop`** targets the active chat session so it can abort the current run.
- **Slack:** `slack.slashCommand` is still supported for a single `/clawd`-style command. If you enable `commands.native`, you must create one Slack slash command per built-in command (same names as `/help`).
