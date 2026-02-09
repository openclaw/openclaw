---
summary: "စမ်းသပ်မှုများကို ဒေသတွင်း (vitest) တွင် မည်သို့လုပ်ဆောင်ရမည်နှင့် force/coverage မုဒ်များကို မည်သည့်အချိန်တွင် အသုံးပြုရမည်"
read_when:
  - စမ်းသပ်မှုများကို လုပ်ဆောင်နေစဉ် သို့မဟုတ် ပြင်ဆင်နေစဉ်
title: "စမ်းသပ်မှုများ"
---

# စမ်းသပ်မှုများ

- စမ်းသပ်ရေးကိရိယာအစုံအလင် (suites, live, Docker): [Testing](/help/testing)

- 30. `pnpm test:force`: ပုံမှန် control port ကို ကိုင်ထားတဲ့ gateway process များကို အဆုံးသတ်ပြီး၊ သီးသန့် gateway port နဲ့ Vitest suite အပြည့်အစုံကို chạy လုပ်ပါတယ်၊ ဒါကြောင့် server tests တွေက လက်ရှိ chạy နေတဲ့ instance နဲ့ မထိခိုက်ပါဘူး။ 31. ယခင် gateway run တစ်ခုက port 18789 ကို သိမ်းထားခဲ့တဲ့အခါ ဒီဟာကို သုံးပါ။

- 32. `pnpm test:coverage`: V8 coverage နဲ့ Vitest ကို chạy လုပ်ပါတယ်။ 33. Global thresholds တွေက lines/branches/functions/statements အတွက် 70% ပါ။ Coverage excludes integration-heavy entrypoints (CLI wiring, gateway/telegram bridges, webchat static server) to keep the target focused on unit-testable logic.

- `pnpm test:e2e`: Gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing) ကို လုပ်ဆောင်သည်။

- 35. `pnpm test:live`: provider live tests (minimax/zai) ကို chạy လုပ်ပါတယ်။ 36. API keys နဲ့ `LIVE=1` (သို့မဟုတ် provider-specific `*_LIVE_TEST=1`) လိုအပ်ပြီး unskip လုပ်ရန် အသုံးပြုရပါတယ်။

## Model latency bench (local keys)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Usage:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Optional env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- 37. Default prompt: “စကားလုံး တစ်လုံးတည်းနဲ့ ပြန်ကြားပါ: ok။ 38. အမှတ်အသား punctuation မထည့်ပါနဲ့၊ ထပ်ဆောင်း စာသား မပါစေနဲ့။”

နောက်ဆုံး လုပ်ဆောင်မှု (2025-12-31, 20 runs):

- minimax median 1279ms (min 1114, max 2431)
- opus median 2454ms (min 1224, max 3170)

## Onboarding E2E (Docker)

Docker သည် မဖြစ်မနေ မလိုအပ်ပါ။ containerized onboarding smoke tests အတွက်သာ လိုအပ်သည်။

သန့်ရှင်းသော Linux container အတွင်း full cold-start လုပ်ငန်းစဉ်အပြည့်အစုံ:

```bash
scripts/e2e/onboard-docker.sh
```

ဤ script သည် interactive wizard ကို pseudo-tty မှတစ်ဆင့် မောင်းနှင်ပြီး config/workspace/session ဖိုင်များကို စစ်ဆေးကာ၊ ထို့နောက် Gateway ကို စတင်ပြီး `openclaw health` ကို လုပ်ဆောင်သည်။

## QR import smoke (Docker)

Docker အတွင်း Node 22+ ဖြင့် `qrcode-terminal` ကို load လုပ်နိုင်ကြောင်း အတည်ပြုသည်:

```bash
pnpm test:docker:qr
```
