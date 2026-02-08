---
summary: "OpenClaw တွင် API ကီးများ သို့မဟုတ် setup-token ကို အသုံးပြုပြီး Anthropic Claude ကို အသုံးပြုရန်"
read_when:
  - OpenClaw တွင် Anthropic မော်ဒယ်များကို အသုံးပြုလိုပါသည်
  - API ကီးများအစား setup-token ကို အသုံးပြုလိုပါသည်
title: "Anthropic"
x-i18n:
  source_path: providers/anthropic.md
  source_hash: a0e91ae9fc5b67ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:53Z
---

# Anthropic (Claude)

Anthropic သည် **Claude** မော်ဒယ် မိသားစုကို ဖန်တီးထားပြီး API မှတစ်ဆင့် အသုံးပြုခွင့် ပံ့ပိုးပေးပါသည်။
OpenClaw တွင် API ကီး သို့မဟုတ် **setup-token** ဖြင့် အတည်ပြုနိုင်ပါသည်။

## Option A: Anthropic API ကီး

**အကောင်းဆုံး သင့်တော်မှု:** ပုံမှန် API အသုံးပြုမှုနှင့် အသုံးပြုမှုပေါ်မူတည်သည့် ငွေပေးချေမှု။
Anthropic Console တွင် သင့် API ကီးကို ဖန်တီးပါ။

### CLI တပ်ဆင်ခြင်း

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config နမူနာ

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt caching (Anthropic API)

OpenClaw သည် Anthropic ၏ prompt caching အင်္ဂါရပ်ကို ထောက်ပံ့ပါသည်။ ၎င်းသည် **API-only** ဖြစ်ပြီး subscription အတည်ပြုမှုတွင် cache ဆက်တင်များကို မလေးစားပါ။

### Configuration

သင့်မော်ဒယ် config တွင် `cacheRetention` ပါရာမီတာကို အသုံးပြုပါ:

| Value   | Cache ကြာချိန် | ဖော်ပြချက်                                 |
| ------- | -------------- | ------------------------------------------ |
| `none`  | Cache မလုပ်ပါ  | Prompt caching ကို ပိတ်ထားသည်              |
| `short` | ၅ မိနစ်        | API ကီး အတည်ပြုမှုအတွက် မူလသတ်မှတ်ချက်     |
| `long`  | ၁ နာရီ         | တိုးချဲ့ထားသော cache (beta flag လိုအပ်သည်) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Defaults

Anthropic API ကီး အတည်ပြုမှုကို အသုံးပြုသောအခါ OpenClaw သည် Anthropic မော်ဒယ်အားလုံးအတွက် `cacheRetention: "short"` (၅ မိနစ် cache) ကို အလိုအလျောက် အသုံးပြုပါသည်။ Config တွင် `cacheRetention` ကို သတ်မှတ်ခြင်းဖြင့် အစားထိုးနိုင်ပါသည်။

### Legacy parameter

အဟောင်းဖြစ်သော `cacheControlTtl` ပါရာမီတာကို နောက်ကြောင်းကိုက်ညီမှုအတွက် ဆက်လက် ထောက်ပံ့ထားပါသည်:

- `"5m"` သည် `short` သို့ မပ်ပင်ချိတ်ဆက်ပါသည်
- `"1h"` သည် `long` သို့ မပ်ပင်ချိတ်ဆက်ပါသည်

အသစ်ဖြစ်သော `cacheRetention` ပါရာမီတာသို့ ပြောင်းရွှေ့ရန် အကြံပြုပါသည်။

OpenClaw တွင် Anthropic API တောင်းဆိုမှုများအတွက် `extended-cache-ttl-2025-04-11` beta flag ကို ပါဝင်ထားပြီး
provider headers ကို သင် အစားထိုးပါက ( [/gateway/configuration](/gateway/configuration) ကို ကြည့်ပါ) ဆက်လက် ထိန်းသိမ်းထားပါ။

## Option B: Claude setup-token

**အကောင်းဆုံး သင့်တော်မှု:** သင့် Claude subscription ကို အသုံးပြုရန်။

### setup-token ကို ရယူရာနေရာ

Setup-token များကို Anthropic Console မဟုတ်ဘဲ **Claude Code CLI** မှ ဖန်တီးပါသည်။ **မည်သည့် စက်ပေါ်တွင်မဆို** လည်ပတ်နိုင်ပါသည်:

```bash
claude setup-token
```

OpenClaw (wizard: **Anthropic token (paste setup-token)**) ထဲသို့ token ကို ကူးထည့်ပါ၊ သို့မဟုတ် Gateway ဟို့စ် ပေါ်တွင် လည်ပတ်ပါ:

```bash
openclaw models auth setup-token --provider anthropic
```

Token ကို အခြားစက်ပေါ်တွင် ဖန်တီးထားပါက ကူးထည့်ပါ:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI တပ်ဆင်ခြင်း (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Config နမူနာ (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## မှတ်ချက်များ

- `claude setup-token` ဖြင့် setup-token ကို ဖန်တီးပြီး ကူးထည့်ပါ၊ သို့မဟုတ် Gateway ဟို့စ် ပေါ်တွင် `openclaw models auth setup-token` ကို လည်ပတ်ပါ။
- Claude subscription တွင် “OAuth token refresh failed …” ကို တွေ့ပါက setup-token ဖြင့် ပြန်လည် အတည်ပြုပါ။ [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription) ကို ကြည့်ပါ။
- အတည်ပြုမှု အသေးစိတ်နှင့် ပြန်လည်အသုံးပြု စည်းမျဉ်းများကို [/concepts/oauth](/concepts/oauth) တွင် ကြည့်ပါ။

## ပြဿနာဖြေရှင်းခြင်း

**401 အမှားများ / token ရုတ်တရက် မမှန်တော့ခြင်း**

- Claude subscription အတည်ပြုမှုသည် သက်တမ်းကုန်နိုင်သည် သို့မဟုတ် ပြန်လည်ရုပ်သိမ်းခံရနိုင်သည်။ `claude setup-token` ကို ပြန်လည် လည်ပတ်ပြီး
  **Gateway ဟို့စ်** ထဲသို့ ကူးထည့်ပါ။
- Claude CLI login သည် အခြားစက်ပေါ်တွင် ရှိပါက
  Gateway ဟို့စ် ပေါ်တွင် `openclaw models auth paste-token --provider anthropic` ကို အသုံးပြုပါ။

**provider "anthropic" အတွက် API ကီး မတွေ့ပါ**

- Auth သည် **အေးဂျင့်တစ်ခုချင်းစီအလိုက်** ဖြစ်ပါသည်။ အေးဂျင့်အသစ်များသည် အဓိက အေးဂျင့်၏ ကီးများကို အလိုအလျောက် မယူဆောင်ပါ။
- ထိုအေးဂျင့်အတွက် onboarding ကို ပြန်လည် လုပ်ဆောင်ပါ၊ သို့မဟုတ် Gateway ဟို့စ် ထဲသို့ setup-token / API ကီး ကို ကူးထည့်ပြီး `openclaw models status` ဖြင့် အတည်ပြုပါ။

**profile `anthropic:default` အတွက် အထောက်အထား မတွေ့ပါ**

- လက်ရှိ အသက်ဝင်နေသော auth profile ကို သိရန် `openclaw models status` ကို လည်ပတ်ပါ။
- onboarding ကို ပြန်လည် လုပ်ဆောင်ပါ၊ သို့မဟုတ် ထို profile အတွက် setup-token / API ကီး ကို ကူးထည့်ပါ။

**အသုံးပြုနိုင်သော auth profile မရှိပါ (အားလုံး cooldown/unavailable)**

- `openclaw models status --json` တွင် `auth.unusableProfiles` ကို စစ်ဆေးပါ။
- Anthropic profile အသစ်တစ်ခု ထပ်ထည့်ပါ သို့မဟုတ် cooldown ပြီးဆုံးသည်အထိ စောင့်ပါ။

ထပ်မံကြည့်ရှုရန်: [/gateway/troubleshooting](/gateway/troubleshooting) နှင့် [/help/faq](/help/faq)။
