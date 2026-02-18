---
summary: "Nextcloud Talk အတွက် ပံ့ပိုးမှုအခြေအနေ၊ လုပ်ဆောင်နိုင်စွမ်းများနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း"
read_when:
  - Nextcloud Talk ချန်နယ် အင်္ဂါရပ်များပေါ်တွင် အလုပ်လုပ်နေစဉ်
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

အခြေအနေ: plugin (webhook bot) ဖြင့် ထောက်ပံ့ထားသည်။ Direct message များ၊ room များ၊ reaction များနှင့် markdown message များကို ထောက်ပံ့ထားသည်။

## Plugin လိုအပ်သည်

Nextcloud Talk ကို plugin အဖြစ် ပို့ဆောင်ထားပြီး core install တွင် မပါဝင်ပါ။

CLI ဖြင့် ထည့်သွင်းတပ်ဆင်ရန် (npm registry):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Local checkout (git repo မှ chạyနေစဉ်):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

configure/onboarding အတွင်း Nextcloud Talk ကို ရွေးချယ်ပြီး git checkout ကို တွေ့ရှိပါက၊
OpenClaw သည် local install လမ်းကြောင်းကို အလိုအလျောက် ပေးအပ်ပါမည်။

အသေးစိတ်: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Nextcloud Talk plugin ကို ထည့်သွင်းတပ်ဆင်ပါ။

2. သင်၏ Nextcloud server တွင် bot တစ်ခု ဖန်တီးပါ:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. ဦးတည်ထားသော room ၏ settings တွင် bot ကို ဖွင့်ပါ။

4. OpenClaw ကို ဖွဲ့စည်းပြင်ဆင်ပါ:
   - Config: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - သို့မဟုတ် env: `NEXTCLOUD_TALK_BOT_SECRET` (default account အတွက်သာ)

5. Gateway ကို ပြန်လည်စတင်ပါ (သို့မဟုတ် onboarding ကို ပြီးစီးပါ)။

အနည်းဆုံး config:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Notes

- Bot များသည် DM ကို ကိုယ်တိုင် မစတင်နိုင်ပါ။ User သည် အရင်ဆုံး bot သို့ message ပို့ရပါမည်။
- Webhook URL ကို Gateway မှ ဝင်ရောက်နိုင်ရပါမည်။ proxy အောက်တွင်ရှိပါက `webhookPublicUrl` ကို သတ်မှတ်ပါ။
- Bot API မှ media uploads ကို မပံ့ပိုးပါ; media များကို URL အဖြစ် ပို့ဆောင်ပါသည်။
- Webhook payload သည် DMs နှင့် rooms ကို ခွဲခြားမပြသပါ; room-type lookup များကို ဖွင့်ရန် `apiUser` + `apiPassword` ကို သတ်မှတ်ပါ (မဟုတ်ပါက DMs များကို rooms အဖြစ် ဆက်ဆံပါမည်)။

## Access control (DMs)

- မူလ: `channels.nextcloud-talk.dmPolicy = "pairing"`။ မသိသော ပို့သူများသည် pairing code ကို ရရှိပါသည်။
- အတည်ပြုရန်:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Public DMs: `channels.nextcloud-talk.dmPolicy="open"` နှင့်အတူ `channels.nextcloud-talk.allowFrom=["*"]`။
- `allowFrom` သည် Nextcloud user IDs များကိုသာ ကိုက်ညီစေပြီး display names များကို လျစ်လျူရှုပါသည်။

## Rooms (groups)

- Default: `channels.nextcloud-talk.groupPolicy = "allowlist"` (mention ဖြင့်သာ ဝင်ရောက်နိုင်ခြင်း)။
- `channels.nextcloud-talk.rooms` ဖြင့် rooms များကို allowlist ပြုလုပ်ပါ:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- မည်သည့် room မဆို ခွင့်မပြုလိုပါက allowlist ကို အလွတ်ထားပါ သို့မဟုတ် `channels.nextcloud-talk.groupPolicy="disabled"` ကို သတ်မှတ်ပါ။

## Capabilities

| Feature         | Status        |
| --------------- | ------------- |
| Direct messages | ပံ့ပိုးထားသည် |
| Rooms           | ပံ့ပိုးထားသည် |
| Threads         | မပံ့ပိုးပါ    |
| Media           | URL အသာ       |
| Reactions       | ပံ့ပိုးထားသည် |
| Native commands | မပံ့ပိုးပါ    |

## Configuration reference (Nextcloud Talk)

Configuration အပြည့်အစုံ: [Configuration](/gateway/configuration)

Provider options:

- `channels.nextcloud-talk.enabled`: ချန်နယ် စတင်မှုကို ဖွင့်/ပိတ်။
- `channels.nextcloud-talk.baseUrl`: Nextcloud instance URL။
- `channels.nextcloud-talk.botSecret`: bot shared secret။
- `channels.nextcloud-talk.botSecretFile`: secret ဖိုင်လမ်းကြောင်း။
- `channels.nextcloud-talk.apiUser`: room lookups (DM detection) အတွက် API user။
- `channels.nextcloud-talk.apiPassword`: room lookups အတွက် API/app password။
- `channels.nextcloud-talk.apiPasswordFile`: API password ဖိုင်လမ်းကြောင်း။
- `channels.nextcloud-talk.webhookPort`: webhook listener port (default: 8788)။
- `channels.nextcloud-talk.webhookHost`: webhook host (default: 0.0.0.0)။
- `channels.nextcloud-talk.webhookPath`: webhook path (default: /nextcloud-talk-webhook)။
- `channels.nextcloud-talk.webhookPublicUrl`: ပြင်ပမှ ဝင်ရောက်နိုင်သော webhook URL။
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`။
- `channels.nextcloud-talk.allowFrom`: DM allowlist (user ID များ)။ `open` အတွက် `"*"` လိုအပ်ပါသည်။
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`။
- `channels.nextcloud-talk.groupAllowFrom`: group allowlist (user IDs)။
- `channels.nextcloud-talk.rooms`: per-room settings နှင့် allowlist။
- `channels.nextcloud-talk.historyLimit`: group history limit (0 သတ်မှတ်ပါက ပိတ်)။
- `channels.nextcloud-talk.dmHistoryLimit`: DM history limit (0 သတ်မှတ်ပါက ပိတ်)။
- `channels.nextcloud-talk.dms`: per-DM overrides (historyLimit)။
- `channels.nextcloud-talk.textChunkLimit`: အပြင်ထွက် text ကို အပိုင်းခွဲပို့သည့် အရွယ်အစား (chars)။
- `channels.nextcloud-talk.chunkMode`: `length` (default) သို့မဟုတ် `newline` ကို အသုံးပြုပြီး အရှည်အလိုက် ခွဲခြင်းမပြုမီ blank lines (paragraph boundaries) ပေါ်မူတည်၍ ခွဲရန်။
- `channels.nextcloud-talk.blockStreaming`: ဤချန်နယ်အတွက် block streaming ကို ပိတ်ရန်။
- `channels.nextcloud-talk.blockStreamingCoalesce`: block streaming coalesce tuning။
- `channels.nextcloud-talk.mediaMaxMb`: inbound media ကန့်သတ်ချက် (MB)။
