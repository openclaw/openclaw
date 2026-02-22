---
summary: "cron နှင့် heartbeat အချိန်ဇယားသတ်မှတ်ခြင်းနှင့် ပို့ဆောင်မှုဆိုင်ရာ ပြဿနာများကို ဖြေရှင်းခြင်း"
read_when:
  - Cron မလုပ်ဆောင်ခဲ့ပါက
  - Cron လုပ်ဆောင်ခဲ့သော်လည်း မက်ဆေ့ချ် မပို့ဆောင်နိုင်ပါက
  - Heartbeat သည် တိတ်ဆိတ်နေသည် သို့မဟုတ် ကျော်သွားသည်ဟု ထင်ရပါက
title: "Automation ပြဿနာဖြေရှင်းခြင်း"
---

# Automation ပြဿနာဖြေရှင်းခြင်း

Scheduler နှင့် ပို့ဆောင်မှုဆိုင်ရာ ပြဿနာများအတွက် ဤစာမျက်နှာကို အသုံးပြုပါ (`cron` + `heartbeat`)။

## Command ladder

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

ထို့နောက် automation စစ်ဆေးမှုများကို လုပ်ဆောင်ပါ–

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron မစတင်လုပ်ဆောင်ခြင်း

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

အဆင်ပြေသော output သည် အောက်ပါအတိုင်း ဖြစ်ပါသည်–

- `cron status` သည် enabled ဖြစ်ပြီး အနာဂတ် `nextWakeAtMs` တစ်ခု ရှိသည်ဟု ပြသသည်။
- Job သည် enabled ဖြစ်ပြီး မှန်ကန်သော schedule/timezone ရှိသည်။
- `cron runs` သည် `ok` သို့မဟုတ် တိတိကျကျ skip လုပ်ရခြင်း အကြောင်းရင်းကို ပြသသည်။

တွေ့ရများသော လက္ခဏာများ–

- `cron: scheduler disabled; jobs will not run automatically` → config/env တွင် cron ကို ပိတ်ထားသည်။
- `cron: timer tick failed` → scheduler tick ပျက်ကျခဲ့သည်; အနီးအနား stack/log context ကို စစ်ဆေးပါ။
- Run output တွင် `reason: not-due` → manual run ကို `--force` မပါဘဲ ခေါ်ထားပြီး job သည် မရောက်သေးသော အချိန်ဖြစ်နေသည်။

## Cron လုပ်ဆောင်ခဲ့သော်လည်း ပို့ဆောင်မှု မရှိခြင်း

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

အဆင်ပြေသော output သည် အောက်ပါအတိုင်း ဖြစ်ပါသည်–

- Run status သည် `ok` ဖြစ်သည်။
- Isolated jobs များအတွက် delivery mode/target ကို သတ်မှတ်ထားသည်။
- Channel probe သည် target channel ချိတ်ဆက်ထားသည်ဟု အစီရင်ခံသည်။

တွေ့ရများသော လက္ခဏာများ–

- Run အောင်မြင်ခဲ့သော်လည်း delivery mode သည် `none` ဖြစ်နေသည် → အပြင်ဘက်သို့ မက်ဆေ့ချ် ပို့ရန် မမျှော်လင့်ပါ။
- Delivery target မရှိခြင်း/မမှန်ကန်ခြင်း (`channel`/`to`) → အတွင်းပိုင်း run အောင်မြင်နိုင်သော်လည်း အပြင်ဘက်သို့ ပို့ဆောင်မှုကို ကျော်သွားနိုင်သည်။
- Channel auth error များ (`unauthorized`, `missing_scope`, `Forbidden`) → channel အထောက်အထားများ/ခွင့်ပြုချက်များကြောင့် ပို့ဆောင်မှု ပိတ်ဆို့ထားသည်။

## Heartbeat ကို ဖိနှိပ်ထားခြင်း သို့မဟုတ် ကျော်သွားခြင်း

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

အဆင်ပြေသော output သည် အောက်ပါအတိုင်း ဖြစ်ပါသည်–

- Heartbeat ကို non-zero interval ဖြင့် enabled လုပ်ထားသည်။
- နောက်ဆုံး heartbeat ရလဒ်သည် `ran` ဖြစ်သည် (သို့မဟုတ် skip လုပ်ရခြင်း အကြောင်းရင်းကို နားလည်ထားသည်)။

တွေ့ရများသော လက္ခဏာများ–

- `heartbeat skipped` နှင့်အတူ `reason=quiet-hours` → `activeHours` အပြင်ဘက်တွင် ရှိနေသည်။
- `requests-in-flight` → main lane အလုပ်များနေသောကြောင့် heartbeat ကို နောက်ကျစေထားသည်။
- `empty-heartbeat-file` → `HEARTBEAT.md` ရှိသော်လည်း လုပ်ဆောင်ရန် အကြောင်းအရာ မရှိပါ။
- `alerts-disabled` → မြင်သာမှု ဆက်တင်များကြောင့် အပြင်ဘက်သို့ heartbeat မက်ဆေ့ချ်များကို ဖိနှိပ်ထားသည်။

## Timezone နှင့် activeHours ဆိုင်ရာ သတိပြုရန်အချက်များ

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

အမြန်စည်းမျဉ်းများ–

- `Config path not found: agents.defaults.userTimezone` ဆိုသည်မှာ key ကို မသတ်မှတ်ထားခြင်းဖြစ်သည်; heartbeat သည် host timezone (သို့မဟုတ် `activeHours.timezone` ကို သတ်မှတ်ထားပါက ထိုအရာ) သို့ ပြန်လည်သုံးစွဲသည်။
- `--tz` မပါသော Cron သည် gateway host timezone ကို အသုံးပြုသည်။
- Heartbeat `activeHours` သည် သတ်မှတ်ထားသော timezone resolution (`user`, `local`, သို့မဟုတ် တိတိကျကျ IANA tz) ကို အသုံးပြုသည်။
- Timezone မပါသော ISO timestamp များကို cron `at` schedule များအတွက် UTC အဖြစ် သတ်မှတ်သည်။

တွေ့ရများသော လက္ခဏာများ–

- Host timezone ပြောင်းလဲပြီးနောက် job များသည် နာရီအချိန် (wall-clock time) မမှန်ကန်စွာ လုပ်ဆောင်ခြင်း။
- `activeHours.timezone` မမှန်ကန်သောကြောင့် သင့်နေ့ဘက်အချိန်တွင် heartbeat အမြဲတမ်း ကျော်သွားခြင်း။

ဆက်စပ်အကြောင်းအရာများ–

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
