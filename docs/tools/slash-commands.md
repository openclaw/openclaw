---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Slash commands: text vs native, config, and supported commands"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Using or configuring chat commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging command routing or permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Slash Commands"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Slash commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Commands are handled by the Gateway. Most commands must be sent as a **standalone** message that starts with `/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The host-only bash chat command uses `! <cmd>` (with `/bash <cmd>` as an alias).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There are two related systems:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Commands**: standalone `/...` messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Directives are stripped from the message before the model sees it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - In normal chat messages (not directive-only), they are treated as “inline hints” and do **not** persist session settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - In directive-only messages (the message contains only directives), they persist to the session and reply with an acknowledgement.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Directives are only applied for **authorized senders**. If `commands.allowFrom` is set, it is the only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allowlist used; otherwise authorization comes from channel allowlists/pairing plus `commands.useAccessGroups`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Unauthorized senders see directives treated as plain text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There are also a few **inline shortcuts** (allowlisted/authorized senders only): `/help`, `/commands`, `/status`, `/whoami` (`/id`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
They run immediately, are stripped before the model sees the message, and the remaining text continues through the normal flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  commands: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    native: "auto",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    nativeSkills: "auto",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    text: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bashForegroundMs: 2000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    config: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    debug: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    restart: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allowFrom: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "*": ["user1"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      discord: ["user:123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    useAccessGroups: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.text` (default `true`) enables parsing `/...` in chat messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - On surfaces without native commands (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), text commands still work even if you set this to `false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.native` (default `"auto"`) registers native commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Auto: on for Discord/Telegram; off for Slack (until you add slash commands); ignored for providers without native support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Set `channels.discord.commands.native`, `channels.telegram.commands.native`, or `channels.slack.commands.native` to override per provider (bool or `"auto"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `false` clears previously registered commands on Discord/Telegram at startup. Slack commands are managed in the Slack app and are not removed automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.nativeSkills` (default `"auto"`) registers **skill** commands natively when supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Auto: on for Discord/Telegram; off for Slack (Slack requires creating a slash command per skill).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Set `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, or `channels.slack.commands.nativeSkills` to override per provider (bool or `"auto"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.bash` (default `false`) enables `! <cmd>` to run host shell commands (`/bash <cmd>` is an alias; requires `tools.elevated` allowlists).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.bashForegroundMs` (default `2000`) controls how long bash waits before switching to background mode (`0` backgrounds immediately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.config` (default `false`) enables `/config` (reads/writes `openclaw.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.debug` (default `false`) enables `/debug` (runtime-only overrides).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.allowFrom` (optional) sets a per-provider allowlist for command authorization. When configured, it is the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  only authorization source for commands and directives (channel allowlists/pairing and `commands.useAccessGroups`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  are ignored). Use `"*"` for a global default; provider-specific keys override it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.useAccessGroups` (default `true`) enforces allowlists/policies for commands when `commands.allowFrom` is not set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Text + native (when enabled):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/help`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/commands`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/skill <name> [input]` (run a skill by name)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status` (show current status; includes provider usage/quota for the current model provider when available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/allowlist` (list/add/remove allowlist entries)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/approve <id> allow-once|allow-always|deny` (resolve exec approval prompts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/context [list|detail|json]` (explain “context”; `detail` shows per-file + per-tool + per-skill + system prompt size)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/whoami` (show your sender id; alias: `/id`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/subagents list|stop|log|info|send` (inspect, stop, log, or message sub-agent runs for the current session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/config show|get|set|unset` (persist config to disk, owner-only; requires `commands.config: true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/debug show|set|unset|reset` (runtime overrides, owner-only; requires `commands.debug: true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage off|tokens|full|cost` (per-response usage footer or local cost summary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (control TTS; see [/tts](/tts))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discord: native command is `/voice` (Discord reserves `/tts`); text `/tts` still works.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/restart`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/dock-telegram` (alias: `/dock_telegram`) (switch replies to Telegram)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/dock-discord` (alias: `/dock_discord`) (switch replies to Discord)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/dock-slack` (alias: `/dock_slack`) (switch replies to Slack)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/activation mention|always` (groups only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/send on|off|inherit` (owner-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/reset` or `/new [model]` (optional model hint; remainder is passed through)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/think <off|minimal|low|medium|high|xhigh>` (dynamic choices by model/provider; aliases: `/thinking`, `/t`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/verbose on|full|off` (alias: `/v`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/reasoning on|off|stream` (alias: `/reason`; when on, sends a separate message prefixed `Reasoning:`; `stream` = Telegram draft only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated on|off|ask|full` (alias: `/elev`; `full` skips exec approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (send `/exec` to show current)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model <name>` (alias: `/models`; or `/<alias>` from `agents.defaults.models.*.alias`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/queue <mode>` (plus options like `debounce:2s cap:25 drop:summarize`; send `/queue` to see current settings)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/bash <command>` (host-only; alias for `! <command>`; requires `commands.bash: true` + `tools.elevated` allowlists)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Text-only:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/compact [instructions]` (see [/concepts/compaction](/concepts/compaction))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `! <command>` (host-only; one at a time; use `!poll` + `!stop` for long-running jobs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `!poll` (check output / status; accepts optional `sessionId`; `/bash poll` also works)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `!stop` (stop the running bash job; accepts optional `sessionId`; `/bash stop` also works)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands accept an optional `:` between the command and args (e.g. `/think: high`, `/send: on`, `/help:`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/new <model>` accepts a model alias, `provider/model`, or a provider name (fuzzy match); if no match, the text is treated as the message body.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For full provider usage breakdown, use `openclaw status --usage`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/allowlist add|remove` requires `commands.config=true` and honors channel `configWrites`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage` controls the per-response usage footer; `/usage cost` prints a local cost summary from OpenClaw session logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/restart` is disabled by default; set `commands.restart: true` to enable it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/verbose` is meant for debugging and extra visibility; keep it **off** in normal use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/reasoning` (and `/verbose`) are risky in group settings: they may reveal internal reasoning or tool output you did not intend to expose. Prefer leaving them off, especially in group chats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Fast path:** command-only messages from allowlisted senders are handled immediately (bypass queue + model).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Group mention gating:** command-only messages from allowlisted senders bypass mention requirements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Inline shortcuts (allowlisted senders only):** certain commands also work when embedded in a normal message and are stripped before the model sees the remaining text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Example: `hey /status` triggers a status reply, and the remaining text continues through the normal flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Currently: `/help`, `/commands`, `/status`, `/whoami` (`/id`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unauthorized command-only messages are silently ignored, and inline `/...` tokens are treated as plain text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Skill commands:** `user-invocable` skills are exposed as slash commands. Names are sanitized to `a-z0-9_` (max 32 chars); collisions get numeric suffixes (e.g. `_2`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `/skill <name> [input]` runs a skill by name (useful when native command limits prevent per-skill commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - By default, skill commands are forwarded to the model as a normal request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Skills may optionally declare `command-dispatch: tool` to route the command directly to a tool (deterministic, no model).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Example: `/prose` (OpenProse plugin) — see [OpenProse](/prose).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Native command arguments:** Discord uses autocomplete for dynamic options (and button menus when you omit required args). Telegram and Slack show a button menu when a command supports choices and you omit the arg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage surfaces (what shows where)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Provider usage/quota** (example: “Claude 80% left”) shows up in `/status` for the current model provider when usage tracking is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Per-response tokens/cost** is controlled by `/usage off|tokens|full` (appended to normal replies).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model status` is about **models/auth/endpoints**, not usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model selection (`/model`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/model` is implemented as a directive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model openai/gpt-5.2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model opus@anthropic:default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model` and `/model list` show a compact, numbered picker (model family + available providers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model <#>` selects from that picker (and prefers the current provider when possible).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model status` shows the detailed view, including configured provider endpoint (`baseUrl`) and API mode (`api`) when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debug overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/debug` lets you set **runtime-only** config overrides (memory, not disk). Owner-only. Disabled by default; enable with `commands.debug: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug show（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug set messages.responsePrefix="[openclaw]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug unset messages.responsePrefix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overrides apply immediately to new config reads, but do **not** write to `openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `/debug reset` to clear all overrides and return to the on-disk config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config updates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/config` writes to your on-disk config (`openclaw.json`). Owner-only. Disabled by default; enable with `commands.config: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/config show（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/config show messages.responsePrefix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/config get messages.responsePrefix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/config set messages.responsePrefix="[openclaw]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/config unset messages.responsePrefix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config is validated before write; invalid changes are rejected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/config` updates persist across restarts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Surface notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Text commands** run in the normal chat session (DMs share `main`, groups have their own session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Native commands** use isolated sessions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discord: `agent:<agentId>:discord:slash:<userId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefix configurable via `channels.slack.slashCommand.sessionPrefix`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram: `telegram:slash:<userId>` (targets the chat session via `CommandTargetSessionKey`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`/stop`** targets the active chat session so it can abort the current run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Slack:** `channels.slack.slashCommand` is still supported for a single `/openclaw`-style command. If you enable `commands.native`, you must create one Slack slash command per built-in command (same names as `/help`). Command argument menus for Slack are delivered as ephemeral Block Kit buttons.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
