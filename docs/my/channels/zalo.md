---
summary: "Zalo ဘော့ ထောက်ပံ့မှုအခြေအနေ၊ စွမ်းရည်များနှင့် ဖွဲ့စည်းပြင်ဆင်မှု"
read_when:
  - Zalo အင်္ဂါရပ်များ သို့မဟုတ် webhook များအပေါ် အလုပ်လုပ်နေစဉ်
title: "Zalo"
---

# Zalo (Bot API)

Status: experimental. Direct messages only; groups coming soon per Zalo docs.

## Plugin လိုအပ်သည်

Zalo ကို plugin အဖြစ် ပို့ဆောင်ပေးပြီး core install တွင် မပါဝင်ပါ။

- CLI ဖြင့် ထည့်သွင်းရန်: `openclaw plugins install @openclaw/zalo`
- သို့မဟုတ် onboarding အတွင်း **Zalo** ကို ရွေးချယ်ပြီး install prompt ကို အတည်ပြုပါ
- အသေးစိတ်: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Zalo plugin ကို ထည့်သွင်းပါ:
   - Source checkout မှ: `openclaw plugins install ./extensions/zalo`
   - npm မှ (ထုတ်ဝေပြီးပါက): `openclaw plugins install @openclaw/zalo`
   - သို့မဟုတ် onboarding တွင် **Zalo** ကို ရွေးပြီး install prompt ကို အတည်ပြုပါ
2. Token ကို သတ်မှတ်ပါ:
   - Env: `ZALO_BOT_TOKEN=...`
   - သို့မဟုတ် config: `channels.zalo.botToken: "..."`။
3. Gateway ကို ပြန်လည်စတင်ပါ (သို့မဟုတ် onboarding ကို ပြီးဆုံးပါ)။
4. DM ဝင်ရောက်ခွင့်သည် ပုံမှန်အားဖြင့် pairing ဖြစ်ပါသည်; ပထမဆုံး ဆက်သွယ်ချိန်တွင် pairing code ကို အတည်ပြုပါ။

အနည်းဆုံး config:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## What it is

Zalo is a Vietnam-focused messaging app; its Bot API lets the Gateway run a bot for 1:1 conversations.
It is a good fit for support or notifications where you want deterministic routing back to Zalo.

- Gateway ပိုင် Zalo Bot API ချန်နယ်။
- သေချာတိကျသော routing: အဖြေများသည် Zalo သို့သာ ပြန်သွားပြီး model သည် ချန်နယ်ကို မရွေးချယ်ပါ။
- DM များသည် agent ၏ အဓိက session ကို မျှဝေပါသည်။
- အုပ်စုများကို ယခုအချိန်တွင် မပံ့ပိုးသေးပါ (Zalo docs တွင် “coming soon” ဟု ဖော်ပြထားသည်)။

## Setup (fast path)

### 1. Bot token တစ်ခု ဖန်တီးပါ (Zalo Bot Platform)

1. [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) သို့ သွားပြီး sign in ဝင်ပါ။
2. Bot အသစ်တစ်ခု ဖန်တီးပြီး setting များကို ပြင်ဆင်ပါ။
3. Bot token ကို ကူးယူပါ (ဖော်မတ်: `12345689:abc-xyz`)။

### 2) Token ကို ပြင်ဆင်သတ်မှတ်ပါ (env သို့မဟုတ် config)

ဥပမာ:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Env ရွေးချယ်မှု: `ZALO_BOT_TOKEN=...` (default account အတွက်သာ အလုပ်လုပ်ပါသည်)။

Multi-account ပံ့ပိုးမှု: per-account token များနှင့် optional `name` ကို အသုံးပြု၍ `channels.zalo.accounts` ကို အသုံးပြုပါ။

3. Gateway（ဂိတ်ဝေး） ကို ပြန်လည်စတင်ပါ။ Zalo starts when a token is resolved (env or config).
4. DM access defaults to pairing. Approve the code when the bot is first contacted.

## How it works (behavior)

- ဝင်လာသော မက်ဆေ့ချ်များကို media placeholder များပါဝင်သည့် shared channel envelope အဖြစ် normalize လုပ်ပါသည်။
- အဖြေများသည် အမြဲတမ်း အတူတူ Zalo chat သို့ ပြန်လည်လမ်းကြောင်းချပါသည်။
- ပုံမှန်အားဖြင့် long-polling အသုံးပြုပါသည်; webhook mode ကို `channels.zalo.webhookUrl` ဖြင့် ရရှိနိုင်ပါသည်။

## Limits

- ထွက်သွားသော စာသားကို အက္ခရာ 2000 အထိ ခွဲခြမ်းပို့ပါသည် (Zalo API ကန့်သတ်ချက်)။
- Media download/upload များကို `channels.zalo.mediaMaxMb` ဖြင့် ကန့်သတ်ထားပါသည် (default 5)။
- 2000 အက္ခရာ ကန့်သတ်ချက်ကြောင့် streaming သည် အသုံးဝင်မှုနည်းသဖြင့် ပုံမှန်အားဖြင့် ပိတ်ထားပါသည်။

## Access control (DMs)

### DM access

- မူလ: `channels.zalo.dmPolicy = "pairing"`။ မသိသော ပို့သူများသည် pairing code ကို လက်ခံရရှိပြီး အတည်ပြုမပြုလုပ်မချင်း မက်ဆေ့ချ်များကို လျစ်လျူရှုမည် (code များသည် ၁ နာရီအတွင်း သက်တမ်းကုန်ဆုံးသည်)။
- အတည်ပြုရန်:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` သည် numeric user ID များကို လက်ခံပါသည် (username lookup မရနိုင်ပါ)။

## Long-polling vs webhook

- Default: long-polling (public URL မလိုအပ်ပါ)။
- Webhook mode: `channels.zalo.webhookUrl` နှင့် `channels.zalo.webhookSecret` ကို သတ်မှတ်ပါ။
  - Webhook secret သည် အက္ခရာ 8-256 အတွင်း ဖြစ်ရပါမည်။
  - Webhook URL သည် HTTPS ကို အသုံးပြုရပါမည်။
  - Zalo သည် အတည်ပြုရန် `X-Bot-Api-Secret-Token` header ဖြင့် events များကို ပို့ပါသည်။
  - Gateway HTTP သည် webhook request များကို `channels.zalo.webhookPath` တွင် ကိုင်တွယ်ပါသည် (default သည် webhook URL path)။

**မှတ်ချက်:** getUpdates (polling) နှင့် webhook ကို Zalo API docs အရ account တစ်ခုချင်းစီတွင် အပြိုင်မသုံးနိုင်ပါ။

## Supported message types

- **Text messages**: 2000 အက္ခရာ ခွဲခြမ်းပို့ခြင်းဖြင့် အပြည့်အဝ ပံ့ပိုးထားပါသည်။
- **Image messages**: ဝင်လာသော ပုံများကို download လုပ်၍ process လုပ်နိုင်ပြီး `sendPhoto` ဖြင့် ပုံများကို ပို့နိုင်ပါသည်။
- **Stickers**: Logged လုပ်ထားသော်လည်း အပြည့်အဝ မလုပ်ဆောင်ပါ (agent အဖြေ မရှိပါ)။
- **Unsupported types**: Logged လုပ်ပါသည် (ဥပမာ protected user များထံမှ မက်ဆေ့ချ်များ)။

## Capabilities

| Feature                           | Status                                             |
| --------------------------------- | -------------------------------------------------- |
| Direct messages                   | ✅ ပံ့ပိုးထားသည်                                    |
| Groups                            | ❌ မကြာမီ (Zalo docs အရ)         |
| Media (images) | ✅ ပံ့ပိုးထားသည်                                    |
| Reactions                         | ❌ မပံ့ပိုးပါ                                       |
| Threads                           | ❌ မပံ့ပိုးပါ                                       |
| Polls                             | ❌ မပံ့ပိုးပါ                                       |
| Native commands                   | ❌ မပံ့ပိုးပါ                                       |
| Streaming                         | ⚠️ ပိတ်ထားသည် (2000 char limit) |

## Delivery targets (CLI/cron)

- Chat id ကို target အဖြစ် အသုံးပြုပါ။
- ဥပမာ: `openclaw message send --channel zalo --target 123456789 --message "hi"`။

## Troubleshooting

**Bot မဖြေကြားပါက:**

- Token မှန်ကန်မှုကို စစ်ဆေးပါ: `openclaw channels status --probe`
- ပို့သူသည် အတည်ပြုထားခြင်းရှိမရှိ (pairing သို့မဟုတ် allowFrom) ကို စစ်ဆေးပါ
- Gateway logs ကို စစ်ဆေးပါ: `openclaw logs --follow`

**Webhook သည် event များ မရရှိပါက:**

- Webhook URL သည် HTTPS ဖြစ်ကြောင်း သေချာပါစေ
- Secret token သည် အက္ခရာ 8-256 အတွင်း ဖြစ်ကြောင်း အတည်ပြုပါ
- Gateway HTTP endpoint သည် သတ်မှတ်ထားသော path တွင် ရောက်ရှိနိုင်ကြောင်း အတည်ပြုပါ
- getUpdates polling မလည်ပတ်နေကြောင်း စစ်ဆေးပါ (အပြိုင်မသုံးနိုင်ပါ)

## Configuration reference (Zalo)

Configuration အပြည့်အစုံ: [Configuration](/gateway/configuration)

Provider options:

- `channels.zalo.enabled`: ချန်နယ် စတင်မှုကို ဖွင့်/ပိတ်။
- `channels.zalo.botToken`: Zalo Bot Platform မှ bot token။
- `channels.zalo.tokenFile`: ဖိုင်လမ်းကြောင်းမှ token ကို ဖတ်ရန်။
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing)။
- `channels.zalo.allowFrom`: DM allowlist (user IDs). `open` requires `"*"`. The wizard will ask for numeric IDs.
- `channels.zalo.mediaMaxMb`: ဝင်/ထွက် media ကန့်သတ်ချက် (MB, default 5)။
- `channels.zalo.webhookUrl`: webhook mode ကို ဖွင့်ရန် (HTTPS လိုအပ်)။
- `channels.zalo.webhookSecret`: webhook secret (အက္ခရာ 8-256)။
- `channels.zalo.webhookPath`: Gateway HTTP server ပေါ်ရှိ webhook path။
- `channels.zalo.proxy`: API request များအတွက် proxy URL။

Multi-account options:

- `channels.zalo.accounts.<id>.botToken`: per-account token.
- `channels.zalo.accounts.<id>.tokenFile`: per-account token file.
- `channels.zalo.accounts.<id>.name`: display name.
- `channels.zalo.accounts.<id>.enabled`: enable/disable account.
- `channels.zalo.accounts.<id>.dmPolicy`: per-account DM policy.
- `channels.zalo.accounts.<id>.allowFrom`: per-account allowlist.
- `channels.zalo.accounts.<id>.webhookUrl`: per-account webhook URL.
- `channels.zalo.accounts.<id>.webhookSecret`: per-account webhook secret.
- `channels.zalo.accounts.<id>.webhookPath`: per-account webhook path.
- `channels.zalo.accounts.<id>.proxy`: per-account proxy URL.
