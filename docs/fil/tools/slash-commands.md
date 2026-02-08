---
summary: "Slash commands: text vs native, config, at mga sinusuportahang command"
read_when:
  - Paggamit o pag-configure ng mga chat command
  - Pag-debug ng routing o mga pahintulot ng command
title: "Slash Commands"
x-i18n:
  source_path: tools/slash-commands.md
  source_hash: ca0deebf89518e8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:20Z
---

# Slash commands

Ang mga command ay hinahawakan ng Gateway. Karamihan sa mga command ay dapat ipadala bilang **standalone** na mensahe na nagsisimula sa `/`.
Ginagamit ng host-only na bash chat command ang `! <cmd>` (na may `/bash <cmd>` bilang alias).

May dalawang magkakaugnay na sistema:

- **Commands**: mga standalone na `/...` na mensahe.
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Tinatanggal ang mga directive mula sa mensahe bago ito makita ng model.
  - Sa normal na mga chat message (hindi directive-only), itinuturing silang “inline hints” at **hindi** nagpapanatili ng mga setting ng session.
  - Sa directive-only na mga mensahe (ang mensahe ay naglalaman lamang ng mga directive), nagpapanatili sila sa session at nagre-reply ng isang acknowledgement.
  - Ang mga directive ay ina-apply lamang para sa **awtorisadong mga sender** (channel allowlists/pairing kasama ang `commands.useAccessGroups`).
    Ang mga hindi awtorisadong sender ay makakakita ng mga directive na itinuturing bilang plain text.

Mayroon ding ilang **inline shortcuts** (allowlisted/awtorisadong sender lamang): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Agad silang tumatakbo, tinatanggal bago makita ng model ang mensahe, at ang natitirang teksto ay nagpapatuloy sa normal na daloy.

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
    useAccessGroups: true,
  },
}
```

- `commands.text` (default `true`) ay nag-e-enable ng pag-parse ng `/...` sa mga chat message.
  - Sa mga surface na walang native commands (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), gumagana pa rin ang mga text command kahit itakda mo ito sa `false`.
- `commands.native` (default `"auto"`) ay nagrerehistro ng mga native command.
  - Auto: naka-on para sa Discord/Telegram; naka-off para sa Slack (hanggang magdagdag ka ng slash commands); hindi pinapansin para sa mga provider na walang native support.
  - Itakda ang `channels.discord.commands.native`, `channels.telegram.commands.native`, o `channels.slack.commands.native` para i-override kada provider (bool o `"auto"`).
  - Nililinis ng `false` ang mga naunang nairehistrong command sa Discord/Telegram sa startup. Ang mga Slack command ay pinamamahalaan sa Slack app at hindi awtomatikong inaalis.
- `commands.nativeSkills` (default `"auto"`) ay nagrerehistro ng mga **skill** command nang native kapag sinusuportahan.
  - Auto: naka-on para sa Discord/Telegram; naka-off para sa Slack (kinakailangan ng Slack ang paggawa ng isang slash command kada skill).
  - Itakda ang `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, o `channels.slack.commands.nativeSkills` para i-override kada provider (bool o `"auto"`).
- `commands.bash` (default `false`) ay nag-e-enable sa `! <cmd>` na magpatakbo ng mga host shell command (`/bash <cmd>` ay isang alias; nangangailangan ng `tools.elevated` allowlists).
- `commands.bashForegroundMs` (default `2000`) ay kumokontrol kung gaano katagal maghihintay ang bash bago lumipat sa background mode (`0` ay agad na nagba-background).
- `commands.config` (default `false`) ay nag-e-enable sa `/config` (nagbabasa/nagsusulat ng `openclaw.json`).
- `commands.debug` (default `false`) ay nag-e-enable sa `/debug` (runtime-only na mga override).
- `commands.useAccessGroups` (default `true`) ay nagpapatupad ng mga allowlist/patakaran para sa mga command.

## Command list

Text + native (kapag naka-enable):

- `/help`
- `/commands`
- `/skill <name> [input]` (magpatakbo ng skill ayon sa pangalan)
- `/status` (ipakita ang kasalukuyang status; kasama ang provider usage/quota para sa kasalukuyang model provider kapag available)
- `/allowlist` (ilista/idagdag/alisin ang mga entry ng allowlist)
- `/approve <id> allow-once|allow-always|deny` (i-resolve ang mga exec approval prompt)
- `/context [list|detail|json]` (ipaliwanag ang “context”; ipinapakita ng `detail` ang per-file + per-tool + per-skill + laki ng system prompt)
- `/whoami` (ipakita ang iyong sender id; alias: `/id`)
- `/subagents list|stop|log|info|send` (suriin, ihinto, i-log, o i-message ang mga sub-agent run para sa kasalukuyang session)
- `/config show|get|set|unset` (i-persist ang config sa disk, owner-only; nangangailangan ng `commands.config: true`)
- `/debug show|set|unset|reset` (runtime overrides, owner-only; nangangailangan ng `commands.debug: true`)
- `/usage off|tokens|full|cost` (per-response na usage footer o lokal na cost summary)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (kontrolin ang TTS; tingnan ang [/tts](/tts))
  - Discord: ang native command ay `/voice` (nirereserba ng Discord ang `/tts`); gumagana pa rin ang text `/tts`.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (ilipat ang mga reply sa Telegram)
- `/dock-discord` (alias: `/dock_discord`) (ilipat ang mga reply sa Discord)
- `/dock-slack` (alias: `/dock_slack`) (ilipat ang mga reply sa Slack)
- `/activation mention|always` (mga grupo lamang)
- `/send on|off|inherit` (owner-only)
- `/reset` o `/new [model]` (opsyonal na model hint; ang natitira ay ipinapasa)
- `/think <off|minimal|low|medium|high|xhigh>` (dynamic na mga pagpipilian ayon sa model/provider; mga alias: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; kapag naka-on, nagpapadala ng hiwalay na mensahe na may prefix na `Reasoning:`; `stream` = Telegram draft lamang)
- `/elevated on|off|ask|full` (alias: `/elev`; nilalampasan ng `full` ang mga exec approval)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (magpadala ng `/exec` para ipakita ang kasalukuyan)
- `/model <name>` (alias: `/models`; o `/<alias>` mula sa `agents.defaults.models.*.alias`)
- `/queue <mode>` (kasama ang mga opsyon tulad ng `debounce:2s cap:25 drop:summarize`; magpadala ng `/queue` para makita ang kasalukuyang mga setting)
- `/bash <command>` (host-only; alias para sa `! <command>`; nangangailangan ng `commands.bash: true` + `tools.elevated` allowlists)

Text-only:

- `/compact [instructions]` (tingnan ang [/concepts/compaction](/concepts/compaction))
- `! <command>` (host-only; isa-isa; gamitin ang `!poll` + `!stop` para sa mga long-running na job)
- `!poll` (suriin ang output / status; tumatanggap ng opsyonal na `sessionId`; gumagana rin ang `/bash poll`)
- `!stop` (ihinto ang tumatakbong bash job; tumatanggap ng opsyonal na `sessionId`; gumagana rin ang `/bash stop`)

Mga tala:

- Tumatanggap ang mga command ng opsyonal na `:` sa pagitan ng command at mga arg (hal. `/think: high`, `/send: on`, `/help:`).
- Tumatanggap ang `/new <model>` ng model alias, `provider/model`, o pangalan ng provider (fuzzy match); kung walang tugma, itinuturing ang teksto bilang body ng mensahe.
- Para sa buong breakdown ng provider usage, gamitin ang `openclaw status --usage`.
- Ang `/allowlist add|remove` ay nangangailangan ng `commands.config=true` at iginagalang ang channel `configWrites`.
- Kinokontrol ng `/usage` ang per-response na usage footer; ang `/usage cost` ay nagpi-print ng lokal na cost summary mula sa mga log ng OpenClaw session.
- Ang `/restart` ay naka-disable bilang default; itakda ang `commands.restart: true` para i-enable ito.
- Ang `/verbose` ay para sa pag-debug at dagdag na visibility; panatilihing **off** sa normal na paggamit.
- Ang `/reasoning` (at `/verbose`) ay delikado sa mga group setting: maaari nilang ilantad ang internal reasoning o tool output na hindi mo balak ilabas. Mas mainam na iwanan silang naka-off, lalo na sa mga group chat.
- **Fast path:** ang mga command-only na mensahe mula sa allowlisted na sender ay hinahawakan agad (nilalampasan ang queue + model).
- **Group mention gating:** ang mga command-only na mensahe mula sa allowlisted na sender ay nilalampasan ang mga kinakailangan sa mention.
- **Inline shortcuts (allowlisted sender lamang):** ang ilang command ay gumagana rin kapag naka-embed sa isang normal na mensahe at tinatanggal bago makita ng model ang natitirang teksto.
  - Halimbawa: ang `hey /status` ay nagti-trigger ng status reply, at ang natitirang teksto ay nagpapatuloy sa normal na daloy.
- Sa kasalukuyan: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Ang mga hindi awtorisadong command-only na mensahe ay tahimik na binabalewala, at ang mga inline `/...` token ay itinuturing bilang plain text.
- **Skill commands:** ang mga `user-invocable` na skill ay inilalantad bilang slash commands. Nililinis ang mga pangalan sa `a-z0-9_` (max 32 chars); ang mga banggaan ay binibigyan ng numeric na suffix (hal. `_2`).
  - Pinapatakbo ng `/skill <name> [input]` ang isang skill ayon sa pangalan (kapaki-pakinabang kapag ang mga limitasyon ng native command ay pumipigil sa per-skill na mga command).
  - Bilang default, ang mga skill command ay ipinapasa sa model bilang isang normal na request.
  - Maaaring opsyonal na magdeklara ang mga Skill ng `command-dispatch: tool` upang i-route ang command direkta sa isang tool (deterministic, walang model).
  - Halimbawa: `/prose` (OpenProse plugin) — tingnan ang [OpenProse](/prose).
- **Native command arguments:** gumagamit ang Discord ng autocomplete para sa mga dynamic na opsyon (at mga button menu kapag tinanggal mo ang kinakailangang arg). Ang Telegram at Slack ay nagpapakita ng button menu kapag ang isang command ay sumusuporta sa mga pagpipilian at tinanggal mo ang arg.

## Usage surfaces (ano ang lumalabas saan)

- **Provider usage/quota** (halimbawa: “Claude 80% left”) ay lumalabas sa `/status` para sa kasalukuyang model provider kapag naka-enable ang usage tracking.
- **Per-response tokens/cost** ay kinokontrol ng `/usage off|tokens|full` (idinadagdag sa mga normal na reply).
- Ang `/model status` ay tungkol sa **models/auth/endpoints**, hindi usage.

## Model selection (`/model`)

Ang `/model` ay ipinatutupad bilang isang directive.

Mga halimbawa:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Mga tala:

- Ang `/model` at `/model list` ay nagpapakita ng compact, may bilang na picker (model family + mga available na provider).
- Pinipili ng `/model <#>` mula sa picker na iyon (at mas pinipili ang kasalukuyang provider kapag posible).
- Ipinapakita ng `/model status` ang detalyadong view, kabilang ang naka-configure na provider endpoint (`baseUrl`) at API mode (`api`) kapag available.

## Debug overrides

Pinapahintulutan ng `/debug` ang pagtatakda ng **runtime-only** na mga config override (memory, hindi disk). Owner-only. Naka-disable bilang default; i-enable gamit ang `commands.debug: true`.

Mga halimbawa:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Mga tala:

- Agad na ina-apply ang mga override sa mga bagong pagbasa ng config, ngunit **hindi** nagsusulat sa `openclaw.json`.
- Gamitin ang `/debug reset` para i-clear ang lahat ng override at bumalik sa on-disk na config.

## Config updates

Ang `/config` ay nagsusulat sa iyong on-disk na config (`openclaw.json`). Owner-only. Naka-disable bilang default; i-enable gamit ang `commands.config: true`.

Mga halimbawa:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Mga tala:

- Binabalidate ang config bago magsulat; tinatanggihan ang mga invalid na pagbabago.
- Ang mga update ng `/config` ay nagpapatuloy kahit mag-restart.

## Surface notes

- **Text commands** ay tumatakbo sa normal na chat session (ang mga DM ay nagbabahagi ng `main`, ang mga grupo ay may sariling session).
- **Native commands** ay gumagamit ng mga hiwalay na session:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (ang prefix ay configurable sa pamamagitan ng `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (tinutumbok ang chat session sa pamamagitan ng `CommandTargetSessionKey`)
- Ang **`/stop`** ay tumutumbok sa aktibong chat session upang ma-abort nito ang kasalukuyang run.
- **Slack:** sinusuportahan pa rin ang `channels.slack.slashCommand` para sa iisang `/openclaw`-style na command. Kung i-enable mo ang `commands.native`, kailangan mong gumawa ng isang Slack slash command kada built-in na command (parehong mga pangalan gaya ng `/help`). Ang mga command argument menu para sa Slack ay inihahatid bilang ephemeral na Block Kit buttons.
