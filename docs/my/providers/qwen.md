---
summary: "OpenClaw တွင် Qwen OAuth (အခမဲ့အဆင့်) ကို အသုံးပြုရန်"
read_when:
  - OpenClaw နှင့် Qwen ကို အသုံးပြုလိုပါက
  - Qwen Coder အတွက် အခမဲ့အဆင့် OAuth ဝင်ရောက်ခွင့်ကို လိုအပ်ပါက
title: "Qwen"
x-i18n:
  source_path: providers/qwen.md
  source_hash: 88b88e224e2fecbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:46Z
---

# Qwen

Qwen သည် Qwen Coder နှင့် Qwen Vision မော်ဒယ်များအတွက် အခမဲ့အဆင့် OAuth လုပ်ငန်းစဉ်ကို ပံ့ပိုးပေးထားသည်
(တစ်နေ့လျှင် တောင်းဆိုမှု 2,000 ခု၊ Qwen ၏ rate limits အပေါ် မူတည်ပါသည်)။

## Enable the plugin

```bash
openclaw plugins enable qwen-portal-auth
```

ဖွင့်ပြီးနောက် Gateway（ဂိတ်ဝေး）ကို ပြန်လည်စတင်ပါ။

## Authenticate

```bash
openclaw models auth login --provider qwen-portal --set-default
```

ဤလုပ်ဆောင်ချက်သည် Qwen device-code OAuth လုပ်ငန်းစဉ်ကို လည်ပတ်စေပြီး သင့်
`models.json` တွင် provider entry တစ်ခုကို ရေးသွင်းပါမည်
(အမြန်ပြောင်းလဲနိုင်ရန် `qwen` alias တစ်ခုလည်း ပါဝင်သည်)။

## Model IDs

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

မော်ဒယ်များကို ပြောင်းရန်—

```bash
openclaw models set qwen-portal/coder-model
```

## Reuse Qwen Code CLI login

Qwen Code CLI ဖြင့် မိမိအကောင့်သို့ ဝင်ရောက်ပြီးသားဖြစ်ပါက၊ OpenClaw သည် auth store ကို load လုပ်သောအခါ
`~/.qwen/oauth_creds.json` မှ credential များကို sync လုပ်ပေးပါမည်။ သို့သော်
`models.providers.qwen-portal` entry တစ်ခုတော့ လိုအပ်နေသေးပါသည် (အထက်ပါ login command ကို အသုံးပြု၍ ဖန်တီးပါ)။

## Notes

- Token များကို အလိုအလျောက် refresh လုပ်ပေးပါသည်; refresh မအောင်မြင်ပါက သို့မဟုတ် ဝင်ရောက်ခွင့်ကို ရုပ်သိမ်းခံရပါက login command ကို ပြန်လည်လုပ်ဆောင်ပါ။
- ပုံမှန် base URL: `https://portal.qwen.ai/v1` (Qwen မှ မတူညီသော endpoint ကို ပံ့ပိုးပါက
  `models.providers.qwen-portal.baseUrl` ဖြင့် override လုပ်နိုင်ပါသည်)။
- Provider အလုံးစုံဆိုင်ရာ စည်းမျဉ်းများအတွက် [Model providers](/concepts/model-providers) ကို ကြည့်ရှုပါ။
