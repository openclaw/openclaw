---
summary: "Slash command များ — စာသား vs native, config နှင့် ပံ့ပိုးထားသော command များ"
read_when:
  - chat command များကို အသုံးပြုခြင်း သို့မဟုတ် ဖွဲ့စည်းပြင်ဆင်ခြင်း
  - command routing သို့မဟုတ် permission များကို debug လုပ်နေစဉ်
title: "Slash Commands"
x-i18n:
  source_path: tools/slash-commands.md
  source_hash: ca0deebf89518e8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:40Z
---

# Slash commands

Command များကို Gateway မှ ကိုင်တွယ်ဆောင်ရွက်သည်။ Command အများစုကို `/` ဖြင့် စတင်သော **သီးသန့်** မက်ဆေ့ချ်အဖြစ် ပို့ရပါသည်။
host-only bash chat command သည် `! <cmd>` ကို အသုံးပြုသည် (`/bash <cmd>` ကို alias အဖြစ်ပါ အသုံးပြုနိုင်သည်)။

ဆက်စပ်သော စနစ် ၂ ခု ရှိပါသည်–

- **Commands**: သီးသန့် `/...` မက်ဆေ့ချ်များ။
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`။
  - Directive များကို မော်ဒယ်က မမြင်မီ မက်ဆေ့ချ်မှ ဖယ်ရှားပစ်ပါသည်။
  - ပုံမှန် chat မက်ဆေ့ချ်များတွင် (directive-only မဟုတ်ပါက) ၎င်းတို့ကို “inline hints” အဖြစ် သတ်မှတ်ပြီး session setting များကို **မသိမ်းဆည်းပါ**။
  - directive-only မက်ဆေ့ချ်များတွင် (မက်ဆေ့ချ်ထဲတွင် directive များသာ ပါဝင်ပါက) session ထဲသို့ သိမ်းဆည်းပြီး acknowledgement ဖြင့် ပြန်လည်တုံ့ပြန်ပါသည်။
  - Directive များကို **authorized senders** များအတွက်သာ အသုံးချပါသည် (channel allowlists/pairing နှင့် `commands.useAccessGroups`)။
    Authorized မဟုတ်သော ပို့သူများအတွက် directive များကို ပုံမှန် စာသားအဖြစ်သာ ကိုင်တွယ်ပါသည်။

ထို့အပြင် **inline shortcuts** အချို့လည်း ရှိပါသည် (allowlisted/authorized senders များအတွက်သာ)– `/help`, `/commands`, `/status`, `/whoami` (`/id`)။
၎င်းတို့ကို ချက်ချင်း လုပ်ဆောင်ပြီး မော်ဒယ် မမြင်မီ ဖယ်ရှားပစ်ကာ ကျန်ရှိသော စာသားကို ပုံမှန် flow အတိုင်း ဆက်လက် လုပ်ဆောင်ပါသည်။

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

- `commands.text` (default `true`) သည် chat မက်ဆေ့ချ်များအတွင်း `/...` ကို parse လုပ်နိုင်စေပါသည်။
  - native command မရှိသော surface များတွင် (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams) ဤတန်ဖိုးကို `false` သတ်မှတ်ထားသော်လည်း text command များသည် ဆက်လက် အလုပ်လုပ်ပါသည်။
- `commands.native` (default `"auto"`) သည် native command များကို register လုပ်ပါသည်။
  - Auto: Discord/Telegram အတွက် ဖွင့်ထားသည်; Slack အတွက် ပိတ်ထားသည် (slash command များ ထည့်သွင်းမချင်း); native support မရှိသော provider များအတွက် လျစ်လျူရှုပါသည်။
  - Provider တစ်ခုချင်းစီအလိုက် override လုပ်ရန် `channels.discord.commands.native`, `channels.telegram.commands.native`, သို့မဟုတ် `channels.slack.commands.native` ကို သတ်မှတ်နိုင်သည် (bool သို့မဟုတ် `"auto"`)။
  - `false` သည် startup အချိန်တွင် Discord/Telegram တွင် ယခင် register လုပ်ထားသော command များကို ရှင်းလင်းပါသည်။ Slack command များကို Slack app အတွင်း စီမံခန့်ခွဲရပြီး အလိုအလျောက် မဖယ်ရှားပါ။
- `commands.nativeSkills` (default `"auto"`) သည် ပံ့ပိုးနိုင်သည့်အခါ **skill** command များကို native အဖြစ် register လုပ်ပါသည်။
  - Auto: Discord/Telegram အတွက် ဖွင့်ထားသည်; Slack အတွက် ပိတ်ထားသည် (Slack တွင် skill တစ်ခုချင်းစီအတွက် slash command တစ်ခုစီ ဖန်တီးရန် လိုအပ်သည်)။
  - Provider တစ်ခုချင်းစီအလိုက် override လုပ်ရန် `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, သို့မဟုတ် `channels.slack.commands.nativeSkills` ကို သတ်မှတ်နိုင်သည် (bool သို့မဟုတ် `"auto"`)။
- `commands.bash` (default `false`) သည် host shell command များကို chạy လုပ်နိုင်ရန် `! <cmd>` ကို ဖွင့်ပါသည် (`/bash <cmd>` သည် alias ဖြစ်ပြီး `tools.elevated` allowlists လိုအပ်သည်)။
- `commands.bashForegroundMs` (default `2000`) သည် bash ကို background mode သို့ ပြောင်းမီ မည်မျှကြာ စောင့်ရမည်ကို ထိန်းချုပ်ပါသည် (`0` သည် ချက်ချင်း background သို့ ပြောင်းပါသည်)။
- `commands.config` (default `false`) သည် `/config` ကို ဖွင့်ပါသည် (`openclaw.json` ကို ဖတ်/ရေး လုပ်ပါသည်)။
- `commands.debug` (default `false`) သည် `/debug` ကို ဖွင့်ပါသည် (runtime-only override များ)။
- `commands.useAccessGroups` (default `true`) သည် command များအတွက် allowlists/policies များကို အတည်ပြု ချမှတ်ပါသည်။

## Command list

Text + native (ဖွင့်ထားသောအခါ):

- `/help`
- `/commands`
- `/skill <name> [input]` (အမည်ဖြင့် skill ကို chạy လုပ်ရန်)
- `/status` (လက်ရှိ အခြေအနေ ပြရန်; ရနိုင်သည့်အခါ လက်ရှိ model provider အတွက် provider usage/quota ပါဝင်သည်)
- `/allowlist` (allowlist entry များကို list/add/remove)
- `/approve <id> allow-once|allow-always|deny` (exec approval prompt များကို ဖြေရှင်းရန်)
- `/context [list|detail|json]` (“context” ကို ရှင်းပြရန်; `detail` သည် file တစ်ခုချင်း + tool တစ်ခုချင်း + skill တစ်ခုချင်း + system prompt size ကို ပြသည်)
- `/whoami` (သင့် sender id ကို ပြရန်; alias: `/id`)
- `/subagents list|stop|log|info|send` (လက်ရှိ session အတွက် sub-agent run များကို စစ်ဆေး၊ ရပ်တန့်၊ log ကြည့်၊ သို့မဟုတ် မက်ဆေ့ချ် ပို့ရန်)
- `/config show|get|set|unset` (config ကို disk သို့ သိမ်းဆည်းရန်၊ owner-only; `commands.config: true` လိုအပ်သည်)
- `/debug show|set|unset|reset` (runtime override များ၊ owner-only; `commands.debug: true` လိုအပ်သည်)
- `/usage off|tokens|full|cost` (response တစ်ခုချင်းစီအတွက် usage footer သို့မဟုတ် local cost summary)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS ကို ထိန်းချုပ်ရန်; [/tts](/tts) ကို ကြည့်ပါ)
  - Discord: native command သည် `/voice` ဖြစ်သည် (Discord သည် `/tts` ကို reserve လုပ်ထားသည်); text `/tts` သည် ဆက်လက် အလုပ်လုပ်ပါသည်။
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (reply များကို Telegram သို့ ပြောင်းရန်)
- `/dock-discord` (alias: `/dock_discord`) (reply များကို Discord သို့ ပြောင်းရန်)
- `/dock-slack` (alias: `/dock_slack`) (reply များကို Slack သို့ ပြောင်းရန်)
- `/activation mention|always` (group များအတွက်သာ)
- `/send on|off|inherit` (owner-only)
- `/reset` သို့မဟုတ် `/new [model]` (optional model hint; ကျန်ရှိသော စာသားကို ဆက်လက် ပို့ဆောင်ပါသည်)
- `/think <off|minimal|low|medium|high|xhigh>` (model/provider အလိုက် dynamic choices; alias များ: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; ဖွင့်ထားသောအခါ `Reasoning:` ဖြင့် prefix ထားသော သီးသန့် မက်ဆေ့ချ် တစ်ခု ပို့ပါသည်; `stream` = Telegram draft only)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` သည် exec approval များကို ကျော်လွှားပါသည်)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (`/exec` ကို ပို့၍ လက်ရှိ အခြေအနေ ပြရန်)
- `/model <name>` (alias: `/models`; သို့မဟုတ် `agents.defaults.models.*.alias` မှ `/<alias>`)
- `/queue <mode>` (`debounce:2s cap:25 drop:summarize` ကဲ့သို့ option များ ပါဝင်သည်; လက်ရှိ setting များကို ကြည့်ရန် `/queue` ကို ပို့ပါ)
- `/bash <command>` (host-only; `! <command>` ၏ alias; `commands.bash: true` + `tools.elevated` allowlists လိုအပ်သည်)

Text-only:

- `/compact [instructions]` ([/concepts/compaction](/concepts/compaction) ကို ကြည့်ပါ)
- `! <command>` (host-only; တစ်ကြိမ်လျှင် တစ်ခုသာ; ကြာရှည်လုပ်ဆောင်ရသော အလုပ်များအတွက် `!poll` + `!stop` ကို အသုံးပြုပါ)
- `!poll` (output / status ကို စစ်ဆေးရန်; optional `sessionId` ကို လက်ခံပါသည်; `/bash poll` လည်း အလုပ်လုပ်ပါသည်)
- `!stop` (လုပ်ဆောင်နေသော bash job ကို ရပ်တန့်ရန်; optional `sessionId` ကို လက်ခံပါသည်; `/bash stop` လည်း အလုပ်လုပ်ပါသည်)

Notes:

- Command များသည် command နှင့် args ကြားတွင် optional `:` ကို လက်ခံပါသည် (ဥပမာ– `/think: high`, `/send: on`, `/help:`)။
- `/new <model>` သည် model alias, `provider/model`, သို့မဟုတ် provider အမည် (fuzzy match) ကို လက်ခံပါသည်; မကိုက်ညီပါက စာသားကို မက်ဆေ့ချ် body အဖြစ် သတ်မှတ်ပါသည်။
- Provider usage ကို အပြည့်အစုံ ခွဲခြမ်းပြရန် `openclaw status --usage` ကို အသုံးပြုပါ။
- `/allowlist add|remove` သည် `commands.config=true` လိုအပ်ပြီး channel `configWrites` ကို လိုက်နာပါသည်။
- `/usage` သည် response တစ်ခုချင်းစီအတွက် usage footer ကို ထိန်းချုပ်ပါသည်; `/usage cost` သည် OpenClaw session log များမှ local cost summary ကို ပုံနှိပ်ပါသည်။
- `/restart` ကို default အနေဖြင့် ပိတ်ထားပါသည်; ဖွင့်ရန် `commands.restart: true` ကို သတ်မှတ်ပါ။
- `/verbose` သည် debugging နှင့် မြင်သာမှု တိုးမြှင့်ရန် ရည်ရွယ်ထားပါသည်; ပုံမှန် အသုံးပြုမှုတွင် **ပိတ်ထားပါ**။
- `/reasoning` (နှင့် `/verbose`) သည် group setting များတွင် အန္တရာယ်ရှိနိုင်ပါသည်– သင် မဖော်ထုတ်လိုသည့် internal reasoning သို့မဟုတ် tool output များကို ထုတ်ဖော်ပြသနိုင်ပါသည်။ အထူးသဖြင့် group chat များတွင် ပိတ်ထားခြင်းကို ဦးစားပေးပါ။
- **Fast path:** allowlisted sender များမှ command-only မက်ဆေ့ချ်များကို ချက်ချင်း ကိုင်တွယ်ပါသည် (queue + model ကို ကျော်လွှားပါသည်)။
- **Group mention gating:** allowlisted sender များမှ command-only မက်ဆေ့ချ်များသည် mention လိုအပ်ချက်များကို ကျော်လွှားပါသည်။
- **Inline shortcuts (allowlisted sender များအတွက်သာ):** command အချို့ကို ပုံမှန် မက်ဆေ့ချ်အတွင်း ထည့်သွင်းအသုံးပြုနိုင်ပြီး မော်ဒယ် မမြင်မီ ဖယ်ရှားပစ်ကာ ကျန်ရှိသော စာသားကို ဆက်လက် လုပ်ဆောင်ပါသည်။
  - ဥပမာ– `hey /status` သည် status reply ကို ဖြစ်ပေါ်စေပြီး ကျန်ရှိသော စာသားကို ပုံမှန် flow အတိုင်း ဆက်လက် လုပ်ဆောင်ပါသည်။
- လက်ရှိ– `/help`, `/commands`, `/status`, `/whoami` (`/id`)။
- Authorized မဟုတ်သော command-only မက်ဆေ့ချ်များကို တိတ်တဆိတ် လျစ်လျူရှုပါသည်၊ inline `/...` token များကို ပုံမှန် စာသားအဖြစ်သာ ကိုင်တွယ်ပါသည်။
- **Skill commands:** `user-invocable` skill များကို slash command များအဖြစ် ထုတ်ဖော်ပြသပါသည်။ အမည်များကို `a-z0-9_` အဖြစ် sanitize လုပ်ပါသည် (အများဆုံး 32 chars)၊ ထပ်တူညီမှုများရှိပါက နံပါတ် suffix များ ထည့်ပါသည် (ဥပမာ– `_2`)။
  - `/skill <name> [input]` သည် အမည်ဖြင့် skill ကို chạy လုပ်ပါသည် (native command limit များကြောင့် skill တစ်ခုချင်းစီအတွက် command မဖန်တီးနိုင်သည့်အခါ အသုံးဝင်သည်)။
  - Default အနေဖြင့် skill command များကို ပုံမှန် request အဖြစ် မော်ဒယ်သို့ forward လုပ်ပါသည်။
  - Skill များသည် `command-dispatch: tool` ကို optional အဖြစ် ကြေညာနိုင်ပြီး command ကို tool သို့ တိုက်ရိုက် route လုပ်နိုင်ပါသည် (deterministic, model မလို)။
  - ဥပမာ– `/prose` (OpenProse plugin) — [OpenProse](/prose) ကို ကြည့်ပါ။
- **Native command argument များ:** Discord သည် dynamic option များအတွက် autocomplete ကို အသုံးပြုပါသည် (လိုအပ်သော arg များ မထည့်ထားပါက button menu များကို ပြပါသည်)။ Telegram နှင့် Slack သည် command တွင် choice များ ပါဝင်ပြီး arg မထည့်ထားပါက button menu ကို ပြပါသည်။

## Usage surfaces (ဘယ်နေရာမှာ ဘာပေါ်လာသလဲ)

- **Provider usage/quota** (ဥပမာ– “Claude 80% left”) သည် usage tracking ဖွင့်ထားပါက လက်ရှိ model provider အတွက် `/status` တွင် ပေါ်လာပါသည်။
- **Response တစ်ခုချင်းစီအတွက် token/cost** ကို `/usage off|tokens|full` မှ ထိန်းချုပ်ပါသည် (ပုံမှန် reply များတွင် ထည့်ပေါင်းပါသည်)။
- `/model status` သည် usage မဟုတ်ဘဲ **models/auth/endpoints** အကြောင်း ဖြစ်ပါသည်။

## Model selection (`/model`)

`/model` ကို directive အဖြစ် အကောင်အထည်ဖော်ထားပါသည်။

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

- `/model` နှင့် `/model list` သည် compact, numbered picker (model family + ရရှိနိုင်သော provider များ) ကို ပြပါသည်။
- `/model <#>` သည် ထို picker မှ ရွေးချယ်ပြီး ဖြစ်နိုင်ပါက လက်ရှိ provider ကို ဦးစားပေးပါသည်။
- `/model status` သည် configured provider endpoint (`baseUrl`) နှင့် API mode (`api`) အပါအဝင် detailed view ကို ပြပါသည်။

## Debug overrides

`/debug` သည် **runtime-only** config override များ (memory အတွင်းသာ၊ disk မဟုတ်) ကို သတ်မှတ်ခွင့်ပေးပါသည်။ Owner-only ဖြစ်ပြီး default အနေဖြင့် ပိတ်ထားပါသည်; ဖွင့်ရန် `commands.debug: true` ကို အသုံးပြုပါ။

Examples:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notes:

- Override များသည် config read အသစ်များတွင် ချက်ချင်း သက်ရောက်သော်လည်း `openclaw.json` သို့ **မရေးသားပါ**။
- Override အားလုံးကို ရှင်းလင်းပြီး disk ပေါ်ရှိ config သို့ ပြန်သွားရန် `/debug reset` ကို အသုံးပြုပါ။

## Config updates

`/config` သည် disk ပေါ်ရှိ config (`openclaw.json`) သို့ ရေးသားပါသည်။ Owner-only ဖြစ်ပြီး default အနေဖြင့် ပိတ်ထားပါသည်; ဖွင့်ရန် `commands.config: true` ကို အသုံးပြုပါ။

Examples:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notes:

- Config ကို ရေးသားမီ validate လုပ်ပါသည်; မမှန်ကန်သော ပြောင်းလဲမှုများကို ပယ်ချပါသည်။
- `/config` ဖြင့် ပြုလုပ်သော update များသည် restart ပြုလုပ်ပြီးနောက်လည်း ဆက်လက် ရှိနေပါသည်။

## Surface notes

- **Text command များ** သည် ပုံမှန် chat session အတွင်း chạy လုပ်ပါသည် (DM များသည် `main` ကို မျှဝေပြီး group များတွင် သီးသန့် session ရှိပါသည်)။
- **Native command များ** သည် သီးခြား session များကို အသုံးပြုပါသည်–
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (`channels.slack.slashCommand.sessionPrefix` ဖြင့် prefix ကို ဖွဲ့စည်းပြင်ဆင်နိုင်သည်)
  - Telegram: `telegram:slash:<userId>` (`CommandTargetSessionKey` ဖြင့် chat session ကို target လုပ်ပါသည်)
- **`/stop`** သည် လက်ရှိ chạy လုပ်နေသော run ကို abort လုပ်နိုင်ရန် active chat session ကို target လုပ်ပါသည်။
- **Slack:** `channels.slack.slashCommand` ကို `/openclaw`-style command တစ်ခုအတွက် ဆက်လက် ပံ့ပိုးထားပါသည်။ `commands.native` ကို ဖွင့်ပါက built-in command တစ်ခုချင်းစီအတွက် Slack slash command တစ်ခုစီ ဖန်တီးရပါမည် (`/help` နှင့် အမည်တူ)။ Slack အတွက် command argument menu များကို ephemeral Block Kit button များအဖြစ် ပို့ပေးပါသည်။
