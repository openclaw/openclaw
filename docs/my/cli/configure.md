---
summary: "`openclaw configure` အတွက် CLI ကိုးကားချက် (အပြန်အလှန် ဖွဲ့စည်းပြင်ဆင်ရေး မေးခွန်းများ)"
read_when:
  - အထောက်အထားများ၊ စက်ပစ္စည်းများ သို့မဟုတ် အေးဂျင့် ပုံသေသတ်မှတ်ချက်များကို အပြန်အလှန် ပြင်ဆင်လိုသောအခါ
title: "configure"
---

# `openclaw configure`

အထောက်အထားများ၊ စက်ပစ္စည်းများနှင့် အေးဂျင့် ပုံသေသတ်မှတ်ချက်များကို သတ်မှတ်ရန် အပြန်အလှန် မေးခွန်းများ။

မှတ်ချက်: **မော်ဒယ်** အပိုင်းတွင် ယခုအခါ `agents.defaults.models` ခွင့်ပြုစာရင်း ( `/model` နှင့် မော်ဒယ် ရွေးချယ်မှုတွင် ပြသ되는အရာများ) အတွက် အများရွေးချယ်နိုင်သော ရွေးချယ်မှု ပါဝင်လာပါသည်။

အကြံပြုချက်: subcommand မပါသော `openclaw config` သည် အတူတူသော wizard ကို ဖွင့်ပေးသည်။ non-interactive edits များအတွက် `openclaw config get|set|unset` ကို အသုံးပြုပါ။

ဆက်စပ်အကြောင်းအရာများ:

- Gateway（ဂိတ်ဝေး） ဖွဲ့စည်းပြင်ဆင်ခြင်း ကိုးကားချက်: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

မှတ်ချက်များ:

- Gateway chạy မည့်နေရာကို ရွေးချယ်ခြင်းသည် အမြဲတမ်း `gateway.mode` ကို update လုပ်သည်။ လိုအပ်ချက်များ မရှိပါက အခြား section များမရွေးဘဲ "Continue" ကို ရွေးနိုင်သည်။
- Channel-oriented services (Slack/Discord/Matrix/Microsoft Teams) များသည် setup အတွင်း channel/room allowlists အတွက် prompt လုပ်မည်။ အမည်များ သို့မဟုတ် IDs များကို ထည့်နိုင်ပြီး wizard သည် ဖြစ်နိုင်ပါက အမည်များကို IDs များသို့ resolve လုပ်ပေးသည်။

## ဥပမာများ

```bash
openclaw configure
openclaw configure --section models --section channels
```
