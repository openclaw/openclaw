---
summary: "web_fetch အတွက် Firecrawl fallback (anti-bot + cached extraction)"
read_when:
  - Firecrawl အခြေခံ web extraction ကို အသုံးပြုလိုသောအခါ
  - Firecrawl API key လိုအပ်သောအခါ
  - web_fetch အတွက် anti-bot extraction လိုအပ်သောအခါ
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:01Z
---

# Firecrawl

OpenClaw သည် **Firecrawl** ကို `web_fetch` အတွက် fallback extractor အဖြစ် အသုံးပြုနိုင်သည်။ ၎င်းသည် bot ကာကွယ်မှုကို လှည့်ကွက်ဖြင့် ကျော်လွှားနိုင်ခြင်းနှင့် caching ကို ထောက်ပံ့ပေးသည့် hosted content extraction ဝန်ဆောင်မှုတစ်ခုဖြစ်ပြီး JS-heavy ဆိုက်များ သို့မဟုတ် ရိုးရိုး HTTP fetch များကို ပိတ်ထားသော စာမျက်နှာများအတွက် အသုံးဝင်သည်။

## API key ရယူရန်

1. Firecrawl အကောင့်တစ်ခု ဖန်တီးပြီး API key ကို ထုတ်လုပ်ပါ။
2. config ထဲတွင် သိမ်းဆည်းပါ သို့မဟုတ် gateway environment ထဲတွင် `FIRECRAWL_API_KEY` ကို သတ်မှတ်ပါ။

## Firecrawl ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

မှတ်ချက်များ:

- API key ရှိပါက `firecrawl.enabled` သည် မူလအနေဖြင့် true ဖြစ်သည်။
- `maxAgeMs` သည် cached ရလဒ်များ၏ အသက်အရွယ်ကို (ms ဖြင့်) ထိန်းချုပ်သည်။ မူလတန်ဖိုးမှာ ၂ ရက် ဖြစ်သည်။

## Stealth / bot ကာကွယ်မှု လှည့်ကွက်

Firecrawl သည် bot ကာကွယ်မှုကို လှည့်ကွက်ဖြင့် ကျော်လွှားရန် **proxy mode** parameter ကို ပေးထားသည် (`basic`, `stealth`, သို့မဟုတ် `auto`)။
OpenClaw သည် Firecrawl တောင်းဆိုမှုများအတွက် အမြဲတမ်း `proxy: "auto"` နှင့် `storeInCache: true` ကို ပေါင်းသုံးသည်။
proxy ကို မထည့်ပါက Firecrawl သည် မူလအားဖြင့် `auto` ကို အသုံးပြုသည်။ `auto` သည် အခြေခံ ကြိုးပမ်းမှု မအောင်မြင်ပါက stealth proxies များဖြင့် ပြန်လည်ကြိုးပမ်းသည်၊ ထို့ကြောင့် basic-only scraping ထက် credits ပိုမို အသုံးပြုနိုင်သည်။

## `web_fetch` သည် Firecrawl ကို မည်သို့ အသုံးပြုသနည်း

`web_fetch` extraction အစီအစဉ်:

1. Readability (local)
2. Firecrawl (ဖွဲ့စည်းပြင်ဆင်ထားပါက)
3. အခြေခံ HTML သန့်ရှင်းရေး (နောက်ဆုံး fallback)

web tool စနစ်တကျ ပြင်ဆင်မှု အပြည့်အစုံအတွက် [Web tools](/tools/web) ကို ကြည့်ပါ။
