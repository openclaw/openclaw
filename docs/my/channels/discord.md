---
summary: "Discord ဘော့တ်၏ ပံ့ပိုးမှုအခြေအနေ၊ စွမ်းဆောင်ရည်များနှင့် ဖွဲ့စည်းပြင်ဆင်မှု"
read_when:
  - Discord ချန်နယ် အင်္ဂါရပ်များကို လုပ်ဆောင်နေစဉ်
title: "Discord"
---

# Discord (Bot API)

အခြေအနေ: တရားဝင် Discord bot gateway ကို အသုံးပြု၍ DM နှင့် guild စာသား ချန်နယ်များအတွက် အသင့်ဖြစ်နေပါသည်။

## Quick setup (beginner)

1. Discord ဘော့တ်တစ်ခု ဖန်တီးပြီး bot token ကို ကူးယူပါ။
2. Discord app settings တွင် **Message Content Intent** ကို ဖွင့်ပါ (**allowlists** သို့မဟုတ် အမည်ရှာဖွေမှုများ အသုံးပြုမည်ဆိုပါက **Server Members Intent** ကိုပါ ဖွင့်ပါ)။
3. OpenClaw အတွက် token ကို သတ်မှတ်ပါ:
   - Env: `DISCORD_BOT_TOKEN=...`
   - သို့မဟုတ် config: `channels.discord.token: "..."`။
   - နှစ်ခုစလုံး သတ်မှတ်ထားပါက config ကို ဦးစားပေးအသုံးပြုမည် (env fallback သည် default-account အတွက်သာ ဖြစ်သည်)။
4. မက်ဆေ့ချ် ခွင့်ပြုချက်များဖြင့် သင့် server သို့ ဘော့တ်ကို ဖိတ်ခေါ်ပါ (DM များသာ လိုလားပါက private server တစ်ခု ဖန်တီးနိုင်သည်)။
5. Gateway ကို စတင်ပါ။
6. DM ဝင်ရောက်ခွင့်သည် မူလအားဖြင့် pairing ဖြစ်ပါသည်။ ပထမဆုံး ဆက်သွယ်ရာတွင် pairing code ကို အတည်ပြုပါ။

Minimal config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Goals

- Discord DM များ သို့မဟုတ် guild ချန်နယ်များမှတဆင့် OpenClaw နှင့် ဆက်သွယ်နိုင်ရန်။
- Direct chats များသည် agent ၏ အဓိက session (default `agent:main:main`) သို့ ပေါင်းစည်းသွားပြီး guild ချန်နယ်များသည် `agent:<agentId>:discord:channel:<channelId>` အဖြစ် သီးခြားထားရှိမည် (ပြသအမည်များတွင် `discord:<guildSlug>#<channelSlug>` ကို အသုံးပြုသည်)။
- Group DM များကို မူလအားဖြင့် လျစ်လျူရှုသည်။ `channels.discord.dm.groupEnabled` ဖြင့် ဖွင့်နိုင်ပြီး `channels.discord.dm.groupChannels` ဖြင့် ကန့်သတ်နိုင်သည်။
- လမ်းကြောင်းသတ်မှတ်မှုကို တိကျစေရန်: ပြန်ကြားချက်များသည် အမြဲတမ်း ရောက်လာသည့် ချန်နယ်သို့ ပြန်သွားမည်။

## How it works

1. Discord application → Bot တစ်ခု ဖန်တီးပြီး လိုအပ်သော intents (DMs + guild messages + message content) ကို ဖွင့်ကာ bot token ကို ရယူပါ။
2. သင် အသုံးပြုလိုသည့် နေရာများတွင် မက်ဆေ့ချ် ဖတ်/ပို့နိုင်ရန် လိုအပ်သော ခွင့်ပြုချက်များဖြင့် သင့် server သို့ ဘော့တ်ကို ဖိတ်ခေါ်ပါ။
3. OpenClaw ကို `channels.discord.token` ဖြင့် (သို့မဟုတ် fallback အဖြစ် `DISCORD_BOT_TOKEN`) ဖွဲ့စည်းပြင်ဆင်ပါ။
4. Gateway ကို လည်ပတ်ပါ။ token ရရှိပါက (config ကို ဦးစားပေး၊ env fallback) Discord ချန်နယ်ကို အလိုအလျောက် စတင်မည်이며 `channels.discord.enabled` သည် `false` မဖြစ်ရပါ။
   - env vars ကိုသာ အသုံးပြုလိုပါက `DISCORD_BOT_TOKEN` ကို သတ်မှတ်ပါ (config block သည် မလိုအပ်ပါ)။
5. တိုက်ရိုက်စကားပြောများ - ပို့ရာတွင် `user:<id>` (သို့မဟုတ် `<@id>` mention) ကို အသုံးပြုပါ။ အလှည့်အပြောင်းအားလုံးသည် မျှဝေထားသော `main` session ထဲသို့ ဝင်ပါသည်။ နံပါတ်သာပါတဲ့ ID များသည် မရှင်းလင်းသောကြောင့် ငြင်းပယ်ခံရပါသည်။
6. Guild ချန်နယ်များ - ပို့ရန် `channel:<channelId>` ကို အသုံးပြုပါ။ Mention များကို မူလအဖြစ် လိုအပ်ပြီး guild သို့မဟုတ် ချန်နယ်အလိုက် သတ်မှတ်နိုင်ပါသည်။
7. တိုက်ရိုက်စကားပြောများ - `channels.discord.dm.policy` (မူလ: `"pairing"`) ဖြင့် မူလအနေဖြင့် လုံခြုံထားပါသည်။ မသိသော ပို့သူများသည် pairing code တစ်ခု ရရှိမည်ဖြစ်ပြီး (၁ နာရီအတွင်း သက်တမ်းကုန်ဆုံး) `openclaw pairing approve discord <code>` ဖြင့် အတည်ပြုနိုင်ပါသည်။
   - ယခင် “မည်သူမဆို ဝင်နိုင်” အပြုအမူကို ဆက်ထားလိုပါက `channels.discord.dm.policy="open"` နှင့် `channels.discord.dm.allowFrom=["*"]` ကို သတ်မှတ်ပါ။
   - Hard-allowlist ပြုလုပ်လိုပါက `channels.discord.dm.policy="allowlist"` ကို သတ်မှတ်ပြီး `channels.discord.dm.allowFrom` တွင် ပို့သူများကို စာရင်းပြုစုပါ။
   - DM များအားလုံးကို လျစ်လျူရှုလိုပါက `channels.discord.dm.enabled=false` သို့မဟုတ် `channels.discord.dm.policy="disabled"` ကို သတ်မှတ်ပါ။
8. Group DM များကို မူလအားဖြင့် လျစ်လျူရှုသည်။ `channels.discord.dm.groupEnabled` ဖြင့် ဖွင့်နိုင်ပြီး `channels.discord.dm.groupChannels` ဖြင့် ကန့်သတ်နိုင်သည်။
9. Optional guild စည်းမျဉ်းများ: guild id (ဦးစားပေး) သို့မဟုတ် slug ဖြင့် key ပြုလုပ်ထားသော `channels.discord.guilds` ကို သတ်မှတ်ပြီး ချန်နယ်အလိုက် စည်းမျဉ်းများ ထားနိုင်သည်။
10. ရွေးချယ်နိုင်သော native commands - `commands.native` သည် မူလအနေဖြင့် `"auto"` (Discord/Telegram အတွက် ဖွင့်၊ Slack အတွက် ပိတ်) ဖြစ်ပါသည်။ Override ပြုလုပ်ရန် `channels.discord.commands.native: true|false|"auto"` ကို အသုံးပြုပါ။ `false` သည် ယခင် register လုပ်ထားသော commands များကို ဖယ်ရှားပါသည်။ Text commands များကို `commands.text` ဖြင့် ထိန်းချုပ်ပြီး သီးသန့် `/...` မက်ဆေ့ချ်များအဖြစ် ပို့ရပါသည်။ Commands များအတွက် access-group စစ်ဆေးမှုကို ကျော်လွှားရန် `commands.useAccessGroups: false` ကို အသုံးပြုပါ။
    - Command အပြည့်အစုံ + config: [Slash commands](/tools/slash-commands)
11. Optional guild context history: set `channels.discord.historyLimit` (default 20, falls back to `messages.groupChat.historyLimit`) to include the last N guild messages as context when replying to a mention. ပိတ်ရန် `0` ကို သတ်မှတ်ပါ။
12. Reactions: agent သည် `discord` tool ဖြင့် reaction များကို လှုံ့ဆော်နိုင်သည် (`channels.discord.actions.*` ဖြင့် ထိန်းချုပ်ထားသည်)။
    - Reaction ဖယ်ရှားခြင်း အဓိပ္ပါယ်များ: [/tools/reactions](/tools/reactions) ကို ကြည့်ပါ။
    - `discord` tool သည် လက်ရှိ ချန်နယ်သည် Discord ဖြစ်သည့်အခါတွင်သာ ဖော်ပြပေးသည်။
13. Native commands များသည် မျှဝေထားသော `main` session မဟုတ်ဘဲ သီးခြား session keys (`agent:<agentId>:discord:slash:<userId>`) ကို အသုံးပြုသည်။

မှတ်ချက် - အမည် → id ပြန်လည်ဖြေရှင်းခြင်းသည် guild member search ကို အသုံးပြုပြီး Server Members Intent လိုအပ်ပါသည်။ bot သည် member များကို မရှာနိုင်ပါက id များ သို့မဟုတ် `<@id>` mention များကို အသုံးပြုပါ။
မှတ်ချက် - Slug များသည် အက္ခရာအသေးဖြစ်ပြီး အလွတ်နေရာများကို `-` ဖြင့် အစားထိုးထားပါသည်။ Channel အမည်များကို ရှေ့ရှိ `#` မပါဘဲ slug ပြုလုပ်ထားပါသည်။
မှတ်ချက် - Guild context `[from:]` လိုင်းများတွင် `author.tag` + `id` ပါဝင်ပြီး mention ပြုလုပ်နိုင်သော အဖြေများကို လွယ်ကူစေရန် ဖြစ်ပါသည်။

## Config writes

မူလအားဖြင့် Discord သည် `/config set|unset` ဖြင့် ဖြစ်ပေါ်လာသော config updates များကို ရေးသားခွင့်ရှိသည် (`commands.config: true` လိုအပ်)။

ပိတ်ရန်:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## How to create your own bot

ဤသည်မှာ OpenClaw ကို server (guild) ချန်နယ်တစ်ခု (ဥပမာ `#help`) တွင် လည်ပတ်ရန် “Discord Developer Portal” setup ဖြစ်သည်။

### 1. Discord app + bot user ဖန်တီးခြင်း

1. Discord Developer Portal → **Applications** → **New Application**
2. သင့် app တွင်:
   - **Bot** → **Add Bot**
   - **Bot Token** ကို ကူးယူပါ (ဤ token ကို `DISCORD_BOT_TOKEN` တွင် ထည့်ပါ)

### 2) OpenClaw လိုအပ်သော gateway intents များကို ဖွင့်ခြင်း

Discord သည် “privileged intents” များကို သင်ကိုယ်တိုင် မဖွင့်မချင်း ပိတ်ထားပါသည်။

**Bot** → **Privileged Gateway Intents** တွင် အောက်ပါအချက်များကို ဖွင့်ပါ:

- **Message Content Intent** (guild အများစုတွင် မက်ဆေ့ချ်စာသား ဖတ်ရန် လိုအပ်သည်; မဖွင့်ပါက “Used disallowed intents” ကို တွေ့ရမည် သို့မဟုတ် ဘော့တ်သည် ချိတ်ဆက်သော်လည်း မက်ဆေ့ချ်များကို မတုံ့ပြန်ပါ)
- **Server Members Intent** (အကြံပြုသည်; guild များတွင် member/user ရှာဖွေမှုအချို့နှင့် allowlist ကိုက်ညီမှုအတွက် လိုအပ်သည်)

ပုံမှန်အားဖြင့် **Presence Intent** ကို **မလိုအပ်ပါ**။ Bot ၏ ကိုယ်ပိုင် presence ကို သတ်မှတ်ခြင်း (`setPresence` action) သည် gateway OP3 ကို အသုံးပြုပြီး ဤ intent မလိုအပ်ပါ။ အခြား guild member များ၏ presence updates ကို လက်ခံလိုပါကသာ လိုအပ်ပါသည်။

### 3. Invite URL ဖန်တီးခြင်း (OAuth2 URL Generator)

သင့် app တွင်: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (native commands အတွက် လိုအပ်)

**Bot Permissions** (အနည်းဆုံး အခြေခံ)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (ရွေးချယ်နိုင်သော်လည်း အကြံပြု)
- ✅ Use External Emojis / Stickers (ရွေးချယ်နိုင်; အသုံးပြုလိုပါကသာ)

**Administrator** ကို မသုံးပါနှင့် (debug လုပ်နေပြီး ဘော့တ်ကို အပြည့်အဝ ယုံကြည်သည့်အခါမှသာ အသုံးပြုပါ)။

ဖန်တီးထားသော URL ကို ကူးယူပြီး ဖွင့်ကာ သင့် server ကို ရွေးချယ်၍ ဘော့တ်ကို ထည့်သွင်းပါ။

### 4. ids (guild/user/channel) များ ရယူခြင်း

Discord သည် နေရာတိုင်းတွင် နံပါတ် ids များကို အသုံးပြုသည်။ OpenClaw config သည် ids များကို ဦးစားပေးပါသည်။

1. Discord (desktop/web) → **User Settings** → **Advanced** → **Developer Mode** ကို ဖွင့်ပါ
2. Right-click:
   - Server အမည် → **Copy Server ID** (guild id)
   - Channel (ဥပမာ `#help`) → **Copy Channel ID**
   - သင့် user → **Copy User ID**

### 5) OpenClaw ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း

#### Token

Server များတွင် အကြံပြုထားသည့်အတိုင်း env var ဖြင့် bot token ကို သတ်မှတ်ပါ:

- `DISCORD_BOT_TOKEN=...`

သို့မဟုတ် config ဖြင့်:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Multi-account ပံ့ပိုးမှု: per-account token များနှင့် optional `name` ကို အသုံးပြု၍ `channels.discord.accounts` ကို အသုံးပြုပါ။ [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) တွင် မျှဝေထားသော pattern ကို ကြည့်ပါ။

#### Allowlist + channel routing

ဥပမာ “server တစ်ခုတည်း၊ ကျွန်ုပ်ကိုသာ ခွင့်ပြု၊ #help ကိုသာ ခွင့်ပြု”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

မှတ်ချက်များ:

- `requireMention: true` သည် mention ဖြစ်သောအခါမှသာ ပြန်ကြားမည်ဟု ဆိုလိုသည် (shared channels အတွက် အကြံပြု)။
- `agents.list[].groupChat.mentionPatterns` (သို့မဟုတ် `messages.groupChat.mentionPatterns`) ကိုလည်း guild မက်ဆေ့ချ်များအတွက် mention အဖြစ် ရေတွက်သည်။
- Multi-agent override: per-agent patterns များကို `agents.list[].groupChat.mentionPatterns` တွင် သတ်မှတ်ပါ။
- `channels` ရှိပါက စာရင်းမပါသော ချန်နယ်များအားလုံးကို မူလအားဖြင့် ငြင်းပယ်သည်။
- Channel အားလုံးအတွက် default များကို သတ်မှတ်ရန် `"*"` channel entry ကို အသုံးပြုပါ; သီးခြား channel entries များက wildcard ကို override လုပ်သည်။
- Threads များသည် parent channel ၏ config (allowlist, `requireMention`, skills, prompts စသည်) ကို ဆက်ခံပါသည်။ thread channel id ကို သီးခြား ထည့်မထားပါက ဖြစ်ပါသည်။
- Owner hint - per-guild သို့မဟုတ် per-channel `users` allowlist သည် ပို့သူနှင့် ကိုက်ညီပါက OpenClaw သည် ထိုပို့သူကို system prompt ထဲတွင် owner အဖြစ် သတ်မှတ်ပါသည်။ ချန်နယ်အနှံ့ အတွက် global owner တစ်ဦး သတ်မှတ်ရန် `commands.ownerAllowFrom` ကို သတ်မှတ်ပါ။
- Bot မှ ရေးသားသော မက်ဆေ့ချ်များကို မူလအားဖြင့် လျစ်လျူရှုသည်; `channels.discord.allowBots=true` ဖြင့် ခွင့်ပြုနိုင်သည် (ကိုယ်ပိုင် မက်ဆေ့ချ်များကိုတော့ ဆက်လက် စစ်ထုတ်ထားသည်)။
- သတိပေးချက် - အခြား bot များထံ ပြန်စာပို့ခွင့် ပြုထားပါက (`channels.discord.allowBots=true`)، bot-to-bot reply loop မဖြစ်စေရန် `requireMention`, `channels.discord.guilds.*.channels.<id>.users` allowlists များနှင့်/သို့မဟုတ် `AGENTS.md` နှင့် `SOUL.md` ထဲရှိ guardrails များကို ရှင်းလင်းပါ။`channels.discord.groupPolicy` သည် မူလအနေဖြင့် **allowlist** ဖြစ်ပါသည်။ `"open"` ဟု သတ်မှတ်ခြင်း သို့မဟုတ် `channels.discord.guilds` အောက်တွင် guild entry တစ်ခု ထည့်ပါ (လိုအပ်ပါက `channels.discord.guilds.<id>.channels` အောက်တွင် ချန်နယ်များကို စာရင်းပြုလုပ်၍ ကန့်သတ်နိုင်ပါသည်)။

### 6. အလုပ်လုပ်မှု စစ်ဆေးခြင်း

1. Gateway ကို စတင်ပါ။
2. သင့် server ချန်နယ်တွင် `@Krill hello` (သို့မဟုတ် သင့် bot အမည်) ကို ပို့ပါ။
3. ဘာမှ မဖြစ်ပါက အောက်ပါ **Troubleshooting** ကို စစ်ဆေးပါ။

### Troubleshooting

- ပထမဦးစွာ: `openclaw doctor` နှင့် `openclaw channels status --probe` ကို လည်ပတ်ပါ (လုပ်ဆောင်နိုင်သော သတိပေးချက်များ + အမြန် စစ်ဆေးမှုများ)။
- **“Used disallowed intents”**: Developer Portal တွင် **Message Content Intent** (နှင့် ဖြစ်နိုင်ချေရှိသည့် **Server Members Intent**) ကို ဖွင့်ပြီး Gateway ကို ပြန်စတင်ပါ။
- **ဘော့တ် ချိတ်ဆက်သော်လည်း guild ချန်နယ်တွင် မပြန်ကြားပါက**:
  - **Message Content Intent** မရှိခြင်း၊ သို့မဟုတ်
  - Channel permissions (View/Send/Read History) မရှိခြင်း၊ သို့မဟုတ်
  - Config တွင် mention လိုအပ်ပြီး သင် mention မလုပ်ခြင်း၊ သို့မဟုတ်
  - Guild/channel allowlist သည် channel/user ကို ငြင်းပယ်ခြင်း။
- **`requireMention: false` ဖြစ်သော်လည်း ပြန်ကြားမှု မရှိပါက**:
- `DISCORD_BOT_TOKEN` ကိုသာ သတ်မှတ်ပြီး `channels.discord` အပိုင်းကို မဖန်တီးပါက runtime သည် `groupPolicy` ကို `open` အဖြစ် မူလသတ်မှတ်ပါသည်။`channels.discord.groupPolicy`, `channels.defaults.groupPolicy`, သို့မဟုတ် guild/channel allowlist တစ်ခုကို ထည့်၍ ကန့်သတ်နိုင်ပါသည်။
  - `requireMention` သည် `channels.discord.guilds` (သို့မဟုတ် ချန်နယ်တစ်ခုချင်းစီ) အောက်တွင်သာ ရှိရပါမည်။ အပေါ်ဆုံးအဆင့်ရှိ `channels.discord.requireMention` ကို လျစ်လျူရှုပါသည်။
- **Permission audits** (`channels status --probe`) သည် နံပါတ် channel ID များကိုသာ စစ်ဆေးပါသည်။ သင် `channels.discord.guilds.*.channels` key များအဖြစ် slug/အမည်များကို အသုံးပြုပါက audit သည် ခွင့်ပြုချက်များကို အတည်မပြုနိုင်ပါ။
- **Discord တွင် Exec approvals** - Discord သည် DM များတွင် exec approval အတွက် **button UI** (Allow once / Always allow / Deny) ကို ထောက်ပံ့ပါသည်။ If you use slugs/names as `channels.discord.guilds.*.channels` keys, the audit can’t verify permissions.
- **DM များ မလုပ်ဆောင်ပါက**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"` သို့မဟုတ် သင် အတည်ပြုမခံရသေးခြင်း (`channels.discord.dm.policy="pairing"`) ဖြစ်နိုင်သည်။
- **Exec approvals in Discord**: Discord supports a **button UI** for exec approvals in DMs (Allow once / Always allow / Deny). `/approve <id> ...` သည် forward လုပ်ထားသော approval များအတွက်သာ ဖြစ်ပြီး Discord ၏ button prompt များကို မဖြေရှင်းနိုင်ပါ။ `❌ Failed to submit approval: Error: unknown approval id` ကိုတွေ့ရပါက သို့မဟုတ် UI မပေါ်လာပါက အောက်ပါအချက်များကို စစ်ဆေးပါ။
  - သင့် config တွင် `channels.discord.execApprovals.enabled: true`။
  - သင့် Discord user ID သည် `channels.discord.execApprovals.approvers` တွင် စာရင်းသွင်းထားခြင်း (UI ကို approvers များထံသာ ပို့ပါသည်)။
  - DM prompt ထဲရှိ ခလုတ်များ (**Allow once**, **Always allow**, **Deny**) ကို အသုံးပြုပါ။
  - အကျယ်အဝန်း approval နှင့် command flow အတွက် [Exec approvals](/tools/exec-approvals) နှင့် [Slash commands](/tools/slash-commands) ကို ကြည့်ပါ။

## Capabilities & limits

- DMs နှင့် guild စာသား ချန်နယ်များ (threads များကို သီးခြား ချန်နယ်များအဖြစ် သတ်မှတ်သည်; voice မပံ့ပိုးပါ)။
- Typing indicators များကို best-effort ဖြင့် ပို့ပါသည်; မက်ဆေ့ချ် ခွဲခြမ်းမှုသည် `channels.discord.textChunkLimit` (default 2000) ကို အသုံးပြုပြီး စာကြောင်းအရေအတွက် (`channels.discord.maxLinesPerMessage`, default 17) အပေါ်မူတည်၍ ရှည်လျားသော ပြန်ကြားချက်များကို ခွဲပါသည်။
- Optional newline chunking: `channels.discord.chunkMode="newline"` ကို သတ်မှတ်ပါက အရှည်အလိုက် ခွဲခြမ်းခြင်းမပြုမီ အလွတ်စာကြောင်းများ (paragraph boundaries) ပေါ်တွင် ခွဲပါသည်။
- File uploads များကို သတ်မှတ်ထားသော `channels.discord.mediaMaxMb` (default 8 MB) အထိ ပံ့ပိုးပါသည်။
- Guild replies များကို မူလအားဖြင့် mention-gated လုပ်ထားပြီး noisy bots မဖြစ်စေရန် ဖြစ်သည်။
- Message တစ်ခုက အခြား message ကို reference လုပ်ပါက reply context ကို ထည့်သွင်းပါသည် (quoted content + ids)။
- Native reply threading သည် **မူလအားဖြင့် ပိတ်ထားသည်**; `channels.discord.replyToMode` နှင့် reply tags ဖြင့် ဖွင့်နိုင်သည်။

## Retry policy

Outbound Discord API call များသည် rate limit (429) ဖြစ်သည့်အခါ Discord ၏ `retry_after` ကို ရရှိပါက အသုံးပြုပြီး exponential backoff နှင့် jitter ဖြင့် retry လုပ်ပါသည်။ `channels.discord.retry` မှတစ်ဆင့် configure လုပ်ပါ။ [Retry policy](/concepts/retry) ကိုကြည့်ပါ။

## Config

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Ack reaction များကို `messages.ackReaction` နှင့်
`messages.ackReactionScope` ဖြင့် global အဆင့်တွင် ထိန်းချုပ်ပါသည်။ `messages.removeAckAfterReply` ကို အသုံးပြုပြီး bot မှ reply ပြီးနောက် ack reaction ကို ဖယ်ရှားပါ။

- `dm.enabled`: `false` ကို သတ်မှတ်ပါက DM အားလုံးကို လျစ်လျူရှုသည် (default `true`)။
- `dm.policy`: DM access control (`pairing` ကို အကြံပြုသည်)။ `"open"` သည် `dm.allowFrom=["*"]` ကို လိုအပ်ပါသည်။
- `dm.allowFrom`: DM allowlist (user id များ သို့မဟုတ် name များ)။ `dm.policy="allowlist"` အတွက် အသုံးပြုသည့်အပြင် `dm.policy="open"` validation အတွက်လည်း အသုံးပြုပါသည်။ wizard သည် username များကို လက်ခံပြီး bot က member များကို ရှာဖွေနိုင်ပါက id များအဖြစ် resolve လုပ်ပါသည်။
- `dm.groupEnabled`: group DMs ကို ဖွင့်ခြင်း (default `false`)။
- `dm.groupChannels`: group DM channel ids သို့မဟုတ် slugs အတွက် optional allowlist။
- `groupPolicy`: guild channel ကို ကိုင်တွယ်ပုံကို ထိန်းချုပ်သည် (`open|disabled|allowlist`)； `allowlist` သည် channel allowlists လိုအပ်သည်။
- `guilds`: guild id (ဦးစားပေး) သို့မဟုတ် slug ဖြင့် key ပြုလုပ်ထားသော per-guild စည်းမျဉ်းများ။
- `guilds."*"`: သီးခြား entry မရှိပါက အသုံးပြုမည့် default per-guild settings။
- `guilds.<id>
  .slug`: ပြသရန်အတွက် အသုံးပြုသော optional friendly slug။`guilds.<id>
  .users`: optional per-guild user allowlist (id များ သို့မဟုတ် name များ)။
- `guilds.<id>
  .tools`: channel override မရှိသည့်အခါ အသုံးပြုသော optional per-guild tool policy override များ (`allow`/`deny`/`alsoAllow`)။`guilds.<id>
  .toolsBySender`: guild အဆင့်တွင် per-sender tool policy override များ (channel override မရှိသည့်အခါ အသုံးပြုသည်; `"*"` wildcard ကို ထောက်ပံ့သည်)။
- `guilds.<id>
  .channels.<channel>
  .allow`: `groupPolicy="allowlist"` ဖြစ်သည့်အခါ channel ကို allow/deny လုပ်ရန်။`guilds.<id>
  .channels.<channel>
  .requireMention`: channel အတွက် mention gating။
- `guilds.<id>
  .channels.<channel>
  .tools`: optional per-channel tool policy override များ (`allow`/`deny`/`alsoAllow`)။`guilds.<id>
  .channels.<channel>
  .toolsBySender`: channel အတွင်း per-sender tool policy override များ (`"*"` wildcard ကို ထောက်ပံ့သည်)။
- `guilds.<id>
  .channels.<channel>
  .users`: optional per-channel user allowlist။`guilds.<id>
  .channels.<channel>
  .skills`: skill filter (မထည့်လျှင် = skill အားလုံး၊ အလွတ်ထားလျှင် = မရှိ)။`guilds.<id>
  .channels.<channel>
  .systemPrompt`: channel အတွက် extra system prompt။
- Discord channel topic များကို **untrusted** context အဖြစ် inject လုပ်ပါသည် (system prompt မဟုတ်ပါ)။`guilds.<id>
  .channels.<channel>
  .enabled`: channel ကို ပိတ်ရန် `false` သတ်မှတ်ပါ။`guilds.<id>
  .channels`: channel rule များ (key များမှာ channel slug များ သို့မဟုတ် id များ ဖြစ်သည်)။
- `guilds.<id>
  .requireMention`: per-guild mention လိုအပ်ချက် (channel အလိုက် override လုပ်နိုင်သည်)။`guilds.<id>`.tools`: optional per-channel tool policy overrides (`allow`/`deny`/`alsoAllow\`).
- `guilds.<id>.channels.<channel>.toolsBySender`: optional per-sender tool policy overrides within the channel (`"*"` wildcard supported).
- `guilds.<id>.channels.<channel>.users`: optional per-channel user allowlist.
- `guilds.<id>.channels.<channel>.skills`: skill filter (omit = all skills, empty = none).
- `guilds.<id>.channels.<channel>.systemPrompt`: extra system prompt for the channel. Discord channel topics are injected as **untrusted** context (not system prompt).
- `guilds.<id>.channels.<channel>.enabled`: set `false` to disable the channel.
- `guilds.<id>.channels`: channel rules (keys are channel slugs or ids).
- `guilds.<id>.requireMention`: per-guild mention requirement (overridable per channel).
- `guilds.<id>.reactionNotifications`: reaction system event mode (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: outbound text chunk size (chars). Default: 2000.
- `chunkMode`: `length` (default) သည် `textChunkLimit` ကို ကျော်လွန်မှသာ ခွဲသည်； `newline` သည် အလွတ်စာကြောင်းများ (paragraph boundaries) ပေါ်တွင် အရှည်ခွဲခြမ်းမလုပ်မီ ခွဲသည်။
- `maxLinesPerMessage`: soft max line count per message. Default: 17.
- `mediaMaxMb`: inbound media ကို disk သို့ သိမ်းဆည်းရာတွင် clamp လုပ်ခြင်း။
- `historyLimit`: mention ကို ပြန်ကြားရာတွင် context အဖြစ် ထည့်သွင်းမည့် နောက်ဆုံး guild မက်ဆေ့ချ် အရေအတွက် (default 20; `messages.groupChat.historyLimit` သို့ fallback; `0` ပိတ်သည်)။
- `dmHistoryLimit`: DM history limit in user turns. Per-user overrides: `dms["<user_id>"].historyLimit`.
- `retry`: outbound Discord API calls အတွက် retry policy (attempts, minDelayMs, maxDelayMs, jitter)။
- `pluralkit`: PluralKit proxied messages များကို ဖြေရှင်းပြီး system members များကို သီးခြား ပို့သူများအဖြစ် ဖော်ပြခြင်း။
- `actions`: per-action tool gates; omit လုပ်ပါက အားလုံး ခွင့်ပြု (ပိတ်ရန် `false` ကို သတ်မှတ်)။
  - `reactions` (react + read reactions ကို ဖုံးလွှမ်း)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (channels + categories + permissions ကို create/edit/delete)
  - `roles` (role add/remove, default `false`)
  - `moderation` (timeout/kick/ban, default `false`)
  - `presence` (bot status/activity, default `false`)
- `execApprovals`: Discord-only exec approval DMs (button UI). Supports `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Reaction notifications use `guilds.<id>.reactionNotifications`:

- `off`: reaction events မရှိ။
- `own`: ဘော့တ်၏ ကိုယ်ပိုင် မက်ဆေ့ချ်များပေါ်ရှိ reactions (default)။
- `all`: မက်ဆေ့ချ်အားလုံးပေါ်ရှိ reactions အားလုံး။
- `allowlist`: reactions from `guilds.<id>.users` on all messages (empty list disables).

### PluralKit (PK) support

Enable PK lookups so proxied messages resolve to the underlying system + member.
When enabled, OpenClaw uses the member identity for allowlists and labels the
sender as `Member (PK:System)` to avoid accidental Discord pings.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Allowlist မှတ်ချက်များ (PK-enabled):

- Use `pk:<memberId>` in `dm.allowFrom`, `guilds.<id>.users`, or per-channel `users`.
- Member display names များကို အမည်/slug ဖြင့်လည်း ကိုက်ညီစစ်ဆေးပါသည်။
- Lookups များသည် **မူရင်း** Discord message ID (proxy မဖြစ်မီ မက်ဆေ့ချ်) ကို အသုံးပြုသဖြင့်
  PK API သည် မိနစ် ၃၀ အတွင်းသာ ဖြေရှင်းနိုင်ပါသည်။
- PK lookups မအောင်မြင်ပါက (ဥပမာ token မပါသော private system) proxied messages များကို
  bot messages အဖြစ် သတ်မှတ်ပြီး `channels.discord.allowBots=true` မရှိလျှင် ဖယ်ရှားပါသည်။

### Tool action defaults

| Action group   | Default  | Notes                                                |
| -------------- | -------- | ---------------------------------------------------- |
| reactions      | enabled  | React + list reactions + emojiList                   |
| stickers       | enabled  | Send stickers                                        |
| emojiUploads   | enabled  | Upload emojis                                        |
| stickerUploads | enabled  | Upload stickers                                      |
| polls          | enabled  | Create polls                                         |
| permissions    | enabled  | Channel permission snapshot                          |
| messages       | enabled  | Read/send/edit/delete                                |
| threads        | enabled  | Create/list/reply                                    |
| pins           | enabled  | Pin/unpin/list                                       |
| search         | enabled  | Message search (preview feature)  |
| memberInfo     | enabled  | Member info                                          |
| roleInfo       | enabled  | Role list                                            |
| channelInfo    | enabled  | Channel info + list                                  |
| channels       | enabled  | Channel/category management                          |
| voiceStatus    | enabled  | Voice state lookup                                   |
| events         | enabled  | List/create scheduled events                         |
| roles          | disabled | Role add/remove                                      |
| moderation     | disabled | Timeout/kick/ban                                     |
| presence       | disabled | Bot status/activity (setPresence) |

- `replyToMode`: `off` (default), `first`, or `all`. Applies only when the model includes a reply tag.

## Reply tags

Threaded reply တောင်းဆိုရန် model သည် output တွင် tag တစ်ခု ထည့်နိုင်သည်:

- `[[reply_to_current]]` — trigger ဖြစ်သည့် Discord message ကို reply လုပ်ပါ။
- `[[reply_to:<id>]]` — reply to a specific message id from context/history.
  Current message ids are appended to prompts as `[message_id: …]`; history entries already include ids.

အပြုအမူကို `channels.discord.replyToMode` ဖြင့် ထိန်းချုပ်ပါသည်:

- `off`: tags များကို လျစ်လျူရှု။
- `first`: ပထမ outbound chunk/attachment တစ်ခုသာ reply ဖြစ်သည်။
- `all`: outbound chunk/attachment အားလုံး reply ဖြစ်သည်။

Allowlist ကိုက်ညီမှု မှတ်ချက်များ:

- `allowFrom`/`users`/`groupChannels` သည် ids, အမည်များ, tags သို့မဟုတ် `<@id>` ကဲ့သို့ mentions များကို လက်ခံပါသည်။
- `discord:`/`user:` (users) နှင့် `channel:` (group DMs) ကဲ့သို့ prefixes များကို ပံ့ပိုးပါသည်။
- မည်သည့် sender/channel မဆို ခွင့်ပြုရန် `*` ကို အသုံးပြုပါ။
- When `guilds.<id>.channels` is present, channels not listed are denied by default.
- When `guilds.<id>.channels` is omitted, all channels in the allowlisted guild are allowed.
- **Channel မည်သည့်တစ်ခုမျှ မခွင့်ပြုလိုပါက** `channels.discord.groupPolicy: "disabled"` ကို သတ်မှတ်ပါ (သို့မဟုတ် empty allowlist ကို ထားပါ)။
- Configure wizard သည် `Guild/Channel` အမည်များ (public + private) ကို လက်ခံပြီး ဖြစ်နိုင်ပါက IDs သို့ ဖြေရှင်းပါသည်။
- စတင်ရာတွင် OpenClaw သည် allowlists ထဲရှိ channel/user အမည်များကို IDs သို့ ဖြေရှင်းပြီး (ဘော့တ်က members များကို ရှာနိုင်ပါက)
  mapping ကို log ထုတ်ပေးပါသည်; မဖြေရှင်းနိုင်သော entries များကို မူလအတိုင်း ထားရှိပါသည်။

Native command မှတ်ချက်များ:

- Register လုပ်ထားသော commands များသည် OpenClaw ၏ chat commands များကို ထင်ဟပ်ပါသည်။
- Native commands များသည် DMs/guild messages များနှင့် တူညီသော allowlists များကို လိုက်နာပါသည် (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, per-channel rules)။
- Slash commands များသည် allowlisted မဟုတ်သော users များအတွက် Discord UI တွင် မြင်ရနိုင်သော်လည်း OpenClaw သည် execution တွင် allowlists ကို အတည်ပြုပြီး “not authorized” ဟု ပြန်ကြားပါသည်။

## Tool actions

Agent သည် အောက်ပါ actions များဖြင့် `discord` ကို ခေါ်နိုင်သည်:

- `react` / `reactions` (reactions ထည့်ခြင်း သို့မဟုတ် စာရင်းပြုစုခြင်း)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Read/search/pin tool payloads တွင် normalized `timestampMs` (UTC epoch ms) နှင့် `timestampUtc` ကို raw Discord `timestamp` နှင့်အတူ ပါဝင်ပါသည်။
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (bot activity နှင့် online status)

Discord message ids are surfaced in the injected context (`[discord message id: …]` and history lines) so the agent can target them.
Emoji can be unicode (e.g., `✅`) or custom emoji syntax like `<:party_blob:1234567890>`.

## Safety & ops

- Bot token ကို စကားဝှက်ကဲ့သို့ ဆက်ဆံပါ; supervised hosts များတွင် `DISCORD_BOT_TOKEN` env var ကို ဦးစားပေးအသုံးပြုပါ သို့မဟုတ် config ဖိုင် ခွင့်ပြုချက်များကို တင်းကြပ်စွာ သတ်မှတ်ပါ။
- ဘော့တ်အတွက် လိုအပ်သလောက်သာ ခွင့်ပြုချက်များ ပေးပါ (ပုံမှန်အားဖြင့် Read/Send Messages)။
- ဘော့တ်သည် အတက်အကျ ရပ်တန့်နေပါက သို့မဟုတ် rate limited ဖြစ်ပါက Discord session ကို အခြား process များက မပိုင်ဆိုင်ကြောင်း အတည်ပြုပြီးနောက် Gateway (`openclaw gateway --force`) ကို ပြန်စတင်ပါ။
