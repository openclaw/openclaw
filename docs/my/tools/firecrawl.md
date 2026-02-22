---
summary: "web_fetch အတွက် Firecrawl fallback (anti-bot + cached extraction)"
read_when:
  - Firecrawl အခြေခံ web extraction ကို အသုံးပြုလိုသောအခါ
  - Firecrawl API key လိုအပ်သောအခါ
  - web_fetch အတွက် anti-bot extraction လိုအပ်သောအခါ
title: "Firecrawl"
---

# Firecrawl

OpenClaw သည် `web_fetch` အတွက် fallback extractor အဖြစ် **Firecrawl** ကို အသုံးပြုနိုင်သည်။ ၎င်းသည် bot circumvention နှင့် caching ကို ထောက်ပံ့သည့် hosted content extraction service တစ်ခုဖြစ်ပြီး JS-heavy sites များ သို့မဟုတ် plain HTTP fetch များကို ပိတ်ထားသော စာမျက်နှာများအတွက် အထောက်အကူဖြစ်သည်။

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
- `maxAgeMs` သည် cached result များကို ဘယ်လောက်အဟောင်းအထိ ခွင့်ပြုမည်ကို (ms) ထိန်းချုပ်သည်။ Default သည် ၂ ရက် ဖြစ်သည်။

## Stealth / bot ကာကွယ်မှု လှည့်ကွက်

Firecrawl သည် bot circumvention အတွက် **proxy mode** parameter (`basic`, `stealth`, သို့မဟုတ် `auto`) ကို ထုတ်ပေးထားသည်။
OpenClaw သည် Firecrawl request များအတွက် အမြဲ `proxy: "auto"` နှင့် `storeInCache: true` ကို အသုံးပြုသည်။
Proxy ကို မသတ်မှတ်ပါက Firecrawl သည် default အနေဖြင့် `auto` ကို အသုံးပြုသည်။ `auto` သည် basic attempt မအောင်မြင်ပါက stealth proxies များဖြင့် ပြန်လည်ကြိုးစားပြီး basic-only scraping ထက် credits ပိုမို အသုံးပြုနိုင်သည်။

## `web_fetch` သည် Firecrawl ကို မည်သို့ အသုံးပြုသနည်း

`web_fetch` extraction အစီအစဉ်:

1. Readability (local)
2. Firecrawl (ဖွဲ့စည်းပြင်ဆင်ထားပါက)
3. အခြေခံ HTML သန့်ရှင်းရေး (နောက်ဆုံး fallback)

web tool စနစ်တကျ ပြင်ဆင်မှု အပြည့်အစုံအတွက် [Web tools](/tools/web) ကို ကြည့်ပါ။
