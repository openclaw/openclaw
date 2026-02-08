---
summary: "imsg (stdio ပေါ်ရှိ JSON-RPC) ကို အသုံးပြုသော အဟောင်း iMessage ထောက်ပံ့မှု။ အသစ်တပ်ဆင်မှုများအတွက် BlueBubbles ကို အသုံးပြုသင့်သည်။"
read_when:
  - iMessage ထောက်ပံ့မှု တပ်ဆင်ခြင်း
  - iMessage ပို့ခြင်း/လက်ခံခြင်း ကို Debug လုပ်ခြင်း
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:31Z
---

# iMessage (အဟောင်း: imsg)

> **အကြံပြုချက်:** iMessage အသစ်တပ်ဆင်မှုများအတွက် [BlueBubbles](/channels/bluebubbles) ကို အသုံးပြုပါ။
>
> `imsg` ချန်နယ်သည် အဟောင်း external-CLI ပေါင်းစည်းမှု ဖြစ်ပြီး အနာဂတ် release တစ်ခုတွင် ဖယ်ရှားခံရနိုင်သည်။

အခြေအနေ: အဟောင်း external CLI ပေါင်းစည်းမှု။ Gateway သည် `imsg rpc` (stdio ပေါ်ရှိ JSON-RPC) ကို spawn လုပ်သည်။

## Quick setup (beginner)

1. ဤ Mac တွင် Messages ကို sign in လုပ်ထားကြောင်း သေချာပါစေ။
2. `imsg` ကို ထည့်သွင်းပါ:
   - `brew install steipete/tap/imsg`
3. OpenClaw ကို `channels.imessage.cliPath` နှင့် `channels.imessage.dbPath` ဖြင့် ဖွဲ့စည်းပြင်ဆင်ပါ။
4. gateway ကို စတင်ပြီး macOS prompt များ (Automation + Full Disk Access) ကို အတည်ပြုပါ။

အနည်းဆုံး config:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## What it is

- macOS ပေါ်ရှိ `imsg` ကို အခြေခံထားသော iMessage ချန်နယ်။
- Deterministic routing: ပြန်လည်ဖြေကြားချက်များသည် အမြဲ iMessage သို့ ပြန်သွားသည်။
- DM မက်ဆေ့ချ်များသည် agent ၏ အဓိက ဆက်ရှင်ကို မျှဝေသုံးစွဲသည်; အုပ်စုများကို သီးခြားထားသည် (`agent:<agentId>:imessage:group:<chat_id>`)။
- `is_group=false` ပါဝင်သော အများပါဝင် thread တစ်ခု ဝင်လာပါက `channels.imessage.groups` ကို အသုံးပြု၍ `chat_id` ဖြင့် သီးခြားထားနိုင်သည် (“Group-ish threads” ကို အောက်တွင် ကြည့်ပါ)။

## Config writes

မူလအားဖြင့် iMessage သည် `/config set|unset` ကြောင့် ဖြစ်ပေါ်လာသော config update များကို ရေးသားခွင့်ပြုထားသည် (`commands.config: true` လိုအပ်သည်)။

ပိတ်ရန်:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Requirements

- Messages ကို sign in လုပ်ထားသော macOS။
- OpenClaw + `imsg` အတွက် Full Disk Access (Messages DB ကို ဝင်ရောက်ရန်)။
- ပို့ရာတွင် Automation ခွင့်ပြုချက်။
- `channels.imessage.cliPath` သည် stdin/stdout ကို proxy လုပ်သော မည်သည့် command မဆို ကိုညွှန်ပြနိုင်သည် (ဥပမာ၊ အခြား Mac သို့ SSH ချိတ်ပြီး `imsg rpc` ကို chạy လုပ်သည့် wrapper script)။

## Troubleshooting macOS Privacy and Security TCC

ပို့ခြင်း/လက်ခံခြင်း မအောင်မြင်ပါက (ဥပမာ `imsg rpc` သည် non-zero ဖြင့် ထွက်ခြင်း၊ timeout ဖြစ်ခြင်း၊ သို့မဟုတ် gateway က ရပ်နေသလို မြင်ရခြင်း) အကြောင်းရင်းအဖြစ် macOS ခွင့်ပြုချက် prompt တစ်ခုကို မအတည်ပြုခဲ့ခြင်း ဖြစ်နိုင်သည်။

macOS သည် TCC ခွင့်ပြုချက်များကို app/process context အလိုက် ပေးသည်။ `imsg` ကို chạy လုပ်သည့် context တူညီရာတွင် prompt များကို အတည်ပြုပါ (ဥပမာ Terminal/iTerm၊ LaunchAgent session၊ သို့မဟုတ် SSH မှ chạy လုပ်သည့် process)။

Checklist:

- **Full Disk Access**: OpenClaw ကို chạy လုပ်နေသော process (နှင့် `imsg` ကို chạy လုပ်သည့် shell/SSH wrapper များ) အတွက် ခွင့်ပြုပါ။ ၎င်းသည် Messages database (`chat.db`) ကို ဖတ်ရန် လိုအပ်သည်။
- **Automation → Messages**: OpenClaw ကို chạy လုပ်နေသော process (သို့မဟုတ် သင့် terminal) ကို outbound ပို့ခြင်းအတွက် **Messages.app** ကို ထိန်းချုပ်ခွင့် ပေးပါ။
- **`imsg` CLI health**: `imsg` ကို ထည့်သွင်းထားပြီး RPC (`imsg rpc --help`) ကို ပံ့ပိုးကြောင်း စစ်ဆေးပါ။

အကြံပြုချက်: OpenClaw ကို headless (LaunchAgent/systemd/SSH) ဖြင့် chạy လုပ်နေပါက macOS prompt ကို လွယ်ကူစွာ မမြင်မိနိုင်ပါ။ GUI terminal တစ်ခုတွင် တစ်ကြိမ်တည်း interactive command ကို chạy လုပ်ပြီး prompt ကို အတင်းပြပေါ်စေကာ၊ ထို့နောက် ထပ်မံကြိုးစားပါ:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

ဆက်စပ် macOS ဖိုလ်ဒါ ခွင့်ပြုချက်များ (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions)။

## Setup (fast path)

1. ဤ Mac တွင် Messages ကို sign in လုပ်ထားကြောင်း သေချာပါစေ။
2. iMessage ကို ဖွဲ့စည်းပြင်ဆင်ပြီး gateway ကို စတင်ပါ။

### Dedicated bot macOS user (identity ကို သီးခြားထားရန်)

bot ကို **သီးခြား iMessage identity** ဖြင့် ပို့စေလိုပါက (သင့်ကိုယ်ပိုင် Messages ကို သန့်ရှင်းထားရန်) သီးခြား Apple ID + သီးခြား macOS user ကို အသုံးပြုပါ။

1. သီးခြား Apple ID တစ်ခု ဖန်တီးပါ (ဥပမာ `my-cool-bot@icloud.com`)။
   - Apple သည် စိစစ်မှု / 2FA အတွက် ဖုန်းနံပါတ် လိုအပ်နိုင်သည်။
2. macOS user တစ်ခု ဖန်တီးပါ (ဥပမာ `openclawhome`) နှင့် ထို user ဖြင့် sign in လုပ်ပါ။
3. ထို macOS user တွင် Messages ကို ဖွင့်ပြီး bot Apple ID ဖြင့် iMessage ကို sign in လုပ်ပါ။
4. Remote Login ကို ဖွင့်ပါ (System Settings → General → Sharing → Remote Login)။
5. `imsg` ကို ထည့်သွင်းပါ:
   - `brew install steipete/tap/imsg`
6. `ssh <bot-macos-user>@localhost true` ကို password မလိုဘဲ အလုပ်လုပ်စေရန် SSH ကို သတ်မှတ်ပါ။
7. `channels.imessage.accounts.bot.cliPath` ကို bot user အဖြစ် `imsg` ကို chạy လုပ်သော SSH wrapper သို့ ညွှန်ပြပါ။

ပထမအကြိမ် note: ပို့ခြင်း/လက်ခံခြင်းအတွက် _bot macOS user_ အောက်တွင် GUI ခွင့်ပြုချက်များ (Automation + Full Disk Access) လိုအပ်နိုင်သည်။ `imsg rpc` သည် ရပ်နေသလို မြင်ရပါက သို့မဟုတ် ထွက်သွားပါက ထို user သို့ log in ဝင်ပါ (Screen Sharing က ကူညီနိုင်သည်)၊ တစ်ကြိမ်တည်း `imsg chats --limit 1` / `imsg send ...` ကို chạy လုပ်ပြီး prompt များကို အတည်ပြုပါ၊ ထို့နောက် ထပ်မံကြိုးစားပါ။ [Troubleshooting macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc) ကို ကြည့်ပါ။

Wrapper ဥပမာ (`chmod +x`)။ `<bot-macos-user>` ကို သင့် macOS username အမှန်ဖြင့် အစားထိုးပါ:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Config ဥပမာ:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

single-account setup များအတွက် `accounts` map အစား flat options (`channels.imessage.cliPath`, `channels.imessage.dbPath`) ကို အသုံးပြုပါ။

### Remote/SSH variant (optional)

အခြား Mac တစ်လုံးပေါ်တွင် iMessage ကို အသုံးပြုလိုပါက `channels.imessage.cliPath` ကို SSH ဖြင့် remote macOS ဟို့စ်ပေါ်တွင် `imsg` ကို chạy လုပ်သော wrapper သို့ သတ်မှတ်ပါ။ OpenClaw သည် stdio သာ လိုအပ်သည်။

Wrapper ဥပမာ:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Remote attachments:** `cliPath` သည် SSH ဖြင့် remote host ကို ညွှန်ပြပါက Messages database ထဲရှိ attachment path များသည် remote စက်ပေါ်ရှိ ဖိုင်များကို ညွှန်ပြသည်။ `channels.imessage.remoteHost` ကို သတ်မှတ်ခြင်းဖြင့် OpenClaw သည် ၎င်းတို့ကို SCP ဖြင့် အလိုအလျောက် ယူဆောင်နိုင်သည်။

`remoteHost` ကို မသတ်မှတ်ထားပါက OpenClaw သည် သင့် wrapper script ထဲရှိ SSH command ကို parse လုပ်၍ အလိုအလျောက် ခန့်မှန်းကြိုးစားသည်။ ယုံကြည်စိတ်ချရမှုအတွက် ထင်ရှားစွာ ဖွဲ့စည်းပြင်ဆင်ခြင်းကို အကြံပြုပါသည်။

#### Tailscale ဖြင့် Remote Mac (ဥပမာ)

Gateway သည် Linux host/VM ပေါ်တွင် chạy လုပ်နေပြီး iMessage ကို Mac ပေါ်တွင် chạy လုပ်ရမည်ဆိုပါက Tailscale သည် အလွယ်ကူဆုံး bridge ဖြစ်သည်။ Gateway သည် tailnet မှတဆင့် Mac နှင့် ဆက်သွယ်ပြီး SSH ဖြင့် `imsg` ကို chạy လုပ်ကာ attachment များကို SCP ဖြင့် ပြန်ယူသည်။

Architecture:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Concrete config ဥပမာ (Tailscale hostname):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Wrapper ဥပမာ (`~/.openclaw/scripts/imsg-ssh`) :

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

မှတ်ချက်များ:

- Mac တွင် Messages ကို sign in လုပ်ထားပြီး Remote Login ကို ဖွင့်ထားပါ။
- `ssh bot@mac-mini.tailnet-1234.ts.net` ကို prompt မရှိဘဲ အလုပ်လုပ်စေရန် SSH key များကို အသုံးပြုပါ။
- SCP ဖြင့် attachment များကို ယူနိုင်ရန် `remoteHost` သည် SSH target နှင့် ကိုက်ညီရမည်။

Multi-account ထောက်ပံ့မှု: per-account config နှင့် optional `name` ဖြင့် `channels.imessage.accounts` ကို အသုံးပြုပါ။ shared pattern အတွက် [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) ကို ကြည့်ပါ။ `~/.openclaw/openclaw.json` ကို commit မလုပ်ပါနှင့် (မကြာခဏ token များ ပါဝင်တတ်သည်)။

## Access control (DMs + groups)

DM မက်ဆေ့ချ်များ:

- မူလ: `channels.imessage.dmPolicy = "pairing"`။
- မသိသော ပို့သူများသည် pairing code တစ်ခုကို လက်ခံရရှိပြီး အတည်ပြုမချင်း မက်ဆေ့ချ်များကို လျစ်လျူရှုထားမည် (code များသည် ၁ နာရီအကြာတွင် သက်တမ်းကုန်)။
- အတည်ပြုရန်:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Pairing သည် iMessage DM များအတွက် မူလ token လဲလှယ်နည်း ဖြစ်သည်။ အသေးစိတ်: [Pairing](/channels/pairing)

အုပ်စုများ:

- `channels.imessage.groupPolicy = open | allowlist | disabled`။
- `allowlist` ကို သတ်မှတ်ထားသောအခါ အုပ်စုများတွင် trigger လုပ်နိုင်သူများကို `channels.imessage.groupAllowFrom` က ထိန်းချုပ်သည်။
- iMessage တွင် native mention metadata မရှိသောကြောင့် mention gating သည် `agents.list[].groupChat.mentionPatterns` (သို့မဟုတ် `messages.groupChat.mentionPatterns`) ကို အသုံးပြုသည်။
- Multi-agent override: `agents.list[].groupChat.mentionPatterns` တွင် per-agent pattern များကို သတ်မှတ်ပါ။

## How it works (behavior)

- `imsg` သည် message event များကို stream လုပ်ပြီး gateway သည် ၎င်းတို့ကို shared channel envelope အဖြစ် normalise လုပ်သည်။
- ပြန်လည်ဖြေကြားချက်များသည် chat id သို့မဟုတ် handle တူညီသည့်နေရာသို့ အမြဲ ပြန်သွားသည်။

## Group-ish threads (`is_group=false`)

Messages က chat identifier ကို သိမ်းဆည်းသည့် နည်းလမ်းအပေါ် မူတည်၍ အချို့ iMessage thread များတွင် ပါဝင်သူ အများရှိသော်လည်း `is_group=false` ဖြင့် ဝင်လာနိုင်သည်။

`channels.imessage.groups` အောက်တွင် `chat_id` ကို ထင်ရှားစွာ သတ်မှတ်ပါက OpenClaw သည် ထို thread ကို အောက်ပါအတွက် “group” အဖြစ် သဘောထားမည်-

- ဆက်ရှင် သီးခြားခြင်း (သီးခြား `agent:<agentId>:imessage:group:<chat_id>` session key)
- group allowlist / mention gating အပြုအမူ

ဥပမာ:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

ဤသည်မှာ သီးခြား thread တစ်ခုအတွက် သီးခြား personality/model ကို အသုံးပြုလိုသောအခါ အသုံးဝင်သည် ([Multi-agent routing](/concepts/multi-agent) ကို ကြည့်ပါ)။ ဖိုင်စနစ် သီးခြားခြင်းအတွက် [Sandboxing](/gateway/sandboxing) ကို ကြည့်ပါ။

## Media + limits

- `channels.imessage.includeAttachments` ဖြင့် attachment ingestion ကို ရွေးချယ်နိုင်သည်။
- `channels.imessage.mediaMaxMb` ဖြင့် media ကန့်သတ်ချက်။

## Limits

- Outbound စာသားကို `channels.imessage.textChunkLimit` (မူလ 4000) သို့ chunk လုပ်သည်။
- Optional newline chunking: အရှည်အလိုက် chunk မလုပ်မီ blank line (paragraph boundary) များတွင် ခွဲရန် `channels.imessage.chunkMode="newline"` ကို သတ်မှတ်ပါ။
- Media upload များကို `channels.imessage.mediaMaxMb` (မူလ 16) ဖြင့် ကန့်သတ်ထားသည်။

## Addressing / delivery targets

တည်ငြိမ်သော routing အတွက် `chat_id` ကို ဦးစားပေး အသုံးပြုပါ-

- `chat_id:123` (ဦးစားပေး)
- `chat_guid:...`
- `chat_identifier:...`
- တိုက်ရိုက် handle များ: `imessage:+1555` / `sms:+1555` / `user@example.com`

Chat များကို စာရင်းပြုစုရန်:

```
imsg chats --limit 20
```

## Configuration reference (iMessage)

အပြည့်အစုံ configuration: [Configuration](/gateway/configuration)

Provider options:

- `channels.imessage.enabled`: channel startup ကို enable/disable လုပ်ရန်။
- `channels.imessage.cliPath`: `imsg` သို့ လမ်းကြောင်း။
- `channels.imessage.dbPath`: Messages DB လမ်းကြောင်း။
- `channels.imessage.remoteHost`: `cliPath` သည် remote Mac ကို ညွှန်ပြသည့်အခါ SCP attachment transfer အတွက် SSH host (ဥပမာ `user@gateway-host`)။ မသတ်မှတ်ပါက SSH wrapper မှ အလိုအလျောက် ခန့်မှန်းသည်။
- `channels.imessage.service`: `imessage | sms | auto`။
- `channels.imessage.region`: SMS ဒေသ။
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (မူလ: pairing)။
- `channels.imessage.allowFrom`: DM allowlist (handle များ၊ email များ၊ E.164 နံပါတ်များ သို့မဟုတ် `chat_id:*`)။ `open` သည် `"*"` ကို လိုအပ်သည်။ iMessage တွင် username မရှိပါ; handle သို့မဟုတ် chat target များကို အသုံးပြုပါ။
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (မူလ: allowlist)။
- `channels.imessage.groupAllowFrom`: group sender allowlist။
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: context အဖြစ် ထည့်သွင်းမည့် group message အများဆုံး (0 သတ်မှတ်ပါက ပိတ်)။
- `channels.imessage.dmHistoryLimit`: user turn အလိုက် DM history ကန့်သတ်ချက်။ Per-user override များ: `channels.imessage.dms["<handle>"].historyLimit`။
- `channels.imessage.groups`: per-group default များ + allowlist (global default အတွက် `"*"` ကို အသုံးပြုပါ)။
- `channels.imessage.includeAttachments`: attachment များကို context ထဲသို့ ingest လုပ်ရန်။
- `channels.imessage.mediaMaxMb`: inbound/outbound media ကန့်သတ်ချက် (MB)။
- `channels.imessage.textChunkLimit`: outbound chunk အရွယ်အစား (စာလုံးရေ)။
- `channels.imessage.chunkMode`: အရှည်အလိုက် chunk မလုပ်မီ blank line (paragraph boundary) များတွင် ခွဲရန် `length` (မူလ) သို့မဟုတ် `newline`။

ဆက်စပ် global options:

- `agents.list[].groupChat.mentionPatterns` (သို့မဟုတ် `messages.groupChat.mentionPatterns`)။
- `messages.responsePrefix`။
