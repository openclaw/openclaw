---
summary: "Bun လုပ်ငန်းစဉ် (စမ်းသပ်ဆဲ): pnpm နှင့် နှိုင်းယှဉ်သည့် တပ်ဆင်ခြင်းနှင့် သတိပြုရမည့်အချက်များ"
read_when:
  - အမြန်ဆုံး local dev loop (bun + watch) ကိုလိုချင်သောအခါ
  - Bun install/patch/lifecycle script ဆိုင်ရာ ပြဿနာများကို ကြုံတွေ့သောအခါ
title: "Bun (စမ်းသပ်ဆဲ)"
---

# Bun (စမ်းသပ်ဆဲ)

ရည်ရွယ်ချက် — pnpm လုပ်ငန်းစဉ်များမှ မကွဲပြားဘဲ **Bun** ဖြင့် (ရွေးချယ်နိုင်သည်၊ WhatsApp/Telegram အတွက် မအကြံပြု) ဤ repo ကို အလုပ်လုပ်စေရန်။

⚠️ **Gateway runtime အတွက် မအကြံပြုပါ** (WhatsApp/Telegram bug များကြောင့်)။ production အတွက် Node ကို အသုံးပြုပါ။

## Status

- Bun သည် TypeScript ကို တိုက်ရိုက် chạy/run လုပ်ရန် အတွက် optional local runtime ဖြစ်သည် (`bun run …`, `bun --watch …`)။
- `pnpm` သည် build များအတွက် default ဖြစ်ပြီး အပြည့်အဝ ထောက်ပံ့ထားဆဲ (နှင့် အချို့ docs tooling များက အသုံးပြုနေဆဲ) ဖြစ်သည်။
- Bun သည် `pnpm-lock.yaml` ကို အသုံးမပြုနိုင်ဘဲ ၎င်းကို လျစ်လျူရှုမည်။

## Install

Default:

```sh
bun install
```

မှတ်ချက်: `bun.lock`/`bun.lockb` များကို gitignore လုပ်ထားသဖြင့်၊ ဘယ်လိုပဲ ဖြစ်ဖြစ် repo churn မဖြစ်ပါ။ သင် _lockfile မရေးချင်လျှင်_:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun lifecycle scripts (default အနေဖြင့် ပိတ်ထားသည်)

Bun သည် အထူးယုံကြည်မှု မပေးပါက dependency lifecycle scripts များကို ပိတ်ထားနိုင်ပါသည် (`bun pm untrusted` / `bun pm trust`)။
ဤ repo အတွက် အများအားဖြင့် ပိတ်ခံရသော scripts များသည် မလိုအပ်ပါ။

- `@whiskeysockets/baileys` `preinstall`: Node major >= 20 ကို စစ်ဆေးသည် (ကျွန်ုပ်တို့က Node 22+ ကို chạy/run လုပ်နေသည်)။
- `protobufjs` `postinstall`: မကိုက်ညီသော version scheme များအကြောင်း သတိပေးချက်များ ထုတ်ပေးသည် (build artifacts မပါ)။

ဤ scripts များလိုအပ်သည့် အမှန်တကယ် runtime ပြဿနာကို ကြုံတွေ့ပါက explicit trust ပေးပါ —

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Caveats

- အချို့ scripts များသည် pnpm ကို hardcode လုပ်ထားဆဲဖြစ်ပါသည် (ဥပမာ `docs:build`, `ui:*`, `protocol:check`)။ ယခုအချိန်အတွက် ထိုအရာများကို pnpm ဖြင့် chạy လုပ်ပါ။
