---
summary: "စမ်းသပ်မှုများကို ဒေသတွင်း (vitest) တွင် မည်သို့လုပ်ဆောင်ရမည်နှင့် force/coverage မုဒ်များကို မည်သည့်အချိန်တွင် အသုံးပြုရမည်"
read_when:
  - စမ်းသပ်မှုများကို လုပ်ဆောင်နေစဉ် သို့မဟုတ် ပြင်ဆင်နေစဉ်
title: "စမ်းသပ်မှုများ"
x-i18n:
  source_path: reference/test.md
  source_hash: 814cc52aae0788eb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:56Z
---

# စမ်းသပ်မှုများ

- စမ်းသပ်ရေးကိရိယာအစုံအလင် (suites, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: ပုံမှန်ထိန်းချုပ်ရေး ပေါက် (control port) ကို ကိုင်ထားနေသည့် Gateway လုပ်ငန်းစဉ်များကို ပိတ်သိမ်းပြီး၊ Gateway ပေါက်ကို သီးခြားသတ်မှတ်ထားသော Vitest စမ်းသပ်မှု အစုံအလင်ကို လုပ်ဆောင်သည်။ ယခင် Gateway လည်ပတ်မှုတစ်ခုကြောင့် ပေါက် 18789 ကို အသုံးပြုနေဆဲဖြစ်ပါက ယင်းကို အသုံးပြုပါ။
- `pnpm test:coverage`: V8 coverage ဖြင့် Vitest ကို လုပ်ဆောင်သည်။ Global threshold များမှာ lines/branches/functions/statements အားလုံးအတွက် 70% ဖြစ်သည်။ Coverage တွင် integration အလေးပေးသော entrypoints များ (CLI ချိတ်ဆက်မှု၊ gateway/telegram bridges၊ webchat static server) ကို ဖယ်ရှားထားပြီး unit-test လုပ်နိုင်သော logic များအပေါ် အာရုံစိုက်စေရန် ရည်ရွယ်ထားသည်။
- `pnpm test:e2e`: Gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing) ကို လုပ်ဆောင်သည်။
- `pnpm test:live`: provider live tests (minimax/zai) ကို လုပ်ဆောင်သည်။ API keys များနှင့် `LIVE=1` (သို့မဟုတ် provider-specific `*_LIVE_TEST=1`) ရှိရန်လိုအပ်ပြီး unskip လုပ်နိုင်ရန် လိုအပ်သည်။

## Model latency bench (local keys)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Usage:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Optional env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- မူလ prompt: “စကားလုံးတစ်လုံးတည်းဖြင့် ပြန်ကြားပါ: ok. သင်္ကေတ သို့မဟုတ် အပိုစာသား မပါဝင်ရပါ။”

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
