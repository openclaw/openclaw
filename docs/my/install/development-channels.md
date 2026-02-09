---
summary: "Stable၊ beta နှင့် dev ချန်နယ်များ — အဓိပ္ပါယ်၊ ပြောင်းလဲအသုံးပြုနည်း နှင့် တက်ဂ်သတ်မှတ်ခြင်း"
read_when:
  - Stable/beta/dev အကြား ပြောင်းလဲအသုံးပြုလိုသည့်အခါ
  - Prerelease များကို တက်ဂ်သတ်မှတ်ခြင်း သို့မဟုတ် ထုတ်ဝေခြင်း ပြုလုပ်နေသည့်အခါ
title: "ဖွံ့ဖြိုးရေး ချန်နယ်များ"
---

# ဖွံ့ဖြိုးရေး ချန်နယ်များ

နောက်ဆုံး အပ်ဒိတ်: 2026-01-21

OpenClaw သည် အပ်ဒိတ် ချန်နယ် သုံးခုကို ထုတ်ပေးပါသည်—

- **stable**: npm dist-tag `latest`။
- **beta**: npm dist-tag `beta` (စမ်းသပ်နေသော build များ)။
- **dev**: `main` ၏ head ကို လိုက်လံပြောင်းလဲနေသည် (git)။ npm dist-tag: `dev` (publish လုပ်သည့်အခါ)။

ကျွန်ုပ်တို့သည် build များကို **beta** သို့ ပို့ပြီး စမ်းသပ်ကာ၊ ထို့နောက် **စစ်ဆေးပြီးသား build တစ်ခုကို `latest` သို့ မြှင့်တင်** ပါသည်။
ဗားရှင်းနံပါတ်ကို မပြောင်းလဲဘဲ — npm install များအတွက် အမှန်တရားရင်းမြစ်မှာ dist-tag များဖြစ်ပါသည်။

## ချန်နယ်များ ပြောင်းလဲခြင်း

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` သည် ကိုက်ညီသော နောက်ဆုံး tag ကို checkout လုပ်ပါသည် (မကြာခဏ တူညီသော tag ဖြစ်တတ်သည်)။
- `dev` သည် `main` သို့ ပြောင်းလဲပြီး upstream ပေါ်တွင် rebase လုပ်ပါသည်။

npm/pnpm global install:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

ဤလုပ်ဆောင်ချက်သည် သက်ဆိုင်ရာ npm dist-tag (`latest`, `beta`, `dev`) မှတစ်ဆင့် အပ်ဒိတ်လုပ်ပါသည်။

`--channel` ဖြင့် ချန်နယ်ကို **အထူးသတ်မှတ်၍** ပြောင်းလဲသည့်အခါ OpenClaw သည်
install လုပ်နည်းကိုပါ ကိုက်ညီအောင် ချိန်ညှိပါသည်—

- `dev` သည် git checkout တစ်ခုရှိစေရန် သေချာစေပါသည် (မူလသတ်မှတ်ချက်မှာ `~/openclaw` ဖြစ်ပြီး `OPENCLAW_GIT_DIR` ဖြင့် အစားထိုးနိုင်ပါသည်)၊
  ထို checkout ကို အပ်ဒိတ်လုပ်ပြီး ထိုနေရာမှ global CLI ကို ထည့်သွင်းတပ်ဆင်ပါသည်။
- `stable`/`beta` သည် ကိုက်ညီသော dist-tag ကို အသုံးပြု၍ npm မှ တိုက်ရိုက် ထည့်သွင်းတပ်ဆင်ပါသည်။

အကြံပြုချက်: stable နှင့် dev ကို တပြိုင်နက် အသုံးပြုလိုပါက clone နှစ်ခုကို ထားရှိပြီး Gateway ကို stable ကို ညွှန်ပြပါ။

## Plugins နှင့် ချန်နယ်များ

`openclaw update` ဖြင့် ချန်နယ်ပြောင်းလဲသည့်အခါ OpenClaw သည် plugin ရင်းမြစ်များကိုပါ ကိုက်ညီအောင် ချိန်ညှိပါသည်—

- `dev` သည် git checkout ထဲတွင် ပါဝင်လာသော bundled plugins များကို ဦးစားပေးပါသည်။
- `stable` နှင့် `beta` သည် npm ဖြင့် ထည့်သွင်းထားသော plugin package များကို ပြန်လည်ထားရှိပါသည်။

## Tagging အတွက် အကောင်းဆုံး လေ့လာချက်များ

- git checkout များရောက်ရှိစေလိုသော release များကို tag လုပ်ပါ (`vYYYY.M.D` သို့မဟုတ် `vYYYY.M.D-<patch>`)။
- tag များကို မပြောင်းလဲနိုင်အောင် ထားပါ — tag တစ်ခုကို မရွှေ့ပါနှင့်၊ မပြန်အသုံးမပြုပါနှင့်။
- npm dist-tag များသည် npm install များအတွက် အမှန်တရားရင်းမြစ်အဖြစ် ဆက်လက်ရှိနေပါသည်—
  - `latest` → stable
  - `beta` → candidate build
  - `dev` → main snapshot (ရွေးချယ်နိုင်သည်)

## macOS အက်ပ် ရရှိနိုင်မှု

Beta နဲ့ dev builds တွေမှာ macOS app release ကို **မပါဝင်နိုင်** ပါ။ That’s OK:

- git tag နှင့် npm dist-tag ကို ဆက်လက် ထုတ်ဝေနိုင်ပါသည်။
- release notes သို့မဟုတ် changelog တွင် “ဤ beta အတွက် macOS build မရှိပါ” ဟု ဖော်ပြပါ။
