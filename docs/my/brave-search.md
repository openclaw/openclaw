---
summary: "web_search အတွက် Brave Search API ကို တပ်ဆင်ပြင်ဆင်ခြင်း"
read_when:
  - web_search အတွက် Brave Search ကို အသုံးပြုချင်သောအခါ
  - BRAVE_API_KEY သို့မဟုတ် စီမံကိန်း အစီအစဉ် အသေးစိတ်များ လိုအပ်သောအခါ
title: "Brave Search"
---

# Brave Search API

OpenClaw သည် `web_search` အတွက် မူလ ပံ့ပိုးသူအဖြစ် Brave Search ကို အသုံးပြုပါသည်။

## API ကီး ရယူရန်

1. [https://brave.com/search/api/](https://brave.com/search/api/) တွင် Brave Search API အကောင့် တစ်ခု ဖန်တီးပါ။
2. ဒက်ရှ်ဘုတ်တွင် **Data for Search** စီမံကိန်းကို ရွေးချယ်ပြီး API ကီး တစ်ခု ထုတ်လုပ်ပါ။
3. ကီးကို config ထဲတွင် သိမ်းဆည်းပါ (အကြံပြုထားသည်) သို့မဟုတ် Gateway ပတ်ဝန်းကျင်တွင် `BRAVE_API_KEY` ကို သတ်မှတ်ပါ။

## Config ဥပမာ

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## မှတ်ချက်များ

- Data for AI စီမံကိန်းသည် `web_search` နှင့် **မကိုက်ညီပါ**။
- Brave သည် အခမဲ့ အဆင့်တစ်ခုနှင့် အခပေး စီမံကိန်းများကို ပံ့ပိုးထားပါသည်။ လက်ရှိ ကန့်သတ်ချက်များအတွက် Brave API ပေါ်တယ်ကို စစ်ဆေးပါ။

web_search ဖွဲ့စည်းပြင်ဆင်မှု အပြည့်အစုံအတွက် [Web tools](/tools/web) ကို ကြည့်ပါ။
