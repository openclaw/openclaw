---
summary: "signal-cli (JSON-RPC + SSE) ကိုအသုံးပြုသော Signal ပံ့ပိုးမှု၊ setup နှင့် နံပါတ် မော်ဒယ်"
read_when:
  - Signal ပံ့ပိုးမှုကို တပ်ဆင်ချိန်
  - Signal ပို့/လက်ခံမှုကို ပြဿနာရှာဖွေချိန်
title: "Signal"
---

# Signal (signal-cli)

အခြေအနေ: ပြင်ပ CLI ပေါင်းစည်းမှု။ Gateway သည် `signal-cli` နှင့် HTTP JSON-RPC + SSE ဖြင့် ဆက်သွယ်ပါသည်။

## Quick setup (beginner)

1. ဘော့အတွက် **သီးခြား Signal နံပါတ်** ကို အသုံးပြုပါ (အကြံပြုသည်)။
2. `signal-cli` ကို ထည့်သွင်းပါ (Java လိုအပ်သည်)။
3. ဘော့ စက်ပစ္စည်းကို ချိတ်ဆက်ပြီး daemon ကို စတင်ပါ။
   - `signal-cli link -n "OpenClaw"`
4. OpenClaw ကို ဖွဲ့စည်းပြင်ဆင်ပြီး Gateway ကို စတင်ပါ။

အနည်းဆုံး ဖွဲ့စည်းမှု:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## အရာက ဘာလဲ

- `signal-cli` မှတစ်ဆင့် Signal ချန်နယ် (libsignal ကို မထည့်သွင်းထားပါ)။
- သတ်မှတ်ချက်တိကျသော လမ်းကြောင်းပြန်လည်ပို့ဆောင်မှု: အဖြေများသည် အမြဲ Signal သို့ ပြန်သွားသည်။
- DM များသည် အေးဂျင့်၏ အဓိက ဆက်ရှင်ကို မျှဝေသည်; အုပ်စုများကို သီးခြားထားသည် (`agent:<agentId>:signal:group:<groupId>`)။

## Config ရေးသားမှုများ

မူလအနေဖြင့် Signal သည် `/config set|unset` ကြောင့် ဖြစ်ပေါ်လာသော config အပ်ဒိတ်များကို ရေးသားခွင့်ပြုထားသည် (`commands.config: true` လိုအပ်သည်)။

ပိတ်ရန်:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## နံပါတ် မော်ဒယ် (အရေးကြီး)

- Gateway သည် **Signal စက်ပစ္စည်း** ( `signal-cli` အကောင့်) သို့ ချိတ်ဆက်သည်။
- ဘော့ကို **သင်၏ ကိုယ်ပိုင် Signal အကောင့်** ပေါ်တွင် လည်ပတ်ပါက သင်၏ ကိုယ်ပိုင် မက်ဆေ့ချ်များကို လျစ်လျူရှုမည် (loop ကာကွယ်မှု)။
- “ကျွန်ုပ်က ဘော့ကို စာပို့ပြီး အဖြေပြန်လာစေချင်တယ်” ဆိုပါက **သီးခြား ဘော့ နံပါတ်** ကို အသုံးပြုပါ။

## Setup (fast path)

1. `signal-cli` ကို ထည့်သွင်းပါ (Java လိုအပ်သည်)။
2. ဘော့ အကောင့်တစ်ခုကို ချိတ်ဆက်ပါ။
   - `signal-cli link -n "OpenClaw"` ပြီးနောက် Signal တွင် QR ကို စကန်ပါ။
3. Signal ကို ဖွဲ့စည်းပြင်ဆင်ပြီး Gateway ကို စတင်ပါ။

ဥပမာ:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Multi-account ပံ့ပိုးမှု: `channels.signal.accounts` ကို account တစ်ခုချင်းစီအတွက် config နှင့် မဖြစ်မနေ မဟုတ်သော `name` ဖြင့် အသုံးပြုပါ။ ပုံစံတူ အသုံးပြုနည်းအတွက် [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) ကို ကြည့်ပါ။

## External daemon mode (httpUrl)

`signal-cli` ကို ကိုယ်တိုင် စီမံလိုပါက (JVM အအေးစတင်မှု နှေးကွေးခြင်း၊ container init၊ သို့မဟုတ် shared CPUs) daemon ကို သီးခြား လည်ပတ်ပြီး OpenClaw ကို ထိုနေရာသို့ ညွှန်ပြပါ။

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

ဤအရာသည် OpenClaw အတွင်း auto-spawn နှင့် startup wait ကို ကျော်လွှားသွားပါသည်။ Auto-spawn အသုံးပြုစဉ် စတင်နှေးကွေးပါက `channels.signal.startupTimeoutMs` ကို သတ်မှတ်ပါ။

## Access control (DMs + groups)

DM များ:

- မူလ: `channels.signal.dmPolicy = "pairing"`။
- မသိသော ပို့သူများသည် pairing code ကို လက်ခံရရှိပြီး အတည်ပြုမပြုလုပ်မချင်း မက်ဆေ့ချ်များကို လျစ်လျူရှုမည် (code များသည် ၁ နာရီအတွင်း သက်တမ်းကုန်ဆုံးသည်)။
- အတည်ပြုရန်:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- Pairing သည် Signal DMs အတွက် ပုံမှန် token လဲလှယ်နည်းဖြစ်ပါသည်။ အသေးစိတ်: [Pairing](/channels/pairing)
- `sourceUuid` မှ လာသော UUID-only ပို့သူများကို `channels.signal.allowFrom` တွင် `uuid:<id>` အဖြစ် သိမ်းဆည်းသည်။

အုပ်စုများ:

- `channels.signal.groupPolicy = open | allowlist | disabled`။
- `allowlist` ကို သတ်မှတ်ထားသည့်အခါ အုပ်စုတွင် မည်သူက trigger လုပ်နိုင်သည်ကို `channels.signal.groupAllowFrom` က ထိန်းချုပ်သည်။

## အလုပ်လုပ်ပုံ (အပြုအမူ)

- `signal-cli` သည် daemon အဖြစ် လည်ပတ်ပြီး Gateway သည် SSE မှတစ်ဆင့် ဖြစ်ရပ်များကို ဖတ်ယူသည်။
- ဝင်လာသော မက်ဆေ့ချ်များကို မျှဝေထားသော ချန်နယ် envelope သို့ စံသတ်မှတ်ပြောင်းလဲသည်။
- အဖြေများသည် အမြဲ တူညီသော နံပါတ် သို့မဟုတ် အုပ်စုသို့ ပြန်လည်ပို့ဆောင်သည်။

## မီဒီယာ + ကန့်သတ်ချက်များ

- ထွက်သွားသော စာသားကို `channels.signal.textChunkLimit` အထိ ခွဲပိုင်းပြုလုပ်သည် (မူလ 4000)။
- အလိုအလျောက် လိုင်းခွဲခြင်း (optional): အရှည်အလိုက် ခွဲခြင်းမတိုင်မီ အလွတ်လိုင်းများ (စာပိုဒ်နယ်နိမိတ်) တွင် ခွဲရန် `channels.signal.chunkMode="newline"` ကို သတ်မှတ်ပါ။
- Attachments ကို ပံ့ပိုးထားသည် (base64 ကို `signal-cli` မှ ရယူသည်)။
- မီဒီယာ မူလ ကန့်သတ်ချက်: `channels.signal.mediaMaxMb` (မူလ 8)။
- မီဒီယာ ဒေါင်းလုဒ်မလုပ်ရန် `channels.signal.ignoreAttachments` ကို အသုံးပြုပါ။
- Group history context သည် `channels.signal.historyLimit` (သို့မဟုတ် `channels.signal.accounts.*.historyLimit`) ကို အသုံးပြုပြီး `messages.groupChat.historyLimit` သို့ ပြန်လည်ကျဆင်းအသုံးပြုပါသည်။ ပိတ်ရန် `0` ကို သတ်မှတ်ပါ (ပုံမှန် 50)။

## Typing + ဖတ်ပြီး အမှတ်အသားများ

- **Typing indicators**: OpenClaw သည် `signal-cli sendTyping` မှတစ်ဆင့် typing signal များ ပို့ပြီး အဖြေ လည်ပတ်နေစဉ် ပြန်လည် အသက်သွင်းထားသည်။
- **Read receipts**: `channels.signal.sendReadReceipts` သည် true ဖြစ်ပါက OpenClaw သည် ခွင့်ပြုထားသော DM များအတွက် read receipt များကို လွှဲပြောင်းပို့ဆောင်သည်။
- Signal-cli သည် အုပ်စုများအတွက် read receipt များကို မဖော်ပြပေးပါ။

## Reactions (message tool)

- `message action=react` ကို `channel=signal` နှင့်အတူ အသုံးပြုပါ။
- Targets: ပို့သူ၏ E.164 သို့မဟုတ် UUID (pairing output မှ `uuid:<id>` ကို အသုံးပြုပါ; bare UUID လည်း အသုံးပြုနိုင်သည်)။
- `messageId` သည် သင်တုံ့ပြန်မည့် မက်ဆေ့ချ်၏ Signal timestamp ဖြစ်သည်။
- အုပ်စု တုံ့ပြန်မှုများအတွက် `targetAuthor` သို့မဟုတ် `targetAuthorUuid` လိုအပ်သည်။

ဥပမာများ:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Config:

- `channels.signal.actions.reactions`: reaction လုပ်ဆောင်ချက်များကို ဖွင့်/ပိတ် (မူလ true)။
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`။
  - `off`/`ack` သည် အေးဂျင့် reaction များကို ပိတ်သည် (message tool `react` သည် error ပြမည်)။
  - `minimal`/`extensive` သည် အေးဂျင့် reaction များကို ဖွင့်ပြီး လမ်းညွှန်မှု အဆင့်ကို သတ်မှတ်သည်။
- Account တစ်ခုချင်းစီအလိုက် override များ: `channels.signal.accounts.<id>
  .actions.reactions`, `channels.signal.accounts.<id>
  .reactionLevel`။`channels.signal.allowFrom`: DM ခွင့်ပြုစာရင်း (E.164 သို့မဟုတ် `uuid:<id>`)။`open` သည် `"*"` ကို လိုအပ်ပါသည်။

## Delivery targets (CLI/cron)

- DM များ: `signal:+15551234567` (သို့မဟုတ် plain E.164)။
- UUID DM များ: `uuid:<id>` (သို့မဟုတ် bare UUID)။
- အုပ်စုများ: `signal:group:<groupId>`။
- အသုံးပြုသူအမည်များ: `username:<name>` (သင့် Signal အကောင့်မှ ပံ့ပိုးထားပါက)။

## Troubleshooting

ဦးစွာ ဤအဆင့်လိုက်ကို လည်ပတ်ပါ:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

ထို့နောက် လိုအပ်ပါက DM pairing အခြေအနေကို အတည်ပြုပါ:

```bash
openclaw pairing list signal
```

တွေ့ရများသော ချို့ယွင်းချက်များ:

- Daemon ကို ချိတ်ဆက်ရနိုင်သော်လည်း အဖြေမပြန်ပါ: အကောင့်/daemon ဆက်တင်များ (`httpUrl`, `account`) နှင့် receive mode ကို စစ်ဆေးပါ။
- DM များကို လျစ်လျူရှုခြင်း: ပို့သူသည် pairing အတည်ပြုမှုကို စောင့်ဆိုင်းနေသည်။
- အုပ်စု မက်ဆေ့ချ်များကို လျစ်လျူရှုခြင်း: အုပ်စု ပို့သူ/mention gating သည် ပို့ဆောင်မှုကို တားဆီးထားသည်။

Triage လမ်းကြောင်းအတွက်: [/channels/troubleshooting](/channels/troubleshooting)။

## Configuration reference (Signal)

ဖွဲ့စည်းမှု အပြည့်အစုံ: [Configuration](/gateway/configuration)

Provider options:

- `channels.signal.enabled`: ချန်နယ် စတင်မှုကို ဖွင့်/ပိတ်။
- `channels.signal.account`: ဘော့ အကောင့်အတွက် E.164။
- `channels.signal.cliPath`: `signal-cli` သို့ လမ်းကြောင်း။
- `channels.signal.httpUrl`: daemon URL အပြည့်အစုံ (host/port ကို override လုပ်သည်)။
- `channels.signal.httpHost`, `channels.signal.httpPort`: daemon bind (မူလ 127.0.0.1:8080)။
- `channels.signal.autoStart`: daemon ကို auto-spawn လုပ်ခြင်း (မူလ `httpUrl` မသတ်မှတ်ထားပါက true)။
- `channels.signal.startupTimeoutMs`: စတင်စောင့်ဆိုင်းချိန် အကန့်အသတ် ms (အမြင့်ဆုံး 120000)။
- `channels.signal.receiveMode`: `on-start | manual`။
- `channels.signal.ignoreAttachments`: attachment ဒေါင်းလုဒ်များကို ကျော်လွှားခြင်း။
- `channels.signal.ignoreStories`: daemon မှ stories များကို လျစ်လျူရှုခြင်း။
- `channels.signal.sendReadReceipts`: read receipt များကို လွှဲပြောင်းပို့ဆောင်ခြင်း။
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (မူလ: pairing)။
- Signal တွင် username မရှိပါ; ဖုန်းနံပါတ်/UUID id များကို အသုံးပြုပါ။ `channels.signal.dmHistoryLimit`: အသုံးပြုသူ turn အလိုက် DM history ကန့်သတ်ချက်။ အသုံးပြုသူတစ်ဦးချင်းစီအတွက် override များ: `channels.signal.dms["<phone_or_uuid>"].historyLimit`။
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (မူလ: allowlist)။
- `channels.signal.groupAllowFrom`: အုပ်စု ပို့သူ allowlist။
- `channels.signal.historyLimit`: အကြောင်းအရာအဖြစ် ထည့်သွင်းမည့် အုပ်စု မက်ဆေ့ချ် အများဆုံး (0 သည် ပိတ်သည်)။
- **Socket Mode** → ဖွင့်ပါ။ Per-user overrides: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: ထွက်သွားသော chunk အရွယ်အစား (chars)။
- `channels.signal.chunkMode`: `length` (မူလ) သို့မဟုတ် အလွတ်လိုင်းများ (စာပိုဒ်နယ်နိမိတ်) တွင် ခွဲရန် `newline` ကို အသုံးပြုပါ။
- `channels.signal.mediaMaxMb`: ဝင်/ထွက် မီဒီယာ ကန့်သတ်ချက် (MB)။

ဆက်စပ်သော global options:

- `agents.list[].groupChat.mentionPatterns` (Signal သည် native mentions ကို မပံ့ပိုးပါ)။
- `messages.groupChat.mentionPatterns` (global fallback)။
- `messages.responsePrefix`။
