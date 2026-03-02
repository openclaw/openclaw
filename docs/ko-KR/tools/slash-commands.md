---
summary: "Slash commands: text vs native, config, and supported commands"
read_when:
  - Using or configuring chat commands
  - Debugging command routing or permissions
title: "Slash Commands"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/slash-commands.md
workflow: 15
---

# Slash commands

Commands 는 Gateway 에 의해 처리됩니다. 대부분의 commands 는 **standalone** message 로 sent 되어야 하며 `/` 로 시작해야 합니다.
Host-only bash chat command 는 `! <cmd>` (with `/bash <cmd>` as an alias) 를 사용합니다.

관련된 두 시스템이 있습니다:

- **Commands**: standalone `/...` messages.
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Directives 은 model 이 보기 전에 message 에서 stripped 됩니다.
  - Normal chat messages (not directive-only) 에서, 이들은 "inline hints" 로 취급되며 session settings 를 **persist 하지 않습니다**.
  - Directive-only messages (the message contains only directives) 에서, 이들은 session 에 persist 되고 acknowledgement 로 reply 합니다.
  - Directives 은 **authorized senders** 에게만 applied 됩니다. `commands.allowFrom` 이 set 된 경우, it is the only allowlist 이 사용됩니다; otherwise authorization 은 channel allowlists/pairing 과 `commands.useAccessGroups` 에서 옵니다.
    Unauthorized senders 는 directives 을 plain text 로 취급합니다.

또한 몇 **inline shortcuts** (allowlisted/authorized senders only) 가 있습니다: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
이들은 immediately run 하고, model 이 보기 전에 stripped 되며, remaining text 는 normal flow 를 통해 계속됩니다.

## Config

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

- `commands.text` (default `true`) 는 chat messages 에서 `/...` parsing 을 활성화합니다.
  - Native commands 가 없는 surfaces 에서 (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), text commands 는 이 설정을 `false` 로 설정하더라도 여전히 작동합니다.
- `commands.native` (default `"auto"`) 는 native commands 를 registers 합니다.
  - Auto: Discord/Telegram 에서 on; Slack 에서 off (slash commands 를 추가할 때까지); native support 가 없는 providers 에게는 무시됩니다.
  - `channels.discord.commands.native`, `channels.telegram.commands.native`, 또는 `channels.slack.commands.native` 를 set 하여 provider 별로 override 합니다 (bool 또는 `"auto"`).
  - `false` 는 startup 에서 Discord/Telegram 에서 이전에 registered 된 commands 를 clears 합니다. Slack commands 는 Slack app 에서 managed 되고 automatically removed 되지 않습니다.
- `commands.nativeSkills` (default `"auto"`) 는 supported 할 때 **skill** commands 를 natively registers 합니다.
  - Auto: Discord/Telegram 에서 on; Slack 에서 off (Slack 은 각 skill 마다 slash command 생성이 필요함).
  - `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, 또는 `channels.slack.commands.nativeSkills` 를 set 하여 provider 별로 override 합니다 (bool 또는 `"auto"`).
- `commands.bash` (default `false`) 는 `! <cmd>` 를 enable 하여 host shell commands 를 run 합니다 (`/bash <cmd>` 는 alias; requires `tools.elevated` allowlists).
- `commands.bashForegroundMs` (default `2000`) 는 bash 이 background mode 로 switch 하기 전에 얼마나 오래 기다릴지 controls 합니다 (`0` 은 immediately background).
- `commands.config` (default `false`) 는 `/config` 를 enable 합니다 (reads/writes `openclaw.json`).
- `commands.debug` (default `false`) 는 `/debug` 를 enable 합니다 (runtime-only overrides).
- `commands.allowFrom` (optional) 은 command authorization 을 위해 per-provider allowlist 를 set 합니다. Configured 될 때, it is the only authorization source for commands 과 directives 입니다 (channel allowlists/pairing 과 `commands.useAccessGroups` 은 무시됨). `"*"` 를 사용하여 global default; provider-specific keys 는 override 합니다.
- `commands.useAccessGroups` (default `true`) 는 `commands.allowFrom` 이 set 되지 않았을 때 commands 에 allowlists/policies 를 enforces 합니다.

## Command list

Text + native (when enabled):

- `/help`
- `/commands`
- `/skill <name> [input]` (run a skill by name)
- `/status` (show current status; includes provider usage/quota for the current model provider when available)
- `/allowlist` (list/add/remove allowlist entries)
- `/approve <id> allow-once|allow-always|deny` (resolve exec approval prompts)
- `/context [list|detail|json]` (explain "context"; `detail` shows per-file + per-tool + per-skill + system prompt size)
- `/export-session [path]` (alias: `/export`) (export current session to HTML with full system prompt)
- `/whoami` (show your sender id; alias: `/id`)
- `/session idle <duration|off>` (manage inactivity auto-unfocus for focused thread bindings)
- `/session max-age <duration|off>` (manage hard max-age auto-unfocus for focused thread bindings)
- `/subagents list|kill|log|info|send|steer|spawn` (inspect, control, or spawn sub-agent runs for the current session)
- `/acp spawn|cancel|steer|close|status|set-mode|set|cwd|permissions|timeout|model|reset-options|doctor|install|sessions` (inspect and control ACP runtime sessions)
- `/agents` (list thread-bound agents for this session)
- `/focus <target>` (Discord: bind this thread, or a new thread, to a session/subagent target)
- `/unfocus` (Discord: remove the current thread binding)
- `/kill <id|#|all>` (immediately abort one or all running sub-agents for this session; no confirmation message)
- `/steer <id|#> <message>` (steer a running sub-agent immediately: in-run when possible, otherwise abort current work and restart on the steer message)
- `/tell <id|#> <message>` (alias for `/steer`)
- `/config show|get|set|unset` (persist config to disk, owner-only; requires `commands.config: true`)
- `/debug show|set|unset|reset` (runtime overrides, owner-only; requires `commands.debug: true`)
- `/usage off|tokens|full|cost` (per-response usage footer or local cost summary)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (control TTS; see [/tts](/tts))
  - Discord: native command 는 `/voice` (Discord reserves `/tts`); text `/tts` 는 여전히 작동합니다.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (switch replies to Telegram)
- `/dock-discord` (alias: `/dock_discord`) (switch replies to Discord)
- `/dock-slack` (alias: `/dock_slack`) (switch replies to Slack)
- `/activation mention|always` (groups only)
- `/send on|off|inherit` (owner-only)
- `/reset` or `/new [model]` (optional model hint; remainder is passed through)
- `/think <off|minimal|low|medium|high|xhigh>` (dynamic choices by model/provider; aliases: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; when on, sends a separate message prefixed `Reasoning:`; `stream` = Telegram draft only)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` skips exec approvals)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (send `/exec` to show current)
- `/model <name>` (alias: `/models`; or `/<alias>` from `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus options like `debounce:2s cap:25 drop:summarize`; send `/queue` to see current settings)
- `/bash <command>` (host-only; alias for `! <command>`; requires `commands.bash: true` + `tools.elevated` allowlists)

Text-only:

- `/compact [instructions]` (see [/concepts/compaction](/concepts/compaction))
- `! <command>` (host-only; one at a time; use `!poll` + `!stop` for long-running jobs)
- `!poll` (check output / status; accepts optional `sessionId`; `/bash poll` also works)
- `!stop` (stop the running bash job; accepts optional `sessionId`; `/bash stop` also works)

Notes:

- Commands 는 optional `:` between the command 와 args 를 accept 합니다 (예: `/think: high`, `/send: on`, `/help:`).
- `/new <model>` 는 model alias, `provider/model`, 또는 provider name (fuzzy match) 를 accept 합니다; match 가 없으면, text 는 message body 로 treated 됩니다.
- Full provider usage breakdown 의 경우, `openclaw status --usage` 를 사용합니다.
- `/allowlist add|remove` 는 `commands.config=true` 를 require 하고 channel `configWrites` 를 honors 합니다.
- `/usage` 는 per-response usage footer 를 controls 합니다; `/usage cost` 는 OpenClaw session logs 에서 local cost summary 를 prints 합니다.
- `/restart` 는 기본적으로 enabled 됩니다; `commands.restart: false` 로 set 하여 disable 합니다.
- Discord-only native command: `/vc join|leave|status` 는 voice channels 를 controls 합니다 (requires `channels.discord.voice` 및 native commands; not available as text).
- Discord thread-binding commands (`/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`) 는 effective thread bindings 이 enabled 된 경우에 require 됩니다 (`session.threadBindings.enabled` 과/또는 `channels.discord.threadBindings.enabled`).
- ACP command reference 및 runtime behavior: [ACP Agents](/tools/acp-agents).
- `/verbose` 는 debugging 및 extra visibility 를 위해 의도됩니다; normal use 에서 keep it **off**.
- Tool failure summaries 는 relevant 할 때 여전히 shown 이 되지만, detailed failure text 는 `/verbose` 이 `on` 또는 `full` 일 때만 included 됩니다.
- `/reasoning` (그리고 `/verbose`) 는 group settings 에서 risky 입니다: 이들은 internal reasoning 또는 tool output 을 reveal 할 수 있습니다 expose 하도록 의도하지 않았습니다. 특히 group chats 에서 leave them off 를 선호합니다.
- **Fast path:** command-only messages from allowlisted senders 는 immediately handled 됩니다 (bypass queue + model).
- **Group mention gating:** command-only messages from allowlisted senders 는 mention requirements 를 bypass 합니다.
- **Inline shortcuts (allowlisted senders only):** certain commands 는 또한 normal message 에 embedded 될 때 작동하고 model 이 보기 전에 stripped 됩니다.
  - Example: `hey /status` 는 status reply 를 triggers 하고, remaining text 는 normal flow 를 통해 계속됩니다.
- Currently: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Unauthorized command-only messages 는 silently ignored 되고, inline `/...` tokens 은 plain text 로 treated 됩니다.
- **Skill commands:** `user-invocable` skills 는 slash commands 로 exposed 됩니다. Names 은 `a-z0-9_` 로 sanitized 되고 (max 32 chars); collisions 은 numeric suffixes 를 얻습니다 (예: `_2`).
  - `/skill <name> [input]` 는 skill 을 name 으로 runs 합니다 (useful when native command limits 는 per-skill commands 를 prevent 합니다).
  - 기본적으로, skill commands 는 model 로 normal request 로 forwarded 됩니다.
  - Skills 는 optional 하게 `command-dispatch: tool` 를 declare 할 수 있습니다 to route the command directly to a tool (deterministic, no model).
  - Example: `/prose` (OpenProse plugin) — [OpenProse](/prose) 를 참고합니다.
- **Native command arguments:** Discord 는 dynamic options 를 위해 autocomplete 를 사용합니다 (그리고 button menus when you omit required args). Telegram 과 Slack 는 command 가 choices 를 support 할 때 button menu 를 보여줍니다 and you omit the arg.

## Usage surfaces (what shows where)

- **Provider usage/quota** (example: "Claude 80% left") 는 usage tracking 이 enabled 될 때 `/status` 에서 current model provider 에 나타납니다.
- **Per-response tokens/cost** 는 `/usage off|tokens|full` (appended to normal replies) 로 controlled 됩니다.
- `/model status` 는 about **models/auth/endpoints**, not usage 입니다.

## Model selection (`/model`)

`/model` 은 directive 로 implemented 됩니다.

Examples:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Notes:

- `/model` 과 `/model list` 는 compact, numbered picker 를 show 합니다 (model family + available providers).
- Discord 에서, `/model` 및 `/models` 는 provider 와 model dropdowns plus a Submit step 으로 interactive picker 를 open 합니다.
- `/model <#>` 는 that picker 에서 select 하고 (그리고 prefer the current provider when possible).
- `/model status` 는 detailed view 를 show 합니다, including configured provider endpoint (`baseUrl`) 과 API mode (`api`) when available.

## Debug overrides

`/debug` 는 **runtime-only** config overrides 를 let 합니다 (memory, not disk). Owner-only. Disabled by default; enable with `commands.debug: true`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notes:

- Overrides 은 immediately new config reads 에 apply 되지만, `openclaw.json` 에 do **not** write 합니다.
- `/debug reset` 을 use 하여 모든 overrides 를 clear 하고 on-disk config 로 return 합니다.

## Config updates

`/config` 는 on-disk config (`openclaw.json`) 에 writes 합니다. Owner-only. Disabled by default; enable with `commands.config: true`.

Examples:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notes:

- Config 는 write 전에 validated 됩니다; invalid changes 는 rejected 입니다.
- `/config` updates 는 restarts 를 통해 persist 합니다.

## Surface notes

- **Text commands** 는 normal chat session 에서 run 합니다 (DMs share `main`, groups 는 their own session 을 갖습니다).
- **Native commands** 는 isolated sessions 를 use 합니다:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefix configurable via `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (targets the chat session via `CommandTargetSessionKey`)
- **`/stop`** 는 active chat session 을 target 하므로 current run 을 abort 할 수 있습니다.
- **Slack:** `channels.slack.slashCommand` 는 여전히 single `/openclaw`-style command 를 위해 supported 됩니다. `commands.native` 를 enable 하면, 각 built-in command (same names as `/help`) 마다 하나의 Slack slash command 를 create 해야 합니다. Command argument menus for Slack 는 ephemeral Block Kit buttons 로 delivered 됩니다.
  - Slack native exception: `/agentstatus` 를 register 합니다 (not `/status`) because Slack reserves `/status`. Text `/status` 는 여전히 Slack messages 에서 작동합니다.
