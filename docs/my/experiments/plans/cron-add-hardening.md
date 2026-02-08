---
summary: "cron.add အဝင်အထွက်ကို ခိုင်မာအောင်လုပ်ခြင်း၊ schema များကို ကိုက်ညီအောင် ချိန်ညှိခြင်း၊ နှင့် cron UI/agent ကိရိယာများကို တိုးတက်အောင်လုပ်ခြင်း"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Cron Add Hardening"
x-i18n:
  source_path: experiments/plans/cron-add-hardening.md
  source_hash: d7e469674bd9435b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:23Z
---

# Cron Add Hardening & Schema Alignment

## အကြောင်းအရာ (Context)

မကြာသေးမီက Gateway လော့ဂ်များတွင် မမှန်ကန်သော ပါရာမီတာများ ( `sessionTarget`, `wakeMode`, `payload` မပါရှိခြင်း၊ နှင့် မမှန်ကန်သော `schedule` ) ကြောင့် `cron.add` မအောင်မြင်မှုများကို ထပ်ခါတလဲလဲ တွေ့ရှိရပါသည်။ ၎င်းက client တစ်ခု (အထူးသဖြင့် agent tool call လမ်းကြောင်းဖြစ်နိုင်) မှ job payload များကို wrapper ဖြင့် ထုပ်ပိုးထားခြင်း သို့မဟုတ် အစိတ်အပိုင်းမပြည့်စုံဘဲ ပို့နေကြောင်းကို ညွှန်ပြပါသည်။ ထို့အပြင် TypeScript၊ gateway schema၊ CLI flags၊ နှင့် UI form types တို့အကြား cron provider enums များ မကိုက်ညီခြင်းလည်း ရှိနေပြီး၊ UI တွင် `cron.status` အတွက် မကိုက်ညီမှု ( `jobCount` ကို မျှော်မှန်းသော်လည်း gateway က `jobs` ကို ပြန်ပို့ခြင်း) ရှိနေပါသည်။

## ရည်မှန်းချက်များ (Goals)

- ပုံမှန် wrapper payload များကို normalization လုပ်ခြင်းနှင့် မရှိသော `kind` အကွက်များကို ခန့်မှန်းဖြည့်သွင်းခြင်းအားဖြင့် `cron.add` INVALID_REQUEST spam ကို ရပ်တန့်စေရန်။
- Gateway schema၊ cron types၊ CLI စာတမ်းများ၊ နှင့် UI forms တို့အကြား cron provider စာရင်းများကို ကိုက်ညီအောင် ချိန်ညှိရန်။
- Agent cron tool schema ကို ထင်ရှားစွာ သတ်မှတ်၍ LLM မှ မှန်ကန်သော job payload များကို ထုတ်လုပ်စေရန်။
- Control UI တွင် cron status job count ပြသမှုကို ပြုပြင်ရန်။
- Normalization နှင့် tool အပြုအမူကို ဖုံးလွှမ်းစေမည့် စမ်းသပ်မှုများကို ထည့်သွင်းရန်။

## မပါဝင်သည့်အချက်များ (Non-goals)

- Cron scheduling semantics သို့မဟုတ် job အကောင်အထည်ဖော်မှု အပြုအမူကို ပြောင်းလဲခြင်း။
- Schedule အမျိုးအစားအသစ်များ ထည့်သွင်းခြင်း သို့မဟုတ် cron expression parsing ကို ထည့်သွင်းခြင်း။
- လိုအပ်သော field ပြင်ဆင်မှုများအပြင် cron အတွက် UI/UX ကို အကြီးအကျယ် ပြန်လည်ပြင်ဆင်ခြင်း။

## တွေ့ရှိချက်များ (လက်ရှိအခွာအဟာ)

- Gateway အတွင်းရှိ `CronPayloadSchema` သည် `signal` + `imessage` ကို မပါဝင်စေသော်လည်း TS types တွင် ပါဝင်နေပါသည်။
- Control UI CronStatus သည် `jobCount` ကို မျှော်မှန်းထားသော်လည်း gateway က `jobs` ကို ပြန်ပို့ပါသည်။
- Agent cron tool schema သည် မည်သည့် `job` object မဆို ခွင့်ပြုထားသောကြောင့် မမှန်ကန်သော input များကို ဖြစ်စေပါသည်။
- Gateway သည် `cron.add` ကို normalization မရှိဘဲ တင်းကျပ်စွာ စစ်ဆေးသဖြင့် wrapper payload များ မအောင်မြင်ပါသည်။

## ပြောင်းလဲထားသည့်အချက်များ (What changed)

- `cron.add` နှင့် `cron.update` သည် ယခုအခါ ပုံမှန် wrapper ပုံစံများကို normalization လုပ်ပြီး မရှိသော `kind` အကွက်များကို ခန့်မှန်းဖြည့်သွင်းပါသည်။
- Agent cron tool schema သည် gateway schema နှင့် ကိုက်ညီလာသောကြောင့် မမှန်ကန်သော payload များ လျော့နည်းလာပါသည်။
- Provider enums များကို gateway၊ CLI၊ UI နှင့် macOS picker တို့အကြား ကိုက်ညီအောင် ချိန်ညှိပြီးဖြစ်ပါသည်။
- Control UI သည် status အတွက် gateway ၏ `jobs` count field ကို အသုံးပြုပါသည်။

## လက်ရှိအပြုအမူ (Current behavior)

- **Normalization:** wrapper ပါသော `data`/`job` payload များကို ဖယ်ရှားထုတ်ယူပြီး၊ လုံခြုံမှုရှိသောအခါ `schedule.kind` နှင့် `payload.kind` ကို ခန့်မှန်းဖြည့်သွင်းပါသည်။
- **Defaults:** မရှိသောအခါ `wakeMode` နှင့် `sessionTarget` အတွက် လုံခြုံသော default များကို အသုံးပြုပါသည်။
- **Providers:** Discord/Slack/Signal/iMessage ကို ယခုအခါ CLI/UI တို့အကြား တူညီစွာ ပြသထားပါသည်။

Normalization လုပ်ထားသော ပုံစံနှင့် ဥပမာများအတွက် [Cron jobs](/automation/cron-jobs) ကို ကြည့်ပါ။

## စစ်ဆေးအတည်ပြုခြင်း (Verification)

- Gateway လော့ဂ်များတွင် `cron.add` INVALID_REQUEST အမှားများ လျော့နည်းလာသည်ကို စောင့်ကြည့်ပါ။
- Refresh ပြုလုပ်ပြီးနောက် Control UI cron status တွင် job count ပြသထားသည်ကို အတည်ပြုပါ။

## ရွေးချယ်နိုင်သော နောက်ဆက်တွဲများ (Optional Follow-ups)

- Control UI ကို လက်ဖြင့် စမ်းသပ်ခြင်း: provider တစ်ခုစီအတွက် cron job တစ်ခု ထည့်သွင်းပြီး status job count ကို အတည်ပြုပါ။

## မဖြေရှင်းရသေးသော မေးခွန်းများ (Open Questions)

- `cron.add` သည် client များမှ explicit `state` ကို လက်ခံသင့်ပါသလား (လက်ရှိတွင် schema အရ ခွင့်မပြုထားပါ)?
- `webchat` ကို explicit delivery provider အဖြစ် ခွင့်ပြုသင့်ပါသလား (လက်ရှိတွင် delivery resolution အတွင်း စစ်ထုတ်ထားပါသည်)?
