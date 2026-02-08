---
summary: "OpenClaw သည် auth profile များကို မည်သို့ လှည့်ပြောင်းအသုံးပြုပြီး မော်ဒယ်များအကြား fallback ပြုလုပ်သနည်း"
read_when:
  - auth profile လှည့်ပြောင်းမှု၊ cooldown များ သို့မဟုတ် မော်ဒယ် fallback အပြုအမူများကို စစ်ဆေးခွဲခြမ်းစိတ်ဖြာနေသည့်အခါ
  - auth profile များ သို့မဟုတ် မော်ဒယ်များအတွက် failover စည်းမျဉ်းများကို အပ်ဒိတ်လုပ်နေသည့်အခါ
title: "မော်ဒယ် Failover"
x-i18n:
  source_path: concepts/model-failover.md
  source_hash: eab7c0633824d941
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:32Z
---

# မော်ဒယ် failover

OpenClaw သည် ချို့ယွင်းမှုများကို အဆင့်နှစ်ဆင့်ဖြင့် ကိုင်တွယ်သည်-

1. လက်ရှိ provider အတွင်း **Auth profile လှည့်ပြောင်းခြင်း**။
2. `agents.defaults.model.fallbacks` ထဲရှိ နောက်ထပ် မော်ဒယ်သို့ **Model fallback** ပြုလုပ်ခြင်း။

ဤစာတမ်းသည် runtime စည်းမျဉ်းများနှင့် ၎င်းတို့ကို ထောက်ပံ့ပေးသော ဒေတာများကို ရှင်းပြထားသည်။

## Auth သိမ်းဆည်းမှု (keys + OAuth)

OpenClaw သည် API keys နှင့် OAuth tokens နှစ်မျိုးစလုံးအတွက် **auth profiles** ကို အသုံးပြုသည်။

- Secrets များကို `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` တွင် သိမ်းဆည်းထားသည် (legacy: `~/.openclaw/agent/auth-profiles.json`)။
- Config `auth.profiles` / `auth.order` များသည် **metadata + routing အတွက်သာ** ဖြစ်ပြီး (secrets မပါ)။
- Legacy import-only OAuth ဖိုင်: `~/.openclaw/credentials/oauth.json` (ပထမဆုံး အသုံးပြုချိန်တွင် `auth-profiles.json` သို့ import လုပ်သည်)။

အသေးစိတ်: [/concepts/oauth](/concepts/oauth)

Credential အမျိုးအစားများ-

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ provider အချို့အတွက် `projectId`/`enterpriseUrl`)

## Profile ID များ

OAuth ဖြင့် login ဝင်သောအခါ အကောင့်အများအပြားကို တပြိုင်နက်တည်း ရှိနိုင်စေရန် distinct profile များကို ဖန်တီးပေးသည်။

- Default: email မရရှိနိုင်သည့်အခါ `provider:default`။
- Email ပါသော OAuth: `provider:<email>` (ဥပမာ `google-antigravity:user@gmail.com`)။

Profiles များကို `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` အောက်ရှိ `profiles` တွင် သိမ်းဆည်းထားသည်။

## လှည့်ပြောင်းမှု အစဉ်အတိုင်း

Provider တစ်ခုတွင် profile အများအပြား ရှိပါက OpenClaw သည် အောက်ပါအစဉ်အတိုင်းကို ရွေးချယ်သည်-

1. **အတိအလင်း config**: `auth.order[provider]` (သတ်မှတ်ထားပါက)။
2. **Config ပြုလုပ်ထားသော profiles**: provider အလိုက် စစ်ထုတ်ထားသော `auth.profiles`။
3. **သိမ်းဆည်းထားသော profiles**: provider အတွက် `auth-profiles.json` ထဲရှိ entries များ။

အတိအလင်း အစဉ်အတိုင်း မသတ်မှတ်ထားပါက OpenClaw သည် round‑robin အစဉ်အတိုင်းကို အသုံးပြုသည်-

- **Primary key:** profile အမျိုးအစား (**OAuth ကို API keys များထက် အရင်**)။
- **Secondary key:** `usageStats.lastUsed` (အမျိုးအစားတစ်ခုစီအတွင်း အဟောင်းဆုံးမှ စတင်)။
- **Cooldown/disabled profiles** များကို အဆုံးဘက်သို့ ရွှေ့ပြီး သက်တမ်းကုန်ဆုံးချိန် အနီးဆုံးအလိုက် စီထားသည်။

### Session stickiness (cache‑friendly)

OpenClaw သည် provider cache များကို ပူနွေးအောင် ထိန်းသိမ်းရန် **session တစ်ခုချင်းစီအလိုက် ရွေးချယ်ထားသော auth profile ကို pin လုပ်ထားသည်**။
တောင်းဆိုမှုတိုင်း마다 မလှည့်ပြောင်းပါ။ Pin လုပ်ထားသော profile ကို အောက်ပါအခြေအနေများ မဖြစ်မချင်း ပြန်လည်အသုံးပြုသည်-

- session ကို reset လုပ်သောအခါ (`/new` / `/reset`)
- compaction ပြီးစီးပြီး (compaction count တိုးလာသောအခါ)
- profile သည် cooldown/disabled ဖြစ်သွားသောအခါ

`/model …@<profileId>` ဖြင့် လက်ဖြင့် ရွေးချယ်ခြင်းသည် ထို session အတွက် **user override** ကို သတ်မှတ်ပေးပြီး
session အသစ် မစတင်မချင်း auto‑rotate မလုပ်ပါ။

Auto‑pinned profiles များ (session router မှ ရွေးချယ်ပေးသော profile များ) ကို **preference** အဖြစ် သတ်မှတ်ထားသည်-
အရင်ဆုံး စမ်းသပ်မည် ဖြစ်သော်လည်း rate limit/timeouts ဖြစ်လာပါက OpenClaw သည် အခြား profile သို့ လှည့်ပြောင်းနိုင်သည်။
User‑pinned profiles များသည် ထို profile ကိုသာ လော့ခ်ထားပြီး ဆက်လက်အသုံးပြုသည်; မအောင်မြင်ပါက
model fallback များကို ပြင်ဆင်ထားလျှင် OpenClaw သည် profile ပြောင်းခြင်းမလုပ်ဘဲ နောက်ထပ် မော်ဒယ်သို့သာ ရွှေ့သွားသည်။

### OAuth “ပျောက်သွားသလို” မြင်ရနိုင်သည့် အကြောင်းရင်း

Provider တစ်ခုအတွက် OAuth profile နှင့် API key profile နှစ်မျိုးလုံး ရှိပါက pin မလုပ်ထားသရွေ့ round‑robin ကြောင့် မက်ဆေ့ချ်များအကြား profile များ ပြောင်းလဲနိုင်သည်။ Profile တစ်ခုတည်းကို အတင်းအသုံးပြုလိုပါက-

- `auth.order[provider] = ["provider:profileId"]` ဖြင့် pin လုပ်ပါ၊ သို့မဟုတ်
- သင့် UI/chat surface က ထောက်ပံ့ပါက profile override ပါသော `/model …` ဖြင့် per‑session override ကို အသုံးပြုပါ။

## Cooldowns

Profile တစ်ခုသည် auth/rate‑limit အမှားများကြောင့် (သို့မဟုတ် rate limiting လိုဖြစ်ပုံရသော timeout) မအောင်မြင်ပါက OpenClaw သည် ၎င်းကို cooldown သို့ သတ်မှတ်ပြီး နောက်ထပ် profile သို့ ရွှေ့သွားသည်။
Format/invalid‑request အမှားများ (ဥပမာ Cloud Code Assist tool call ID စစ်ဆေးမှု မအောင်မြင်ခြင်း) ကိုလည်း failover လုပ်သင့်သော အမှားများအဖြစ် သတ်မှတ်ပြီး cooldown များကို အတူတူ အသုံးပြုသည်။

Cooldown များသည် exponential backoff ကို အသုံးပြုသည်-

- ၁ မိနစ်
- ၅ မိနစ်
- ၂၅ မိနစ်
- ၁ နာရီ (အများဆုံး)

State ကို `auth-profiles.json` အောက်ရှိ `usageStats` တွင် သိမ်းဆည်းထားသည်-

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Billing ကြောင့် disable လုပ်ခြင်း

Billing/credit မအောင်မြင်မှုများ (ဥပမာ “insufficient credits” / “credit balance too low”) ကို failover လုပ်သင့်သော အဖြစ်အပျက်များအဖြစ် သတ်မှတ်သော်လည်း အများအားဖြင့် ယာယီမဟုတ်ပါ။ Short cooldown မပေးဘဲ OpenClaw သည် profile ကို **disabled** အဖြစ် သတ်မှတ်ပြီး (backoff ပိုရှည်စေကာ) နောက်ထပ် profile/provider သို့ လှည့်ပြောင်းသည်။

State ကို `auth-profiles.json` တွင် သိမ်းဆည်းထားသည်-

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Default များ-

- Billing backoff သည် **၅ နာရီ** မှ စတင်ပြီး billing failure တစ်ကြိမ်စီအလိုက် နှစ်ဆတိုးကာ **၂၄ နာရီ** တွင် အများဆုံး ရပ်တန့်သည်။
- Profile သည် **၂၄ နာရီ** အတွင်း မအောင်မြင်မှု မရှိပါက backoff counter များကို reset လုပ်သည် (configurable)။

## Model fallback

Provider တစ်ခုအတွက် profile အားလုံး မအောင်မြင်ပါက OpenClaw သည်
`agents.defaults.model.fallbacks` ထဲရှိ နောက်ထပ် မော်ဒယ်သို့ ရွှေ့သွားသည်။ ဤအရာသည် auth မအောင်မြင်မှုများ၊ rate limits များနှင့်
profile rotation အားလုံးကို အသုံးပြုပြီးဆုံးသွားသော timeouts များအတွက် သက်ဆိုင်သည် (အခြားအမှားများသည် fallback ကို မတိုးတက်စေပါ)။

Run တစ်ခုကို model override (hooks သို့မဟုတ် CLI) ဖြင့် စတင်ထားပါကလည်း fallback များသည်
ပြင်ဆင်ထားသည့် fallback များကို စမ်းသပ်ပြီးနောက် `agents.defaults.model.primary` တွင် အဆုံးသတ်သည်။

## ဆက်စပ် config များ

အောက်ပါအကြောင်းအရာများအတွက် [Gateway（ဂိတ်ဝေး） configuration](/gateway/configuration) ကို ကြည့်ပါ-

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

မော်ဒယ် ရွေးချယ်မှုနှင့် fallback အကြောင်း အကျယ်တဝင့်ကို [Models](/concepts/models) တွင် ကြည့်ပါ။
