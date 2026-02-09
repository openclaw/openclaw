---
summary: "အလိုအလျောက်လုပ်ဆောင်မှုအတွက် heartbeat နှင့် cron jobs အကြား ရွေးချယ်ရာတွင် လမ်းညွှန်ချက်"
read_when:
  - ထပ်ခါတလဲလဲ လုပ်ဆောင်ရမည့် တာဝန်များကို မည်သို့ အချိန်ဇယားချရမည်ကို ဆုံးဖြတ်နေစဉ်
  - နောက်ခံ စောင့်ကြည့်မှု သို့မဟုတ် အသိပေးချက်များကို တပ်ဆင်နေစဉ်
  - ကာလပတ်လုံး စစ်ဆေးမှုများအတွက် token အသုံးပြုမှုကို ထိရောက်အောင် ပြုလုပ်လိုသောအခါ
title: "Cron နှင့် Heartbeat"
---

# Cron နှင့် Heartbeat: တစ်ခုချင်းစီကို မည်သည့်အချိန် အသုံးပြုရမည်နည်း

31. Heartbeat နှင့် cron job နှစ်မျိုးစလုံးသည် schedule အလိုက် task များကို လုပ်ဆောင်နိုင်သည်။ 32. ဤလမ်းညွှန်သည် သင့် use case အတွက် မှန်ကန်သော mechanism ကို ရွေးချယ်ရန် ကူညီပေးသည်။

## အမြန် ဆုံးဖြတ်ရန် လမ်းညွှန်

| အသုံးပြုမှုအခြေအနေ                                     | အကြံပြုချက်                            | အကြောင်းရင်း                                                                |
| ------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------- |
| inbox ကို မိနစ် 30 တစ်ကြိမ် စစ်ဆေးရန်                  | Heartbeat                              | အခြား စစ်ဆေးမှုများနှင့် အစုလိုက်လုပ်ဆောင်နိုင်ပြီး context ကို နားလည်နိုင် |
| မနက် 9 နာရီတိတိ နေ့စဉ် အစီရင်ခံစာ ပို့ရန်              | Cron (isolated)     | အချိန်တိကျမှု လိုအပ်သည်                                                     |
| လာမည့် အဖြစ်အပျက်များအတွက် ပြက္ခဒိန်ကို စောင့်ကြည့်ရန် | Heartbeat                              | ကာလပတ်လုံး အသိပညာရရှိရန် သဘာဝကျစွာ ကိုက်ညီ                                  |
| အပတ်စဉ် အနက်ရှိုင်း ခွဲခြမ်းစိတ်ဖြာမှု လုပ်ရန်         | Cron (isolated)     | သီးသန့် တာဝန်ဖြစ်ပြီး မတူညီသော မော်ဒယ် အသုံးပြုနိုင်                        |
| မိနစ် 20 အကြာ သတိပေးရန်                                | Cron (main, `--at`) | တစ်ကြိမ်တည်းနှင့် အချိန်တိကျမှု လိုအပ်                                      |
| နောက်ခံ project အခြေအနေ စစ်ဆေးမှု                      | Heartbeat                              | ရှိပြီးသား စက်ဝန်းပေါ်တွင် တွဲဖက်လုပ်ဆောင်နိုင်                             |

## Heartbeat: ကာလပတ်လုံး အသိပညာရရှိမှု

33. Heartbeat များသည် **main session** အတွင်း ပုံမှန်အချိန်အလိုက် (default: 30 မိနစ်) လည်ပတ်သည်။ 34. ၎င်းတို့ကို agent က အခြေအနေများကို စစ်ဆေးပြီး အရေးကြီးသည့် အရာများကို ထုတ်ဖော်ပြသရန် ဒီဇိုင်းလုပ်ထားသည်။

### Heartbeat ကို အသုံးပြုသင့်သောအချိန်များ

- **ကာလပတ်လုံး စစ်ဆေးမှုများ အများအပြား**: inbox၊ ပြက္ခဒိန်၊ မိုးလေဝသ၊ အသိပေးချက်များ၊ project အခြေအနေ စသည်တို့ကို စစ်ဆေးရန် cron job 5 ခု ခွဲထားခြင်းအစား heartbeat တစ်ခုတည်းဖြင့် အစုလိုက် လုပ်ဆောင်နိုင်ပါသည်။
- **Context ကို နားလည်သော ဆုံးဖြတ်ချက်များ**: အေးဂျင့်သည် main session context အပြည့်အစုံ ရရှိထားသဖြင့် ဘာအရေးကြီးပြီး ဘာကို စောင့်နိုင်သည်ကို သေချာဆုံးဖြတ်နိုင်ပါသည်။
- **စကားဝိုင်း ဆက်လက်တည်ရှိမှု**: Heartbeat run များသည် session တစ်ခုတည်းကို မျှဝေသဖြင့် မကြာသေးမီ စကားဝိုင်းများကို မှတ်မိပြီး သဘာဝကျစွာ ဆက်လက်လုပ်ဆောင်နိုင်ပါသည်။
- **အလုပ်ဝင်ရောက်မှု နည်းသော စောင့်ကြည့်မှု**: Heartbeat တစ်ခုသည် polling task အသေးများ အများအပြားကို အစားထိုးနိုင်ပါသည်။

### Heartbeat ၏ အားသာချက်များ

- **စစ်ဆေးမှုများ အစုလိုက်လုပ်ဆောင်နိုင်ခြင်း**: အေးဂျင့် တစ်ကြိမ် လှည့်ပတ်ခြင်းဖြင့် inbox၊ ပြက္ခဒိန်၊ အသိပေးချက်များကို တစ်ခါတည်း ပြန်လည်သုံးသပ်နိုင်ပါသည်။
- **API ခေါ်ဆိုမှုများ လျော့နည်းစေခြင်း**: Heartbeat တစ်ခုသည် သီးသန့် cron jobs 5 ခုထက် ကုန်ကျစရိတ် နည်းပါသည်။
- **Context-aware**: သင် လုပ်ဆောင်နေသော အလုပ်များကို သိရှိထားပြီး ဦးစားပေးနိုင်ပါသည်။
- **Smart suppression**: အာရုံစိုက်ရန် မလိုအပ်ပါက အေးဂျင့်သည် `HEARTBEAT_OK` ဖြင့် ပြန်ကြားပြီး မည်သည့် မက်ဆေ့ချ်မျှ မပို့ပါ။
- **သဘာဝကျသော အချိန်ညှိမှု**: Queue load အပေါ် မူတည်၍ အနည်းငယ် လှိုင်းလျားနိုင်သော်လည်း စောင့်ကြည့်မှုအများစုအတွက် ပြဿနာမရှိပါ။

### Heartbeat ဥပမာ: HEARTBEAT.md စစ်ဆေးစာရင်း

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

အေးဂျင့်သည် heartbeat တိုင်းတွင် ဤဖိုင်ကို ဖတ်ပြီး အရာအားလုံးကို တစ်ကြိမ်တည်း လုပ်ဆောင်ပါသည်။

### Heartbeat ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

အသေးစိတ် ဖွဲ့စည်းပြင်ဆင်မှုအတွက် [Heartbeat](/gateway/heartbeat) ကို ကြည့်ပါ။

## Cron: အချိန်တိကျစွာ အချိန်ဇယားချခြင်း

Cron jobs များသည် **အချိန်တိကျစွာ** လုပ်ဆောင်ပြီး main context ကို မထိခိုက်စေရန် isolated sessions အတွင်း လုပ်ဆောင်နိုင်ပါသည်။

### Cron ကို အသုံးပြုသင့်သောအချိန်များ

- **အချိန်တိကျမှု လိုအပ်သောအခါ**: “တနင်္လာနေ့တိုင်း မနက် 9:00 နာရီမှာ ပို့ပါ” ( “9 နာရီလောက်” မဟုတ်ပါ)။
- **သီးသန့် တာဝန်များ**: စကားဝိုင်း context မလိုအပ်သော တာဝန်များ။
- **မတူညီသော မော်ဒယ်/စဉ်းစားမှု**: ပိုမိုအားကောင်းသော မော်ဒယ် လိုအပ်သည့် အလေးအနက် ခွဲခြမ်းစိတ်ဖြာမှုများ။
- **တစ်ကြိမ်တည်း သတိပေးချက်များ**: “မိနစ် 20 အကြာ သတိပေးပါ” ကို `--at` ဖြင့်။
- **ဆူညံသော/မကြာခဏ လုပ်ဆောင်ရသော တာဝန်များ**: main session history ကို ရှုပ်ထွေးစေမည့် အလုပ်များ။
- **ပြင်ပ trigger များ**: အေးဂျင့် အလုပ်မလုပ်နေချိန်တွင်ပါ လွတ်လပ်စွာ လုပ်ဆောင်ရမည့် တာဝန်များ။

### Cron ၏ အားသာချက်များ

- **အချိန်တိကျမှု**: timezone ပံ့ပိုးမှုပါရှိသော field 5 ခု cron expression များ။
- **Session ခွဲခြားမှု**: `cron:<jobId>` အတွင်း လုပ်ဆောင်ပြီး main history ကို မညစ်ညမ်းစေပါ။
- **Model override**: job တစ်ခုချင်းစီအလိုက် စျေးသက်သာသော သို့မဟုတ် ပိုအားကောင်းသော မော်ဒယ်ကို အသုံးပြုနိုင်ပါသည်။
- **ပို့ဆောင်မှု ထိန်းချုပ်နိုင်ခြင်း**: isolated jobs များသည် ပုံမှန်အားဖြင့် `announce` (အကျဉ်းချုပ်) ကို အသုံးပြုပါသည်၊ လိုအပ်ပါက `none` ကို ရွေးချယ်နိုင်ပါသည်။
- **ချက်ချင်း ပို့ဆောင်ခြင်း**: announce mode သည် heartbeat ကို မစောင့်ဘဲ တိုက်ရိုက် ပို့ပါသည်။
- **အေးဂျင့် context မလိုအပ်ခြင်း**: main session မလှုပ်ရှားသော်လည်း သို့မဟုတ် compact လုပ်ထားသော်လည်း run လုပ်ပါသည်။
- **တစ်ကြိမ်တည်း ပံ့ပိုးမှု**: တိကျသော အနာဂတ် timestamp များအတွက် `--at`။

### Cron ဥပမာ: နေ့စဉ် မနက်ခင်း briefing

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

ဤအလုပ်သည် နယူးယောက် အချိန် မနက် 7:00 နာရီတိတိတွင် run လုပ်ပြီး အရည်အသွေးအတွက် Opus ကို အသုံးပြုကာ WhatsApp သို့ အကျဉ်းချုပ်ကို တိုက်ရိုက် ကြေညာပါသည်။

### Cron ဥပမာ: တစ်ကြိမ်တည်း သတိပေးချက်

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

CLI reference အပြည့်အစုံအတွက် [Cron jobs](/automation/cron-jobs) ကို ကြည့်ပါ။

## ဆုံးဖြတ်ချက် Flowchart

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## နှစ်မျိုးလုံး ပေါင်းစပ်အသုံးပြုခြင်း

အထိရောက်ဆုံး setup သည် **နှစ်မျိုးလုံး** ကို အသုံးပြုခြင်းဖြစ်ပါသည်။

1. **Heartbeat** သည် inbox၊ ပြက္ခဒိန်၊ အသိပေးချက်များကို မိနစ် 30 တစ်ကြိမ် အစုလိုက် စောင့်ကြည့်ပါသည်။
2. **Cron** သည် နေ့စဉ် အစီရင်ခံစာများ၊ အပတ်စဉ် ပြန်လည်သုံးသပ်မှုများနှင့် တစ်ကြိမ်တည်း သတိပေးချက်များကဲ့သို့ အချိန်တိကျမှု လိုအပ်သော အလုပ်များကို ကိုင်တွယ်ပါသည်။

### ဥပမာ: ထိရောက်သော automation setup

**HEARTBEAT.md** (မိနစ် 30 တစ်ကြိမ် စစ်ဆေး):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron jobs** (အချိန်တိကျ):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: အတည်ပြုချက်များပါသော သတ်မှတ်ထားသည့် workflow များ

35. Lobster သည် တိကျသေချာသော execution နှင့် ရှင်းလင်းသော approval များ လိုအပ်သော **multi-step tool pipeline** များအတွက် workflow runtime ဖြစ်သည်။
36. Task သည် agent turn တစ်ကြိမ်ထက် ပိုကြီးပြီး လူသား checkpoint များပါသော ပြန်လည်စတင်နိုင်သည့် workflow ကို လိုချင်သောအခါ ၎င်းကို အသုံးပြုပါ။

### Lobster သင့်တော်သော အခြေအနေများ

- **အဆင့်များစွာ အလိုအလျောက်လုပ်ဆောင်မှု**: တစ်ကြိမ်တည်း prompt မဟုတ်ဘဲ tool calls အစဉ်လိုက် pipeline တစ်ခု လိုအပ်သောအခါ။
- **အတည်ပြုချက် တံခါးများ**: side effects များကို သင် အတည်ပြုသည်အထိ ရပ်နားပြီး ထို့နောက် ဆက်လက်လုပ်ဆောင်လိုသောအခါ။
- **ပြန်လည်စတင်နိုင်သော run များ**: အစောပိုင်း အဆင့်များကို ပြန်မလုပ်ဘဲ ရပ်နားထားသော workflow ကို ဆက်လုပ်လိုသောအခါ။

### Heartbeat နှင့် Cron နှင့် တွဲဖက်အသုံးပြုမှု

- **Heartbeat/Cron** သည် run ဖြစ်မည့် _အချိန်_ ကို ဆုံးဖြတ်ပါသည်။
- **Lobster** သည် run စတင်ပြီးနောက် _လုပ်ဆောင်မည့် အဆင့်များ_ ကို သတ်မှတ်ပါသည်။

37. Schedule လုပ်ထားသော workflow များအတွက် Lobster ကို ခေါ်သော agent turn ကို trigger လုပ်ရန် cron သို့မဟုတ် heartbeat ကို အသုံးပြုပါ။
38. Ad-hoc workflow များအတွက် Lobster ကို တိုက်ရိုက် ခေါ်ပါ။

### လုပ်ငန်းဆောင်ရွက်မှု မှတ်စုများ (code မှ)

- Lobster သည် tool mode အတွင်း **local subprocess** (`lobster` CLI) အဖြစ် run လုပ်ပြီး **JSON envelope** ကို ပြန်ပေးပါသည်။
- tool သည် `needs_approval` ကို ပြန်ပေးပါက `resumeToken` နှင့် `approve` flag ဖြင့် ပြန်လည်ဆက်လုပ်ပါသည်။
- tool သည် **optional plugin** ဖြစ်ပြီး `tools.alsoAllow: ["lobster"]` ဖြင့် ထပ်တိုး ဖွင့်နိုင်ပါသည် (အကြံပြု)။
- `lobsterPath` ကို ပို့ပါက **absolute path** ဖြစ်ရပါမည်။

အသုံးပြုနည်းနှင့် ဥပမာအပြည့်အစုံအတွက် [Lobster](/tools/lobster) ကို ကြည့်ပါ။

## Main Session နှင့် Isolated Session

Heartbeat နှင့် cron နှစ်မျိုးလုံးသည် main session နှင့် ဆက်သွယ်နိုင်သော်လည်း နည်းလမ်းကွဲပြားပါသည်။

|         | Heartbeat                         | Cron (main)               | Cron (isolated)            |
| ------- | --------------------------------- | -------------------------------------------- | --------------------------------------------- |
| Session | Main                              | Main (system event ဖြင့်) | `cron:<jobId>`                                |
| History | မျှဝေထားသည်                       | မျှဝေထားသည်                                  | run တစ်ကြိမ်ချင်းစီ အသစ်                      |
| Context | အပြည့်အစုံ                        | အပြည့်အစုံ                                   | မရှိ (အသစ်စတင်)            |
| Model   | Main session မော်ဒယ်              | Main session မော်ဒယ်                         | Override လုပ်နိုင်                            |
| Output  | `HEARTBEAT_OK` မဟုတ်ပါက ပို့ဆောင် | Heartbeat prompt + event                     | Announce summary (ပုံမှန်) |

### Main session cron ကို အသုံးပြုသင့်သောအချိန်

`--session main` ကို `--system-event` ဖြင့် အသုံးပြုပါ၊ အောက်ပါအရာများကို လိုလားသောအခါ—

- သတိပေးချက်/အဖြစ်အပျက်ကို main session context အတွင်း တွေ့မြင်လိုသောအခါ
- နောက် heartbeat တွင် အပြည့်အစုံ context ဖြင့် အေးဂျင့်က ကိုင်တွယ်စေလိုသောအခါ
- သီးခြား isolated run မလိုအပ်သောအခါ

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Isolated cron ကို အသုံးပြုသင့်သောအချိန်

`--session isolated` ကို အသုံးပြုပါ၊ အောက်ပါအရာများကို လိုလားသောအခါ—

- ယခင် context မပါသော clean slate
- မတူညီသော မော်ဒယ် သို့မဟုတ် စဉ်းစားမှု ဆက်တင်များ
- အကျဉ်းချုပ်များကို ချန်နယ်သို့ တိုက်ရိုက် ကြေညာလိုသောအခါ
- Main session ကို ရှုပ်ထွေးစေမည့် history မလိုအပ်သောအခါ

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## ကုန်ကျစရိတ် စဉ်းစားရန်

| နည်းလမ်း                           | ကုန်ကျစရိတ် ပရိုဖိုင်                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Heartbeat                          | မိနစ် N တစ်ကြိမ် agent turn တစ်ခု; HEARTBEAT.md အရွယ်အစားအပေါ် မူတည်၍ တိုးပွား |
| Cron (main)     | နောက် heartbeat သို့ event ထည့်ခြင်း (isolated turn မရှိ)                   |
| Cron (isolated) | job တစ်ခုချင်းစီအတွက် agent turn အပြည့်; စျေးသက်သာသော မော်ဒယ် အသုံးပြုနိုင်                    |

**အကြံပြုချက်များ**:

- Token overhead ကို လျှော့ချရန် `HEARTBEAT.md` ကို သေးငယ်အောင် ထားပါ။
- တူညီသော စစ်ဆေးမှုများကို cron jobs အများအပြား ခွဲမထားဘဲ heartbeat ထဲတွင် အစုလိုက်လုပ်ဆောင်ပါ။
- အတွင်းပိုင်း လုပ်ဆောင်မှုသာ လိုအပ်ပါက heartbeat တွင် `target: "none"` ကို အသုံးပြုပါ။
- ပုံမှန် တာဝန်များအတွက် isolated cron ကို စျေးသက်သာသော မော်ဒယ်ဖြင့် အသုံးပြုပါ။

## ဆက်စပ်အကြောင်းအရာများ

- [Heartbeat](/gateway/heartbeat) - heartbeat ဖွဲ့စည်းပြင်ဆင်မှု အပြည့်အစုံ
- [Cron jobs](/automation/cron-jobs) - cron CLI နှင့် API reference အပြည့်အစုံ
- [System](/cli/system) - system events နှင့် heartbeat ထိန်းချုပ်မှု
