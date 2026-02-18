---
summary: "တင်းကျပ်သော ဖွဲ့စည်းပြင်ဆင်မှု စစ်ဆေးအတည်ပြုခြင်း + doctor သာ အသုံးပြုသည့် ပြောင်းလဲမှုများ"
read_when:
  - ဖွဲ့စည်းပြင်ဆင်မှု စစ်ဆေးအတည်ပြု အပြုအမူများကို ဒီဇိုင်းဆွဲခြင်း သို့မဟုတ် အကောင်အထည်ဖော်ခြင်းလုပ်ဆောင်နေချိန်
  - ဖွဲ့စည်းပြင်ဆင်မှု ပြောင်းလဲမှုများ သို့မဟုတ် doctor လုပ်ငန်းစဉ်များပေါ်တွင် လုပ်ဆောင်နေချိန်
  - plugin ဖွဲ့စည်းပြင်ဆင်မှု schema များ သို့မဟုတ် plugin load gating ကို ကိုင်တွယ်နေချိန်
title: "တင်းကျပ်သော ဖွဲ့စည်းပြင်ဆင်မှု စစ်ဆေးအတည်ပြုခြင်း"
---

# တင်းကျပ်သော ဖွဲ့စည်းပြင်ဆင်မှု စစ်ဆေးအတည်ပြုခြင်း (doctor သာ အသုံးပြုသည့် ပြောင်းလဲမှုများ)

## ရည်မှန်းချက်များ

- **မသိရှိသော config key များကို နေရာတိုင်းတွင် ပယ်ချရန်** (root + nested)။
- **schema မရှိသော plugin config များကို ပယ်ချရန်**; အဆိုပါ plugin ကို မ load လုပ်ပါ။
- **load အချိန်တွင် legacy auto-migration ကို ဖယ်ရှားရန်**; migrations များကို doctor ဖြင့်သာ လည်ပတ်စေပါ။
- **startup တွင် doctor (dry-run) ကို အလိုအလျောက် လည်ပတ်စေရန်**; မမှန်ကန်ပါက diagnostic မဟုတ်သော command များကို ပိတ်ပင်ပါ။

## မရည်မှန်းသောအချက်များ

- load အချိန်တွင် backward compatibility (legacy key များကို auto-migrate မလုပ်ပါ)။
- မသိရှိသော key များကို အသံမထွက်ဘဲ ဖယ်ရှားခြင်း။

## တင်းကျပ်သော စစ်ဆေးအတည်ပြု စည်းမျဉ်းများ

- Config သည် အဆင့်တိုင်းတွင် schema နှင့် အပြည့်အဝ ကိုက်ညီရပါမည်။
- မသိရှိသော key များသည် စစ်ဆေးအတည်ပြု အမှားများဖြစ်သည် (root သို့မဟုတ် nested တွင် passthrough မရှိပါ)။
- `plugins.entries.<id>``.config` ကို plugin ၏ schema အရ စစ်ဆေးအတည်ပြုရပါမည်။
  - plugin တွင် schema မရှိပါက **plugin load ကို ပယ်ချပြီး** ရှင်းလင်းသော အမှားကို ပြသပါ။
- မသိသော `channels.<id>`` key` များကို plugin manifest မှ channel id ကို ကြေညာထားခြင်း မရှိပါက အမှားအဖြစ် သတ်မှတ်ပါသည်။
- Plugin manifest များ (`openclaw.plugin.json`) ကို plugin အားလုံးအတွက် လိုအပ်ပါသည်။

## Plugin schema အကောင်အထည်ဖော်ခြင်း

- Plugin တစ်ခုချင်းစီသည် ၎င်း၏ config အတွက် တင်းကျပ်သော JSON Schema ကို (manifest အတွင်းတွင်) ပံ့ပိုးရပါမည်။
- Plugin load လုပ်ငန်းစဉ်:
  1. Plugin manifest + schema ကို ဖြေရှင်းပါ (`openclaw.plugin.json`)။
  2. Config ကို schema နှင့် နှိုင်းယှဉ်၍ စစ်ဆေးအတည်ပြုပါ။
  3. Schema မရှိပါက သို့မဟုတ် config မမှန်ကန်ပါက: plugin load ကို ပိတ်ပင်ပြီး အမှားကို မှတ်တမ်းတင်ပါ။
- အမှားစာတွင် ပါဝင်ရမည့် အချက်များ:
  - Plugin id
  - အကြောင်းရင်း (schema မရှိခြင်း / config မမှန်ကန်ခြင်း)
  - စစ်ဆေးအတည်ပြု မအောင်မြင်ခဲ့သော လမ်းကြောင်း(များ)
- Disabled ဖြစ်သော plugin များသည် ၎င်းတို့၏ config ကို ထိန်းသိမ်းထားသော်လည်း Doctor + logs မှ သတိပေးချက်ကို ပြသပါသည်။

## Doctor လုပ်ငန်းစဉ်

- Config ကို load လုပ်တိုင်း Doctor ကို **အမြဲ** လည်ပတ်စေပါသည် (မူလအားဖြင့် dry-run)။
- Config မမှန်ကန်ပါက:
  - အကျဉ်းချုပ် + လုပ်ဆောင်နိုင်သော အမှားများကို ပုံနှိပ်ပြပါ။
  - လမ်းညွှန်ချက် ပေးပါ: `openclaw doctor --fix`။
- `openclaw doctor --fix`:
  - Migrations များကို အကောင်အထည်ဖော်ပါသည်။
  - မသိရှိသော key များကို ဖယ်ရှားပါသည်။
  - ပြင်ဆင်ပြီးသား config ကို ရေးသားသိမ်းဆည်းပါသည်။

## Command gating (config မမှန်ကန်သောအချိန်)

ခွင့်ပြုသည် (diagnostic-only):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

အခြားအရာအားလုံးကို အောက်ပါ စာသားဖြင့် hard-fail ဖြစ်ရပါမည် — “Config invalid. `openclaw doctor --fix` ကို အလုပ်လုပ်ပါ။”

## Error UX ပုံစံ

- အကျဉ်းချုပ် ခေါင်းစဉ် တစ်ခုတည်း။
- အုပ်စုလိုက် အပိုင်းများ:
  - မသိရှိသော key များ (လမ်းကြောင်းအပြည့်အစုံ)
  - Legacy key များ / လိုအပ်သော migrations
  - Plugin load မအောင်မြင်မှုများ (plugin id + အကြောင်းရင်း + လမ်းကြောင်း)

## အကောင်အထည်ဖော်ရန် ထိတွေ့ရမည့် အချက်များ

- `src/config/zod-schema.ts`: root passthrough ကို ဖယ်ရှားပြီး နေရာတိုင်းတွင် strict objects အသုံးပြုပါ။
- `src/config/zod-schema.providers.ts`: strict channel schema များကို သေချာစေရန်။
- `src/config/validation.ts`: မသိရှိသော key များတွင် ပျက်ကွက်စေပြီး legacy migrations များကို မအသုံးပြုပါ။
- `src/config/io.ts`: legacy auto-migrations များကို ဖယ်ရှားပြီး doctor dry-run ကို အမြဲ လည်ပတ်စေပါ။
- `src/config/legacy*.ts`: အသုံးပြုမှုကို doctor သာဖြင့် သုံးရန် ပြောင်းရွှေ့ပါ။
- `src/plugins/*`: schema registry + gating ကို ထည့်သွင်းပါ။
- `src/cli` တွင် CLI command gating ကို အကောင်အထည်ဖော်ပါ။

## စမ်းသပ်မှုများ

- မသိရှိသော key များကို ပယ်ချခြင်း (root + nested)။
- Plugin တွင် schema မရှိခြင်း → plugin load ကို ရှင်းလင်းသော အမှားဖြင့် ပိတ်ပင်ခြင်း။
- Config မမှန်ကန်ပါက → Gateway（ဂိတ်ဝေး） startup ကို diagnostic command များမှ လွဲ၍ ပိတ်ပင်ခြင်း။
- Doctor dry-run ကို အလိုအလျောက် လည်ပတ်ခြင်း; `doctor --fix` သည် ပြင်ဆင်ပြီးသား config ကို ရေးသားသိမ်းဆည်းပါသည်။
