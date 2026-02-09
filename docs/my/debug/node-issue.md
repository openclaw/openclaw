---
summary: Node + tsx "__name is not a function" ပျက်ကွက်မှုဆိုင်ရာ မှတ်စုများနှင့် ဖြေရှင်းနည်းများ
read_when:
  - Node-only dev စကရစ်များ သို့မဟုတ် watch mode ပျက်ကွက်မှုများကို Debug လုပ်နေချိန်
  - OpenClaw တွင် tsx/esbuild loader ပျက်ကွက်မှုများကို စုံစမ်းစစ်ဆေးနေချိန်
title: "Node + tsx ပျက်ကွက်မှု"
---

# Node + tsx "\_\_name is not a function" ပျက်ကွက်မှု

## အကျဉ်းချုပ်

Node ဖြင့် OpenClaw ကို `tsx` အသုံးပြု၍ ပြေးသောအခါ စတင်ချိန်တွင် အောက်ပါအတိုင်း ပျက်ကွက်ပါသည်—

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

ဤအရာသည် dev scripts များကို Bun မှ `tsx` သို့ ပြောင်းလဲပြီးနောက် စတင်ဖြစ်ပေါ်လာပါသည် (commit `2871657e`, 2026-01-06)။ တူညီသော runtime path သည် Bun နှင့်အတူ အလုပ်လုပ်ခဲ့ပါသည်။

## ပတ်ဝန်းကျင်

- Node: v25.x (v25.3.0 တွင် တွေ့ရှိခဲ့သည်)
- tsx: 4.21.0
- OS: macOS (Node 25 ကို ပြေးနိုင်သော အခြားပလက်ဖောင်းများတွင်လည်း ပြန်လည်ဖြစ်နိုင်ခြေရှိ)

## Repro (Node-only)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Repo အတွင်း Minimal repro

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node ဗားရှင်း စစ်ဆေးမှု

- Node 25.3.0: မအောင်မြင်
- Node 22.22.0 (Homebrew `node@22`): မအောင်မြင်
- Node 24: ယခုနေရာတွင် မတပ်ဆင်ထားသေးပါ; အတည်ပြုရန် လိုအပ်

## မှတ်ချက်များ / အယူအဆ

- `tsx` သည် TS/ESM ကို ပြောင်းလဲရန် esbuild ကို အသုံးပြုပါသည်။ esbuild ၏ `keepNames` သည် `__name` helper ကို ထုတ်ပေးပြီး function definition များကို `__name(...)` ဖြင့် ပတ်လည်ထုပ်ပိုးပါသည်။
- ပျက်ကွက်မှုသည် runtime တွင် `__name` ရှိနေသော်လည်း function မဟုတ်ကြောင်း ပြသနေပြီး Node 25 loader လမ်းကြောင်းတွင် 해당 module အတွက် helper ပျောက်ဆုံးခြင်း သို့မဟုတ် အစားထိုးရေးသားခံရခြင်း ဖြစ်နိုင်ကြောင်း အရိပ်အမြွက်ပေးပါသည်။
- esbuild ကို အသုံးပြုသော အခြား consumer များတွင်လည်း helper ပျောက်ဆုံးခြင်း သို့မဟုတ် ပြန်လည်ရေးသားခံရခြင်းကြောင့် ဖြစ်ပေါ်သော ဆင်တူ `__name` helper ပြဿနာများကို အစီရင်ခံထားပြီးဖြစ်ပါသည်။

## Regression သမိုင်း

- `2871657e` (2026-01-06): Bun ကို မဖြစ်မနေ မလိုအပ်အောင် tsx သို့ စကရစ်များ ပြောင်းလဲခဲ့သည်။
- ထိုမတိုင်မီ (Bun လမ်းကြောင်း) တွင် `openclaw status` နှင့် `gateway:watch` တို့ အလုပ်လုပ်နေခဲ့ပါသည်။

## ဖြေရှင်းနည်းများ

- dev စကရစ်များအတွက် Bun ကို အသုံးပြုပါ (ယာယီ ပြန်ပြောင်းအသုံးပြုခြင်း)။

- Node + tsc watch ကို အသုံးပြုပြီး compile ထွက်လာသော output ကို ပြေးပါ—

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- ဒေသတွင်း အတည်ပြုထားသည်—`pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` သည် Node 25 တွင် အလုပ်လုပ်ပါသည်။

- ဖြစ်နိုင်ပါက TS loader တွင် esbuild keepNames ကို ပိတ်ပါ ( `__name` helper ထည့်သွင်းမှုကို ကာကွယ်ပေးသည်)၊ သို့သော် tsx သည် ယခုအချိန်တွင် ၎င်းကို ဖော်ထုတ်မပေးသေးပါ။

- ပြဿနာသည် Node 25 သီးသန့်ဖြစ်မဖြစ် စစ်ဆေးရန် `tsx` ဖြင့် Node LTS (22/24) ကို စမ်းသပ်ပါ။

## ကိုးကားချက်များ

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## နောက်ထပ် လုပ်ဆောင်ရန် အဆင့်များ

- Node 25 regression ကို အတည်ပြုရန် Node 22/24 တွင် Repro လုပ်ပါ။
- သိရှိပြီးသား regression ရှိပါက `tsx` nightly ကို စမ်းသပ်ပါ သို့မဟုတ် အရင်ဗားရှင်းသို့ pin လုပ်ပါ။
- Node LTS တွင်ပါ ပြန်လည်ဖြစ်ပေါ်ပါက `__name` stack trace ဖြင့် upstream သို့ minimal repro တစ်ခု တင်သွင်းပါ။
