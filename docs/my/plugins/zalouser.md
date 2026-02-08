---
summary: "Zalo Personal ပလပ်ဂင်: zca-cli ဖြင့် QR လော့ဂ်အင် + မက်ဆေ့ချ်ပို့ခြင်း (ပလပ်ဂင် ထည့်သွင်းခြင်း + ချန်နယ် ဖွဲ့စည်းပြင်ဆင်ခြင်း + CLI + ကိရိယာ)"
read_when:
  - OpenClaw တွင် Zalo Personal (အတည်မပြုထားသော) ပံ့ပိုးမှု လိုအပ်သောအခါ
  - zalouser ပလပ်ဂင်ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း သို့မဟုတ် ဖွံ့ဖြိုးရေး လုပ်နေသောအခါ
title: "Zalo Personal ပလပ်ဂင်"
x-i18n:
  source_path: plugins/zalouser.md
  source_hash: b29b788b023cd507
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:45Z
---

# Zalo Personal (ပလပ်ဂင်)

`zca-cli` ကို အသုံးပြုပြီး ပုံမှန် Zalo အသုံးပြုသူအကောင့်ကို အလိုအလျောက်လုပ်ဆောင်စေရန် OpenClaw အတွက် Zalo Personal ပံ့ပိုးမှုကို ပလပ်ဂင်တစ်ခုအနေဖြင့် ပံ့ပိုးထားသည်။

> **သတိပေးချက်:** အတည်မပြုထားသော အလိုအလျောက်လုပ်ဆောင်မှုကြောင့် အကောင့် ရပ်ဆိုင်းခြင်း သို့မဟုတ် ပိတ်ပင်ခြင်း ဖြစ်နိုင်ပါသည်။ ကိုယ့်တာဝန်ကိုယ်ယူ၍ အသုံးပြုပါ။

## အမည်ပေးခြင်း

ချန်နယ် id ကို `zalouser` ဟု သတ်မှတ်ထားပြီး **ပုဂ္ဂိုလ်ရေး Zalo အသုံးပြုသူအကောင့်** (အတည်မပြုထားသော) ကို အလိုအလျောက်လုပ်ဆောင်ခြင်းဖြစ်ကြောင်း ရှင်းလင်းစေရန် ဖြစ်သည်။ အနာဂတ်တွင် တရားဝင် Zalo API ပေါင်းစည်းမှု ဖြစ်လာနိုင်သည့်အတွက် `zalo` ကို သိမ်းဆည်းထားပါသည်။

## လည်ပတ်နေရာ

ဤပလပ်ဂင်သည် **Gateway（ဂိတ်ဝေး） လုပ်ငန်းစဉ်အတွင်း** လည်ပတ်ပါသည်။

အဝေးမှ Gateway ကို အသုံးပြုနေပါက **Gateway ကို လည်ပတ်နေသော စက်** ပေါ်တွင် ထည့်သွင်း/ဖွဲ့စည်းပြင်ဆင်ပြီးနောက် Gateway ကို ပြန်လည်စတင်ပါ။

## ထည့်သွင်းတပ်ဆင်ခြင်း

### ရွေးချယ်မှု A: npm မှ ထည့်သွင်းတပ်ဆင်ခြင်း

```bash
openclaw plugins install @openclaw/zalouser
```

ထို့နောက် Gateway ကို ပြန်လည်စတင်ပါ။

### ရွေးချယ်မှု B: ဒေသတွင်း ဖိုလ်ဒါမှ ထည့်သွင်းတပ်ဆင်ခြင်း (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

ထို့နောက် Gateway ကို ပြန်လည်စတင်ပါ။

## ကြိုတင်လိုအပ်ချက်: zca-cli

Gateway စက်တွင် `PATH` ပေါ်ရှိ `zca` ကို ထည့်သွင်းထားရပါမည်။

```bash
zca --version
```

## ဖွဲ့စည်းပြင်ဆင်ခြင်း

ချန်နယ် ဖွဲ့စည်းပြင်ဆင်မှုသည် `plugins.entries.*` မဟုတ်ဘဲ `channels.zalouser` အောက်တွင် ရှိပါသည်။

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## အေးဂျင့် ကိရိယာ

ကိရိယာအမည်: `zalouser`

လုပ်ဆောင်ချက်များ: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
