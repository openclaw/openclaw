---
summary: "`openclaw onboard` အတွက် CLI ကိုးကားချက် (အပြန်အလှန် ဆက်သွယ်သည့် onboarding wizard)"
read_when:
  - Gateway၊ workspace၊ auth၊ ချန်နယ်များနှင့် Skills များကို လမ်းညွှန်ပေးထားသည့် တပ်ဆင်ခြင်း လိုအပ်သောအခါ
title: "onboard"
---

# `openclaw onboard`

အပြန်အလှန် ဆက်သွယ်သည့် onboarding wizard (local သို့မဟုတ် remote Gateway တပ်ဆင်ခြင်း)။

## ဆက်စပ် လမ်းညွှန်များ

- CLI onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)
- CLI onboarding ကိုးကားချက်: [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI automation: [CLI Automation](/start/wizard-cli-automation)
- macOS onboarding: [Onboarding (macOS App)](/start/onboarding)

## ဥပမာများ

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

လုပ်ဆောင်မှု လမ်းကြောင်း မှတ်ချက်များ—

- `quickstart`: မေးခွန်းအနည်းဆုံးသာ မေးပြီး gateway token ကို အလိုအလျောက် ဖန်တီးပေးသည်။
- `manual`: port/bind/auth အတွက် မေးခွန်းများ အပြည့်အစုံ ( `advanced` ၏ alias)။
- ပထမဆုံး ချတ်ကို အမြန်ဆုံး စတင်နိုင်ခြင်း: `openclaw dashboard` (Control UI၊ ချန်နယ် တပ်ဆင်ခြင်း မလိုအပ်)။

## နောက်တစ်ဆင့် အသုံးများသော အမိန့်များ

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` သည် non-interactive mode ကို အလိုအလျောက် မဆိုလိုပါ။ Script များအတွက် `--non-interactive` ကို အသုံးပြုပါ။
</Note>
