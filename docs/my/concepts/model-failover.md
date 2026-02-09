---
summary: "OpenClaw သည် auth profile များကို မည်သို့ လှည့်ပြောင်းအသုံးပြုပြီး မော်ဒယ်များအကြား fallback ပြုလုပ်သနည်း"
read_when:
  - auth profile လှည့်ပြောင်းမှု၊ cooldown များ သို့မဟုတ် မော်ဒယ် fallback အပြုအမူများကို စစ်ဆေးခွဲခြမ်းစိတ်ဖြာနေသည့်အခါ
  - auth profile များ သို့မဟုတ် မော်ဒယ်များအတွက် failover စည်းမျဉ်းများကို အပ်ဒိတ်လုပ်နေသည့်အခါ
title: "မော်ဒယ် Failover"
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
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` for some providers)

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

OpenClaw **pins the chosen auth profile per session** to keep provider caches warm.
It does **not** rotate on every request. The pinned profile is reused until:

- session ကို reset လုပ်သောအခါ (`/new` / `/reset`)
- compaction ပြီးစီးပြီး (compaction count တိုးလာသောအခါ)
- profile သည် cooldown/disabled ဖြစ်သွားသောအခါ

`/model …@<profileId>` ဖြင့် လက်ဖြင့် ရွေးချယ်ခြင်းသည် ထို session အတွက် **user override** ကို သတ်မှတ်ပေးပြီး
session အသစ် မစတင်မချင်း auto‑rotate မလုပ်ပါ။

Auto‑pinned profiles (selected by the session router) are treated as a **preference**:
they are tried first, but OpenClaw may rotate to another profile on rate limits/timeouts.
User‑pinned profiles stay locked to that profile; if it fails and model fallbacks
are configured, OpenClaw moves to the next model instead of switching profiles.

### OAuth “ပျောက်သွားသလို” မြင်ရနိုင်သည့် အကြောင်းရင်း

If you have both an OAuth profile and an API key profile for the same provider, round‑robin can switch between them across messages unless pinned. To force a single profile:

- `auth.order[provider] = ["provider:profileId"]` ဖြင့် pin လုပ်ပါ၊ သို့မဟုတ်
- သင့် UI/chat surface က ထောက်ပံ့ပါက profile override ပါသော `/model …` ဖြင့် per‑session override ကို အသုံးပြုပါ။

## Cooldowns

When a profile fails due to auth/rate‑limit errors (or a timeout that looks
like rate limiting), OpenClaw marks it in cooldown and moves to the next profile.
Format/invalid‑request errors (for example Cloud Code Assist tool call ID
validation failures) are treated as failover‑worthy and use the same cooldowns.

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

Billing/credit failures (for example “insufficient credits” / “credit balance too low”) are treated as failover‑worthy, but they’re usually not transient. Instead of a short cooldown, OpenClaw marks the profile as **disabled** (with a longer backoff) and rotates to the next profile/provider.

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

If all profiles for a provider fail, OpenClaw moves to the next model in
`agents.defaults.model.fallbacks`. This applies to auth failures, rate limits, and
timeouts that exhausted profile rotation (other errors do not advance fallback).

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
