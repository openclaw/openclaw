---
summary: "Matrix ပံ့ပိုးမှု အခြေအနေ၊ လုပ်ဆောင်နိုင်စွမ်းများနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း"
read_when:
  - Matrix ချန်နယ် အင်္ဂါရပ်များကို လုပ်ဆောင်နေစဉ်
title: "Matrix"
x-i18n:
  source_path: channels/matrix.md
  source_hash: 199b954b901cbb17
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:23Z
---

# Matrix (plugin)

Matrix သည် ဖွင့်လှစ်ထားသော၊ ဗဟိုမထားသော မက်ဆေ့ချ်ပို့ဆောင်ရေး ပရိုတိုကောတစ်ခု ဖြစ်သည်။ OpenClaw သည် မည်သည့် homeserver မဆို Matrix **အသုံးပြုသူ** အဖြစ် ချိတ်ဆက်လုပ်ဆောင်သောကြောင့် bot အတွက် Matrix အကောင့်တစ်ခု လိုအပ်ပါသည်။ လော့ဂ်အင် ဝင်ပြီးနောက် bot ကို တိုက်ရိုက် DM ပို့နိုင်သလို အခန်းများ (Matrix “groups”) သို့ ဖိတ်ခေါ်နိုင်ပါသည်။ Beeper ကိုလည်း အသုံးပြုနိုင်သော်လည်း E2EE ကို ဖွင့်ထားရန် လိုအပ်ပါသည်။

အခြေအနေ: plugin (@vector-im/matrix-bot-sdk) ဖြင့် ပံ့ပိုးထားသည်။ Direct messages, rooms, threads, media, reactions,
polls (ပို့ခြင်း + poll-start ကို စာသားအဖြစ်), location နှင့် E2EE (crypto ပံ့ပိုးမှုပါ) ကို ပံ့ပိုးထားသည်။

## Plugin လိုအပ်ချက်

Matrix သည် plugin အဖြစ် ထည့်သွင်းထားပြီး core install တွင် မပါဝင်ပါ။

CLI (npm registry) ဖြင့် ထည့်သွင်းရန်:

```bash
openclaw plugins install @openclaw/matrix
```

Local checkout (git repo မှ chạy သောအခါ):

```bash
openclaw plugins install ./extensions/matrix
```

configure/onboarding အတွင်း Matrix ကို ရွေးချယ်ပြီး git checkout ကို တွေ့ရှိပါက,
OpenClaw သည် local install လမ်းကြောင်းကို အလိုအလျောက် အကြံပြုပါမည်။

အသေးစိတ်: [Plugins](/tools/plugin)

## Setup

1. Matrix plugin ကို ထည့်သွင်းပါ:
   - npm မှ: `openclaw plugins install @openclaw/matrix`
   - local checkout မှ: `openclaw plugins install ./extensions/matrix`
2. homeserver တစ်ခုတွင် Matrix အကောင့် ဖန်တီးပါ:
   - hosting ရွေးချယ်စရာများကို [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/) တွင် ကြည့်ရှုပါ
   - သို့မဟုတ် ကိုယ်တိုင် host ပြုလုပ်ပါ။
3. bot အကောင့်အတွက် access token ရယူပါ:
   - သင့် homeserver တွင် `curl` ကို အသုံးပြုပြီး Matrix login API ကို သုံးပါ:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - `matrix.example.org` ကို သင့် homeserver URL ဖြင့် အစားထိုးပါ။
   - သို့မဟုတ် `channels.matrix.userId` + `channels.matrix.password` ကို သတ်မှတ်ပါ: OpenClaw သည် အတူတူသော
     login endpoint ကို ခေါ်ပြီး access token ကို `~/.openclaw/credentials/matrix/credentials.json` တွင် သိမ်းဆည်းကာ
     နောက်တစ်ကြိမ် စတင်ချိန်တွင် ပြန်လည် အသုံးပြုပါသည်။

4. credentials ကို ဖွဲ့စည်းပြင်ဆင်ပါ:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (သို့မဟုတ် `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - သို့မဟုတ် config: `channels.matrix.*`
   - နှစ်ခုလုံး သတ်မှတ်ထားပါက config ကို ဦးစားပေးပါသည်။
   - access token ဖြင့် အသုံးပြုသောအခါ user ID ကို `/whoami` မှတစ်ဆင့် အလိုအလျောက် ရယူပါသည်။
   - `channels.matrix.userId` ကို သတ်မှတ်ပါက Matrix ID အပြည့်အစုံ ဖြစ်ရပါမည် (ဥပမာ: `@bot:example.org`)။
5. Gateway ကို ပြန်လည်စတင်ပါ (သို့မဟုတ် onboarding ကို ပြီးဆုံးစေပါ)။
6. မည်သည့် Matrix client မဆိုမှ bot နှင့် DM စတင်ပါ သို့မဟုတ် အခန်းသို့ ဖိတ်ခေါ်ပါ
   (Element, Beeper စသည်; [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/) ကို ကြည့်ပါ)။ Beeper သည် E2EE လိုအပ်သဖြင့်
   `channels.matrix.encryption: true` ကို သတ်မှတ်ပြီး device ကို အတည်ပြုပါ။

အနည်းဆုံး config (access token, user ID ကို အလိုအလျောက် ရယူ):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE config (end to end encryption ကို ဖွင့်ထားခြင်း):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Encryption (E2EE)

End-to-end encryption ကို Rust crypto SDK ဖြင့် **ပံ့ပိုးထားပါသည်**။

`channels.matrix.encryption: true` ဖြင့် ဖွင့်ပါ:

- crypto module ကို load လုပ်နိုင်ပါက encrypted rooms များကို အလိုအလျောက် decrypt လုပ်ပါသည်။
- encrypted rooms သို့ ပို့သော outbound media ကို encryption လုပ်ပါသည်။
- ပထမဆုံး ချိတ်ဆက်ချိန်တွင် OpenClaw သည် သင့်အခြား session များမှ device verification ကို တောင်းခံပါသည်။
- key sharing ကို ဖွင့်နိုင်ရန် အခြား Matrix client (Element စသည်) တွင် device ကို အတည်ပြုပါ။
- crypto module ကို load မလုပ်နိုင်ပါက E2EE ကို ပိတ်ထားပြီး encrypted rooms များကို decrypt မလုပ်နိုင်ပါ;
  OpenClaw သည် သတိပေးချက်ကို log ထဲတွင် ရေးသားပါသည်။
- crypto module မရှိကြောင်း error များကို တွေ့ရပါက (ဥပမာ `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  `@matrix-org/matrix-sdk-crypto-nodejs` အတွက် build scripts ကို ခွင့်ပြုပြီး
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` ကို chạy ပါ သို့မဟုတ်
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` ဖြင့် binary ကို ရယူပါ။

Crypto အခြေအနေကို account + access token တစ်ခုချင်းစီအလိုက်
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite database) တွင် သိမ်းဆည်းထားပါသည်။ Sync state ကို `bot-storage.json` တွင် အတူတကွ သိမ်းဆည်းထားပါသည်။
access token (device) ပြောင်းလဲသွားပါက store အသစ်တစ်ခု ဖန်တီးပြီး
encrypted rooms များအတွက် bot ကို ပြန်လည် အတည်ပြုရပါမည်။

**Device အတည်ပြုခြင်း:**
E2EE ကို ဖွင့်ထားသောအခါ bot သည် စတင်ချိန်တွင် သင့်အခြား session များထံ အတည်ပြုရန် တောင်းဆိုပါသည်။
Element (သို့မဟုတ် အခြား client) ကို ဖွင့်ပြီး verification တောင်းဆိုချက်ကို ခွင့်ပြုပါ။
အတည်ပြုပြီးပါက bot သည် encrypted rooms များတွင် မက်ဆေ့ချ်များကို decrypt လုပ်နိုင်ပါသည်။

## Routing model

- ပြန်ကြားချက်များသည် အမြဲတမ်း Matrix သို့ ပြန်ပို့ပါသည်။
- DMs များသည် agent ၏ အဓိက session ကို မျှဝေသုံးစွဲပြီး rooms များကို group sessions အဖြစ် ချိတ်ဆက်ပါသည်။

## Access control (DMs)

- မူလအခြေအနေ: `channels.matrix.dm.policy = "pairing"`။ မသိရှိသော ပို့သူများသည် pairing code ရရှိပါသည်။
- အတည်ပြုရန်:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- အများပြည်သူ DMs: `channels.matrix.dm.policy="open"` နှင့် `channels.matrix.dm.allowFrom=["*"]`။
- `channels.matrix.dm.allowFrom` သည် Matrix user ID အပြည့်အစုံကို လက်ခံပါသည် (ဥပမာ: `@user:server`)။ directory search တွင် တစ်ခုတည်းသော တိကျကိုက်ညီမှုကို တွေ့ရှိပါက wizard သည် display name များကို user ID များအဖြစ် ဖြေရှင်းပေးပါသည်။

## Rooms (groups)

- မူလအခြေအနေ: `channels.matrix.groupPolicy = "allowlist"` (mention-gated)။ မသတ်မှတ်ထားပါက `channels.defaults.groupPolicy` ဖြင့် မူလတန်ဖိုးကို အစားထိုးနိုင်ပါသည်။
- `channels.matrix.groups` ဖြင့် rooms များကို allowlist ပြုလုပ်ပါ (room IDs သို့မဟုတ် aliases; directory search တွင် တစ်ခုတည်းသော တိကျကိုက်ညီမှုကို တွေ့ရှိပါက name များကို ID များအဖြစ် ဖြေရှင်းပါသည်):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` သည် ထိုအခန်းတွင် auto-reply ကို ဖွင့်ပါသည်။
- `groups."*"` သည် rooms များအတွင်း mention gating အတွက် မူလတန်ဖိုးများကို သတ်မှတ်နိုင်ပါသည်။
- `groupAllowFrom` သည် rooms များတွင် bot ကို trigger လုပ်နိုင်သော ပို့သူများကို ကန့်သတ်ပါသည် (Matrix user ID အပြည့်အစုံ)။
- အခန်းတစ်ခန်းချင်းစီအလိုက် `users` allowlists များဖြင့် အခန်းအတွင်း ပို့သူများကို ထပ်မံ ကန့်သတ်နိုင်ပါသည် (Matrix user ID အပြည့်အစုံကို အသုံးပြုပါ)။
- configure wizard သည် room allowlists (room IDs, aliases သို့မဟုတ် names) ကို မေးမြန်းပြီး တိကျပြီး ထူးခြားသော ကိုက်ညီမှုရှိမှသာ names များကို ဖြေရှင်းပါသည်။
- စတင်ချိန်တွင် OpenClaw သည် allowlists အတွင်းရှိ room/user names များကို IDs များအဖြစ် ဖြေရှင်းပြီး mapping ကို log ထဲတွင် ရေးသားပါသည်; မဖြေရှင်းနိုင်သော entries များကို allowlist matching အတွက် လျစ်လျူရှုပါသည်။
- ဖိတ်ခေါ်ချက်များကို မူလအနေဖြင့် အလိုအလျောက် join လုပ်ပါသည်; `channels.matrix.autoJoin` နှင့် `channels.matrix.autoJoinAllowlist` ဖြင့် ထိန်းချုပ်နိုင်ပါသည်။
- **အခန်း မရှိစေရန်**, `channels.matrix.groupPolicy: "disabled"` ကို သတ်မှတ်ပါ (သို့မဟုတ် allowlist ကို အလွတ်ထားပါ)။
- Legacy key: `channels.matrix.rooms` (`groups` နှင့် ပုံစံတူ)။

## Threads

- Reply threading ကို ပံ့ပိုးထားပါသည်။
- `channels.matrix.threadReplies` သည် ပြန်ကြားချက်များကို thread အတွင်း ဆက်လက်ထားမည်မဟုတ်မည်ကို ထိန်းချုပ်ပါသည်:
  - `off`, `inbound` (မူလ), `always`
- `channels.matrix.replyToMode` သည် thread မဟုတ်သောအခါ reply-to metadata ကို ထိန်းချုပ်ပါသည်:
  - `off` (မူလ), `first`, `all`

## Capabilities

| Feature         | Status                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Direct messages | ✅ ပံ့ပိုးထားသည်                                                                                                |
| Rooms           | ✅ ပံ့ပိုးထားသည်                                                                                                |
| Threads         | ✅ ပံ့ပိုးထားသည်                                                                                                |
| Media           | ✅ ပံ့ပိုးထားသည်                                                                                                |
| E2EE            | ✅ ပံ့ပိုးထားသည် (crypto module လိုအပ်)                                                                         |
| Reactions       | ✅ ပံ့ပိုးထားသည် (tools မှတစ်ဆင့် ပို့/ဖတ်)                                                                     |
| Polls           | ✅ ပို့ခြင်း ပံ့ပိုးထားသည်; ဝင်လာသော poll start များကို စာသားအဖြစ် ပြောင်းလဲသည် (responses/ends ကို လျစ်လျူရှု) |
| Location        | ✅ ပံ့ပိုးထားသည် (geo URI; altitude ကို လျစ်လျူရှု)                                                             |
| Native commands | ✅ ပံ့ပိုးထားသည်                                                                                                |

## Troubleshooting

အရင်ဆုံး အောက်ပါ ladder ကို chạy ပါ:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

လိုအပ်ပါက DM pairing အခြေအနေကို အတည်ပြုပါ:

```bash
openclaw pairing list matrix
```

တွေ့ရလေ့ရှိသော အမှားများ:

- Logged in ဖြစ်သော်လည်း room မက်ဆေ့ချ်များကို လျစ်လျူရှုခြင်း: room ကို `groupPolicy` သို့မဟုတ် room allowlist မှ ပိတ်ထားခြင်း။
- DMs ကို လျစ်လျူရှုခြင်း: `channels.matrix.dm.policy="pairing"` ဖြစ်နေချိန်တွင် ပို့သူသည် အတည်ပြုရန် စောင့်ဆိုင်းနေခြင်း။
- Encrypted rooms မအောင်မြင်ခြင်း: crypto ပံ့ပိုးမှု သို့မဟုတ် encryption ဆက်တင် မကိုက်ညီခြင်း။

triage လမ်းကြောင်းအတွက်: [/channels/troubleshooting](/channels/troubleshooting)။

## Configuration reference (Matrix)

Configuration အပြည့်အစုံ: [Configuration](/gateway/configuration)

Provider ရွေးချယ်စရာများ:

- `channels.matrix.enabled`: channel စတင်ခြင်းကို ဖွင့်/ပိတ်။
- `channels.matrix.homeserver`: homeserver URL။
- `channels.matrix.userId`: Matrix user ID (access token ရှိပါက မလိုအပ်)။
- `channels.matrix.accessToken`: access token။
- `channels.matrix.password`: login အတွက် စကားဝှက် (token ကို သိမ်းဆည်းထားသည်)။
- `channels.matrix.deviceName`: device display name။
- `channels.matrix.encryption`: E2EE ကို ဖွင့် (မူလ: false)။
- `channels.matrix.initialSyncLimit`: initial sync limit။
- `channels.matrix.threadReplies`: `off | inbound | always` (မူလ: inbound)။
- `channels.matrix.textChunkLimit`: outbound စာသား chunk အရွယ်အစား (chars)။
- `channels.matrix.chunkMode`: `length` (မူလ) သို့မဟုတ် `newline` ကို အသုံးပြုပြီး အလွတ်လိုင်းများ (paragraph boundaries) အပေါ် မူတည်၍ ခွဲထုတ်ပြီးနောက် အရှည်အလိုက် chunk ပြုလုပ်ခြင်း။
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (မူလ: pairing)။
- `channels.matrix.dm.allowFrom`: DM allowlist (Matrix user ID အပြည့်အစုံ)။ `open` သည် `"*"` ကို လိုအပ်ပါသည်။ wizard သည် ဖြစ်နိုင်ပါက names များကို IDs များအဖြစ် ဖြေရှင်းပါသည်။
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (မူလ: allowlist)။
- `channels.matrix.groupAllowFrom`: group မက်ဆေ့ချ်များအတွက် allowlisted ပို့သူများ (Matrix user ID အပြည့်အစုံ)။
- `channels.matrix.allowlistOnly`: DMs + rooms အတွက် allowlist စည်းမျဉ်းများကို အတင်းအကျပ် အသုံးပြုစေခြင်း။
- `channels.matrix.groups`: group allowlist + per-room settings map။
- `channels.matrix.rooms`: legacy group allowlist/config။
- `channels.matrix.replyToMode`: threads/tags အတွက် reply-to mode။
- `channels.matrix.mediaMaxMb`: inbound/outbound media ကန့်သတ်ချက် (MB)။
- `channels.matrix.autoJoin`: invite ကို ကိုင်တွယ်ပုံ (`always | allowlist | off`, မူလ: always)။
- `channels.matrix.autoJoinAllowlist`: auto-join အတွက် ခွင့်ပြုထားသော room IDs/aliases။
- `channels.matrix.actions`: action တစ်ခုချင်းစီအလိုက် tool gating (reactions/messages/pins/memberInfo/channelInfo)။
