---
summary: "မီနူးဘား အခြေအနေ လောဂျစ်နှင့် အသုံးပြုသူများအား မည်သို့ ပြသထားသည်"
read_when:
  - mac မီနူး UI သို့မဟုတ် အခြေအနေ လောဂျစ်ကို ချိန်ညှိနေသည့်အခါ
title: "မီနူးဘား"
---

# မီနူးဘား အခြေအနေ လောဂျစ်

## မည်သည်ကို ပြသထားသည်

- လက်ရှိ အေးဂျင့်၏ အလုပ်လုပ်နေသော အခြေအနေကို မီနူးဘား အိုင်ကွန်နှင့် မီနူး၏ ပထမ အခြေအနေ စာကြောင်းတွင် ပြသထားသည်။
- အလုပ် လုပ်နေစဉ်အတွင်း Health အခြေအနေကို ဖုံးကွယ်ထားပြီး ဆက်ရှင်များအားလုံး အလုပ်မလုပ်နေသောအခါ ပြန်လည် ပြသသည်။
- မီနူးအတွင်းရှိ “Nodes” ဘလောက်တွင် **စက်ပစ္စည်းများ** ကိုသာ ( `node.list` မှတဆင့် တွဲဖက်ထားသော နိုဒ်များ ) စာရင်းပြုလုပ်ထားပြီး client/presence အချက်အလက်များ မပါဝင်ပါ။
- provider အသုံးပြုမှု snapshot များ ရရှိနိုင်သည့်အခါ Context အောက်တွင် “Usage” အပိုင်း ပေါ်လာသည်။

## အခြေအနေ မော်ဒယ်

- 24. Sessions: event များသည် `runId` (run တစ်ခုစီအတွက်) နှင့် payload ထဲရှိ `sessionKey` တို့ဖြင့် ရောက်လာပါသည်။ 25. “main” session သည် key `main` ဖြစ်ပြီး၊ မရှိပါက နောက်ဆုံး update လုပ်ထားသော session ကို fallback အဖြစ် အသုံးပြုပါသည်။
- 26. ဦးစားပေးမှု: main သည် အမြဲတမ်း အနိုင်ရပါသည်။ If main is active, its state is shown immediately. 28. main သည် idle ဖြစ်ပါက နောက်ဆုံး active ဖြစ်ခဲ့သော non‑main session ကို ပြသပါသည်။ We do not flip‑flop mid‑activity; we only switch when the current session goes idle or main becomes active.
- လှုပ်ရှားမှု အမျိုးအစားများ:
  - `job`: အဆင့်မြင့် အမိန့် အကောင်အထည်ဖော်ခြင်း (`state: started|streaming|done|error`)။
  - `tool`: `phase: start|result` ကို `toolName` နှင့် `meta/args` တို့ဖြင့် ပြုလုပ်ခြင်း။

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (debug override)

### ActivityKind → glyph

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- default → 🛠️

### မြင်သာမှု မပ်ပင်း

- `idle`: ပုံမှန် critter။
- `workingMain`: glyph ပါသော badge၊ အရောင်အပြည့် tint၊ ခြေထောက် “အလုပ်လုပ်နေသည်” အန်နီမေးရှင်း။
- `workingOther`: glyph ပါသော badge၊ တိတ်ဆိတ်သော tint၊ scurry မရှိ။
- `overridden`: လှုပ်ရှားမှုမည်သို့ရှိစေကာမူ ရွေးချယ်ထားသော glyph/tint ကို အသုံးပြုသည်။

## အခြေအနေ စာကြောင်း စာသား (မီနူး)

- အလုပ် လုပ်နေစဉ်: `<Session role> · <activity label>`
  - ဥပမာများ: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`။
- အလုပ်မလုပ်နေသည့်အခါ: Health အကျဉ်းချုပ်သို့ ပြန်လည် ပြောင်းသည်။

## ဖြစ်ရပ် ဝင်ရောက်မှု

- အရင်းအမြစ်: control‑channel `agent` ဖြစ်ရပ်များ (`ControlChannel.handleAgentEvent`)။
- ခွဲခြမ်းစိတ်ဖြာထားသော ဖယ်လ်ဒ်များ:
  - စတင်/ရပ်တန့် အတွက် `data.state` ပါသော `stream: "job"`။
  - `data.phase`, `name`, အပြင် အလိုအလျောက်ရွေးချယ်နိုင်သော `meta`/`args` ပါသော `stream: "tool"`။
- လိပ်စာတပ်များ:
  - `exec`: `args.command` ၏ ပထမ စာကြောင်း။
  - `read`/`write`: လမ်းကြောင်း အတိုချုံး။
  - `edit`: `meta`/diff အရေအတွက်များမှ ခန့်မှန်းထားသော ပြောင်းလဲမှု အမျိုးအစားနှင့် လမ်းကြောင်း။
  - fallback: ကိရိယာ အမည်။

## Debug override

- Settings ▸ Debug ▸ “Icon override” ရွေးချယ်ကိရိယာ:
  - `System (auto)` (default)
  - `Working: main` (ကိရိယာ အမျိုးအစား တစ်မျိုးချင်းစီအလိုက်)
  - `Working: other` (ကိရိယာ အမျိုးအစား တစ်မျိုးချင်းစီအလိုက်)
  - `Idle`
- `@AppStorage("iconOverride")` ဖြင့် သိမ်းဆည်းပြီး `IconState.overridden` သို့ မပ်ပင်းလုပ်ထားသည်။

## စမ်းသပ်ရန် စစ်ဆေးစာရင်း

- main ဆက်ရှင် အလုပ်ကို စတင်လုပ်ဆောင်ပါ: အိုင်ကွန်သည် ချက်ချင်း ပြောင်းလဲပြီး အခြေအနေ စာကြောင်းတွင် main လိပ်စာ ပြသကြောင်း စစ်ဆေးပါ။
- main အလုပ်မလုပ်နေစဉ် non‑main ဆက်ရှင် အလုပ်ကို စတင်ပါ: အိုင်ကွန်/အခြေအနေတွင် non‑main ကို ပြသပြီး ပြီးဆုံးသည်အထိ တည်ငြိမ်နေကြောင်း စစ်ဆေးပါ။
- အခြားဆက်ရှင် အလုပ်လုပ်နေစဉ် main ကို စတင်ပါ: အိုင်ကွန်သည် main သို့ ချက်ချင်း ပြောင်းလဲကြောင်း စစ်ဆေးပါ။
- ကိရိယာ အမြန်အလှုပ်အရှားများ: badge မလှုပ်ရှားပြောင်းလဲခြင်း မဖြစ်ကြောင်း (tool ရလဒ်များအတွက် TTL grace) သေချာစေပါ။
- ဆက်ရှင်များအားလုံး အလုပ်မလုပ်တော့သည့်အခါ Health စာကြောင်း ပြန်လည် ပေါ်လာကြောင်း စစ်ဆေးပါ။
