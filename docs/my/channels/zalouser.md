---
summary: "zca-cli (QR လော့ဂ်အင်) ဖြင့် Zalo ကိုယ်ရေးကိုယ်တာအကောင့် ပံ့ပိုးမှု၊ စွမ်းဆောင်ရည်များနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း"
read_when:
  - OpenClaw အတွက် Zalo ကိုယ်ရေးကိုယ်တာကို တပ်ဆင်နေချိန်
  - Zalo ကိုယ်ရေးကိုယ်တာ လော့ဂ်အင် သို့မဟုတ် မက်ဆေ့ချ် လမ်းကြောင်းကို ပြဿနာရှာဖွေ ဖြေရှင်းနေချိန်
title: "Zalo ကိုယ်ရေးကိုယ်တာ"
---

# Zalo ကိုယ်ရေးကိုယ်တာ (တရားဝင်မဟုတ်)

Status: experimental. This integration automates a **personal Zalo account** via `zca-cli`.

> **Warning:** This is an unofficial integration and may result in account suspension/ban. Use at your own risk.

## လိုအပ်သော Plugin

Zalo ကိုယ်ရေးကိုယ်တာသည် plugin အဖြစ် ပေးပို့ထားပြီး core install ထဲတွင် မပါဝင်ပါ။

- CLI ဖြင့် ထည့်သွင်းရန်: `openclaw plugins install @openclaw/zalouser`
- သို့မဟုတ် source checkout မှ: `openclaw plugins install ./extensions/zalouser`
- အသေးစိတ်: [Plugins](/tools/plugin)

## ကြိုတင်လိုအပ်ချက်: zca-cli

Gateway စက်တွင် `zca` binary ကို `PATH` တွင် ရရှိနိုင်ရပါမည်။

- စစ်ဆေးရန်: `zca --version`
- မရှိပါက zca-cli ကို ထည့်သွင်းပါ (`extensions/zalouser/README.md` သို့မဟုတ် upstream zca-cli docs ကို ကြည့်ပါ)။

## အမြန်တပ်ဆင်ခြင်း (အစပြုသူ)

1. Plugin ကို ထည့်သွင်းပါ (အထက်တွင် ဖော်ပြထားသည်)။
2. လော့ဂ်အင် (QR၊ Gateway စက်ပေါ်တွင်):
   - `openclaw channels login --channel zalouser`
   - Terminal တွင် ပြထားသော QR code ကို Zalo မိုဘိုင်းအက်ပ်ဖြင့် စကန်ဖတ်ပါ။
3. Channel ကို ဖွင့်ပါ:

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

4. Gateway ကို ပြန်လည်စတင်ပါ (သို့မဟုတ် onboarding ကို ပြီးဆုံးပါ)။
5. DM ဝင်ရောက်ခွင့်သည် မူလအားဖြင့် pairing ကို အသုံးပြုသည်။ ပထမဆုံး ဆက်သွယ်ချိန်တွင် pairing code ကို အတည်ပြုပါ။

## ၎င်းသည် မည်သို့သောအရာလဲ

- ဝင်လာသော မက်ဆေ့ချ်များကို လက်ခံရန် `zca listen` ကို အသုံးပြုသည်။
- ပြန်ကြားချက်များ (စာသား/မီဒီယာ/လင့်ခ်) ပို့ရန် `zca msg ...` ကို အသုံးပြုသည်။
- Zalo Bot API မရရှိနိုင်သော “ကိုယ်ရေးကိုယ်တာအကောင့်” အသုံးပြုမှုများအတွက် ဒီဇိုင်းပြုလုပ်ထားသည်။

## အမည်ပေးခြင်း

Channel id is `zalouser` to make it explicit this automates a **personal Zalo user account** (unofficial). We keep `zalo` reserved for a potential future official Zalo API integration.

## ID များကို ရှာဖွေရန် (directory)

Directory CLI ကို အသုံးပြု၍ peer/group များနှင့် ၎င်းတို့၏ ID များကို ရှာဖွေပါ:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## ကန့်သတ်ချက်များ

- ထွက်သွားသော စာသားကို ~2000 အက္ခရာအထိ ခွဲပို့သည် (Zalo client ကန့်သတ်ချက်)။
- Streaming ကို မူလအားဖြင့် ပိတ်ထားသည်။

## ဝင်ရောက်ခွင့်ထိန်းချုပ်မှု (DMs)

`channels.zalouser.dmPolicy` supports: `pairing | allowlist | open | disabled` (default: `pairing`).
`channels.zalouser.allowFrom` accepts user IDs or names. The wizard resolves names to IDs via `zca friend find` when available.

အတည်ပြုရန်:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## အုပ်စု ဝင်ရောက်ခွင့် (ရွေးချယ်နိုင်)

- Default: `channels.zalouser.groupPolicy = "open"` (groups allowed). Use `channels.defaults.groupPolicy` to override the default when unset.
- Allowlist ဖြင့် ကန့်သတ်ရန်:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (ကီးများမှာ အုပ်စု ID များ သို့မဟုတ် အမည်များ ဖြစ်သည်)
- အုပ်စုအားလုံးကို ပိတ်ရန်: `channels.zalouser.groupPolicy = "disabled"`။
- Configure wizard သည် အုပ်စု allowlist များကို မေးမြန်းနိုင်သည်။
- စတင်ချိန်တွင် OpenClaw သည် allowlist ထဲရှိ အုပ်စု/အသုံးပြုသူ အမည်များကို ID များအဖြစ် ဖြေရှင်းပြီး mapping ကို မှတ်တမ်းတင်သည်။ မဖြေရှင်းနိုင်သော အချက်အလက်များကို ရိုက်ထည့်ထားသည့်အတိုင်း ထားရှိသည်။

ဥပမာ:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## အကောင့် အများအပြား

Accounts map to zca profiles. ဥပမာ —

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## ပြဿနာဖြေရှင်းခြင်း

**`zca` ကို မတွေ့ပါက:**

- zca-cli ကို ထည့်သွင်းပြီး Gateway process အတွက် `PATH` တွင် ပါဝင်ကြောင်း သေချာစေပါ။

**လော့ဂ်အင် မတည်မြဲပါက:**

- `openclaw channels status --probe`
- ပြန်လည် လော့ဂ်အင်လုပ်ရန်: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
