---
summary: "`openclaw cron` အတွက် CLI ကိုးကားချက် (နောက်ခံအလုပ်များကို အချိန်ဇယားချ၍ လည်ပတ်စေခြင်း)"
read_when:
  - အချိန်ဇယားထားသော အလုပ်များနှင့် wakeup များကို လိုအပ်သည့်အခါ
  - cron လည်ပတ်မှုနှင့် လော့ဂ်များကို စစ်ဆေးနေစဉ်
title: "cron"
---

# `openclaw cron`

Gateway scheduler အတွက် cron အလုပ်များကို စီမံခန့်ခွဲပါ။

ဆက်စပ်အကြောင်းအရာများ:

- Cron jobs: [Cron jobs](/automation/cron-jobs)

အကြံပြုချက်: အမိန့်များအားလုံးကို ကြည့်ရန် `openclaw cron --help` ကို လည်ပတ်ပါ။

မှတ်ချက်: isolated `cron add` jobs များသည် default အနေဖြင့် `--announce` delivery ကို သုံးသည်။ output ကို internal အဖြစ်သာ ထားရန် `--no-deliver` ကို အသုံးပြုပါ။ `--deliver` သည် `--announce` အတွက် deprecated alias အဖြစ် ဆက်လက် ရှိနေသည်။

မှတ်ချက်: one-shot (`--at`) jobs များသည် success ဖြစ်ပြီးနောက် default အနေဖြင့် delete လုပ်သည်။ ၎င်းတို့ကို ထားရှိရန် `--keep-after-run` ကို အသုံးပြုပါ။

မှတ်ချက်: ထပ်ခါတလဲလဲ အလုပ်များသည် အမှားများ ဆက်တိုက်ဖြစ်ပေါ်ပါက exponential retry backoff (30s → 1m → 5m → 15m → 60m) ကို ယခုအသုံးပြုပါသည်၊ ထို့နောက် နောက်တစ်ကြိမ် အောင်မြင်စွာ လည်ပတ်ပြီးနောက် ပုံမှန် အချိန်ဇယားသို့ ပြန်လည်ရောက်ရှိပါမည်။

## ပုံမှန် ပြင်ဆင်မှုများ

မက်ဆေ့ချ်ကို မပြောင်းလဲဘဲ ပို့ဆောင်မှု ဆက်တင်များကို အပ်ဒိတ်လုပ်ပါ:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

သီးခြားခွဲထားသော အလုပ်တစ်ခုအတွက် ပို့ဆောင်မှုကို ပိတ်ပါ:

```bash
openclaw cron edit <job-id> --no-deliver
```

သတ်မှတ်ထားသော ချန်နယ်တစ်ခုသို့ ကြေညာပါ:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
