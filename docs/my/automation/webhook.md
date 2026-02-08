---
summary: "နိုးကြားမှုနှင့် သီးခြားထားသော အေးဂျင့် လည်ပတ်မှုများအတွက် Webhook ဝင်ပေါက်"
read_when:
  - Webhook endpoint များကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း
  - အပြင်ပစနစ်များကို OpenClaw နှင့် ချိတ်ဆက်ခြင်း
title: "Webhooks"
x-i18n:
  source_path: automation/webhook.md
  source_hash: f26b88864567be82
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:08Z
---

# Webhooks

Gateway သည် အပြင်ပမှ trigger များအတွက် အသုံးပြုနိုင်သော HTTP webhook endpoint သေးငယ်တစ်ခုကို ဖော်ထုတ်ပေးနိုင်သည်။

## Enable

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Notes:

- `hooks.token` သည် `hooks.enabled=true` ဖြစ်သောအခါ လိုအပ်သည်။
- `hooks.path` ၏ မူလတန်ဖိုးမှာ `/hooks` ဖြစ်သည်။

## Auth

Request တိုင်းတွင် hook token ကို ထည့်သွင်းရပါမည်။ Header များကို အသုံးပြုရန် အကြံပြုပါသည်—

- `Authorization: Bearer <token>` (အကြံပြု)
- `x-openclaw-token: <token>`
- `?token=<token>` (မထောက်ခံတော့ပါ; log တွင် သတိပေးချက် ထုတ်ပေးမည်ဖြစ်ပြီး အနာဂတ် major release တွင် ဖယ်ရှားမည်)

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **လိုအပ်သည်** (string): ဖြစ်ရပ်၏ ဖော်ပြချက် (ဥပမာ၊ "New email received")။
- `mode` ရွေးချယ်နိုင်သည် (`now` | `next-heartbeat`): ချက်ချင်း heartbeat ကို trigger လုပ်မလား (မူလ `now`) သို့မဟုတ် နောက်တစ်ကြိမ် အချိန်ကာလဆိုင်ရာ စစ်ဆေးမှုကို စောင့်မလား။

Effect:

- **main** session အတွက် system event တစ်ခုကို queue ထဲသို့ ထည့်သွင်းသည်
- `mode=now` ဖြစ်ပါက ချက်ချင်း heartbeat ကို trigger လုပ်သည်

### `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **လိုအပ်သည်** (string): အေးဂျင့်မှ ကိုင်တွယ်ဆောင်ရွက်ရန် prompt သို့မဟုတ် မက်ဆေ့ချ်။
- `name` ရွေးချယ်နိုင်သည် (string): hook အတွက် လူသားဖတ်ရှုနိုင်သော အမည် (ဥပမာ၊ "GitHub")၊ session summary များတွင် prefix အဖြစ် အသုံးပြုသည်။
- `sessionKey` ရွေးချယ်နိုင်သည် (string): အေးဂျင့်၏ session ကို ခွဲခြားသတ်မှတ်ရန် အသုံးပြုသည့် key။ မူလအားဖြင့် ကျပန်း `hook:<uuid>` ကို အသုံးပြုသည်။ တူညီသော key ကို အသုံးပြုပါက hook context အတွင်း multi-turn စကားဝိုင်း ပြုလုပ်နိုင်သည်။
- `wakeMode` ရွေးချယ်နိုင်သည် (`now` | `next-heartbeat`): ချက်ချင်း heartbeat ကို trigger လုပ်မလား (မူလ `now`) သို့မဟုတ် နောက်တစ်ကြိမ် အချိန်ကာလဆိုင်ရာ စစ်ဆေးမှုကို စောင့်မလား။
- `deliver` ရွေးချယ်နိုင်သည် (boolean): `true` ဖြစ်ပါက အေးဂျင့်၏ တုံ့ပြန်ချက်ကို မက်ဆေ့ချ် ချန်နယ်သို့ ပို့ပေးမည်ဖြစ်သည်။ မူလတန်ဖိုးမှာ `true` ဖြစ်သည်။ heartbeat အတည်ပြုချက်သာ ပါဝင်သော တုံ့ပြန်ချက်များကို အလိုအလျောက် ကျော်သွားမည်။
- `channel` ရွေးချယ်နိုင်သည် (string): ပို့ဆောင်ရန် မက်ဆေ့ချ် ချန်နယ်။ အောက်ပါတို့မှ တစ်ခုဖြစ်ရမည်— `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`။ မူလတန်ဖိုးမှာ `last` ဖြစ်သည်။
- `to` ရွေးချယ်နိုင်သည် (string): ချန်နယ်အတွက် လက်ခံသူ အမှတ်အသား (ဥပမာ၊ WhatsApp/Signal အတွက် ဖုန်းနံပါတ်၊ Telegram အတွက် chat ID၊ Discord/Slack/Mattermost (plugin) အတွက် channel ID၊ MS Teams အတွက် conversation ID)။ မူလအားဖြင့် main session တွင် နောက်ဆုံးအသုံးပြုခဲ့သော လက်ခံသူကို အသုံးပြုသည်။
- `model` ရွေးချယ်နိုင်သည် (string): မော်ဒယ် override (ဥပမာ၊ `anthropic/claude-3-5-sonnet` သို့မဟုတ် alias)။ ကန့်သတ်ထားပါက ခွင့်ပြုထားသော model စာရင်းအတွင်း ပါဝင်ရပါမည်။
- `thinking` ရွေးချယ်နိုင်သည် (string): စဉ်းစားမှုအဆင့် override (ဥပမာ၊ `low`, `medium`, `high`)။
- `timeoutSeconds` ရွေးချယ်နိုင်သည် (number): အေးဂျင့် လည်ပတ်မှုအတွက် အများဆုံး ကြာချိန် (စက္ကန့်ဖြင့်)။

Effect:

- **သီးခြားထားသော** အေးဂျင့် turn တစ်ခုကို လည်ပတ်စေသည် (ကိုယ်ပိုင် session key ဖြင့်)
- **main** session ထဲသို့ အကျဉ်းချုပ်ကို အမြဲတမ်း တင်ပို့သည်
- `wakeMode=now` ဖြစ်ပါက ချက်ချင်း heartbeat ကို trigger လုပ်သည်

### `POST /hooks/<name>` (mapped)

Custom hook အမည်များကို `hooks.mappings` (configuration ကို ကြည့်ပါ) မှတဆင့် ဖြေရှင်းပေးသည်။ Mapping တစ်ခုသည်
အမျိုးမျိုးသော payload များကို `wake` သို့မဟုတ် `agent` လုပ်ဆောင်ချက်များအဖြစ် ပြောင်းလဲနိုင်ပြီး template များ သို့မဟုတ်
code transform များကိုလည်း ရွေးချယ်အသုံးပြုနိုင်သည်။

Mapping options (အကျဉ်းချုပ်):

- `hooks.presets: ["gmail"]` သည် built-in Gmail mapping ကို ဖွင့်ပေးသည်။
- `hooks.mappings` ဖြင့် `match`, `action` နှင့် template များကို config တွင် သတ်မှတ်နိုင်သည်။
- `hooks.transformsDir` + `transform.module` သည် custom logic အတွက် JS/TS module တစ်ခုကို load လုပ်သည်။
- `match.source` ကို အသုံးပြု၍ generic ingest endpoint (payload အခြေပြု routing) ကို ထိန်းသိမ်းထားနိုင်သည်။
- TS transform များအတွက် TS loader (ဥပမာ `bun` သို့မဟုတ် `tsx`) သို့မဟုတ် runtime တွင် precompiled `.js` လိုအပ်သည်။
- Mapping များတွင် `deliver: true` + `channel`/`to` ကို သတ်မှတ်၍ chat surface သို့ ပြန်လည်တုံ့ပြန်ချက်များကို route လုပ်နိုင်သည်
  (`channel` ၏ မူလတန်ဖိုးမှာ `last` ဖြစ်ပြီး WhatsApp သို့ fallback လုပ်သည်)။
- `allowUnsafeExternalContent: true` သည် ထို hook အတွက် external content safety wrapper ကို ပိတ်ထားသည်
  (အန္တရာယ်ရှိသည်; ယုံကြည်ရသော အတွင်းပိုင်းရင်းမြစ်များအတွက်သာ အသုံးပြုပါ)။
- `openclaw webhooks gmail setup` သည် `openclaw webhooks gmail run` အတွက် `hooks.gmail` config ကို ရေးသားပေးသည်။
  Gmail watch flow အပြည့်အစုံကို [Gmail Pub/Sub](/automation/gmail-pubsub) တွင် ကြည့်ပါ။

## Responses

- `200` for `/hooks/wake`
- `202` for `/hooks/agent` (async run စတင်ပြီ)
- Auth မအောင်မြင်ပါက `401`
- Payload မမှန်ကန်ပါက `400`
- Payload အရွယ်အစား ကြီးလွန်းပါက `413`

## Examples

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Use a different model

အဲဒီ run အတွက် model ကို override လုပ်ရန် agent payload (သို့မဟုတ် mapping) ထဲသို့ `model` ကို ထည့်ပါ—

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

`agents.defaults.models` ကို အတင်းအကျပ် သတ်မှတ်ထားပါက override model သည် ထိုစာရင်းအတွင်း ပါဝင်ကြောင်း သေချာစေပါ။

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Security

- Hook endpoint များကို loopback, tailnet သို့မဟုတ် ယုံကြည်ရသော reverse proxy နောက်တွင်သာ ထားရှိပါ။
- သီးသန့် hook token ကို အသုံးပြုပါ; gateway auth token များကို ပြန်လည်အသုံးမပြုပါနှင့်။
- Webhook log များတွင် အရေးကြီးသော raw payload များကို မထည့်သွင်းပါနှင့်။
- Hook payload များကို မယုံကြည်ရသော အချက်အလက်များအဖြစ် သဘောထားပြီး မူလအားဖြင့် safety boundary များဖြင့် ဖုံးအုပ်ထားသည်။
  Hook တစ်ခုအတွက်သာ ပိတ်ရန် လိုအပ်ပါက ထို hook ၏ mapping တွင် `allowUnsafeExternalContent: true` ကို သတ်မှတ်ပါ
  (အန္တရာယ်ရှိသည်)။
