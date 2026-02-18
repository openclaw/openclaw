---
summary: "Zalo Personal ပလပ်ဂင်: zca-cli ဖြင့် QR လော့ဂ်အင် + မက်ဆေ့ချ်ပို့ခြင်း (ပလပ်ဂင် ထည့်သွင်းခြင်း + ချန်နယ် ဖွဲ့စည်းပြင်ဆင်ခြင်း + CLI + ကိရိယာ)"
read_when:
  - OpenClaw တွင် Zalo Personal (အတည်မပြုထားသော) ပံ့ပိုးမှု လိုအပ်သောအခါ
  - zalouser ပလပ်ဂင်ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း သို့မဟုတ် ဖွံ့ဖြိုးရေး လုပ်နေသောအခါ
title: "Zalo Personal ပလပ်ဂင်"
---

# Zalo Personal (ပလပ်ဂင်)

`zca-cli` ကို အသုံးပြုပြီး ပုံမှန် Zalo အသုံးပြုသူအကောင့်ကို အလိုအလျောက်လုပ်ဆောင်စေရန် OpenClaw အတွက် Zalo Personal ပံ့ပိုးမှုကို ပလပ်ဂင်တစ်ခုအနေဖြင့် ပံ့ပိုးထားသည်။

> **Warning:** တရားဝင်မဟုတ်သော automation သည် account suspension/ban ဖြစ်စေနိုင်ပါသည်။ ကိုယ်တိုင်အန္တရာယ်ယူပြီး အသုံးပြုပါ။

## အမည်ပေးခြင်း

Channel id သည် `zalouser` ဖြစ်ပြီး ဤအရာသည် **personal Zalo user account** (unofficial) ကို automation လုပ်နေကြောင်းကို ရှင်းလင်းစေရန် ဖြစ်ပါသည်။ `zalo` ကို အနာဂတ်တွင် ဖြစ်နိုင်သော official Zalo API integration အတွက် reserve ထားပါသည်။

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
