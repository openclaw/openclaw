---
summary: "အဝင် အသံမှတ်စုများအတွက် Deepgram အသံမှ စာသားပြောင်းလဲခြင်း"
read_when:
  - သင်သည် အသံဖိုင်တွဲများအတွက် Deepgram speech-to-text ကို အသုံးပြုလိုသောအခါ
  - အမြန် Deepgram ဖွဲ့စည်းပြင်ဆင်မှု ဥပမာတစ်ခု လိုအပ်သောအခါ
title: "Deepgram"
x-i18n:
  source_path: providers/deepgram.md
  source_hash: dabd1f6942c339fb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:43Z
---

# Deepgram (အသံမှ စာသားပြောင်းလဲခြင်း)

Deepgram သည် speech-to-text API တစ်ခုဖြစ်သည်။ OpenClaw တွင် **အဝင် အသံ/voice note များကို စာသားပြောင်းလဲရန်**
`tools.media.audio` မှတဆင့် အသုံးပြုသည်။

ဖွင့်ထားသောအခါ OpenClaw သည် အသံဖိုင်ကို Deepgram သို့ တင်ပို့ပြီး
ပြန်ကြားချက် pipeline ထဲသို့ transcript ကို ထည့်သွင်းပေးသည်
(`{{Transcript}}` + `[Audio]` block)။ ဤအရာသည် **streaming မဟုတ်ပါ**;
ကြိုတင်မှတ်တမ်းတင်ထားသော transcription endpoint ကို အသုံးပြုသည်။

Website: [https://deepgram.com](https://deepgram.com)  
Docs: [https://developers.deepgram.com](https://developers.deepgram.com)

## Quick start

1. သင်၏ API key ကို သတ်မှတ်ပါ—

```
DEEPGRAM_API_KEY=dg_...
```

2. provider ကို ဖွင့်ပါ—

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Options

- `model`: Deepgram မော်ဒယ် ID (မူလတန်ဖိုး: `nova-3`)
- `language`: ဘာသာစကား အညွှန်း (ရွေးချယ်နိုင်)
- `tools.media.audio.providerOptions.deepgram.detect_language`: ဘာသာစကား ရှာဖွေသိရှိမှုကို ဖွင့်ရန် (ရွေးချယ်နိုင်)
- `tools.media.audio.providerOptions.deepgram.punctuate`: punctuation ကို ဖွင့်ရန် (ရွေးချယ်နိုင်)
- `tools.media.audio.providerOptions.deepgram.smart_format`: smart formatting ကို ဖွင့်ရန် (ရွေးချယ်နိုင်)

ဘာသာစကားဖြင့် ဥပမာ—

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Deepgram options များနှင့် ဥပမာ—

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Notes

- Authentication သည် ပံ့ပိုးသူများ၏ စံ auth အစီအစဉ်အတိုင်း လိုက်နာပြီး; `DEEPGRAM_API_KEY` သည် အလွယ်ကူဆုံး လမ်းကြောင်းဖြစ်သည်။
- proxy ကို အသုံးပြုသည့်အခါ `tools.media.audio.baseUrl` နှင့် `tools.media.audio.headers` ဖြင့် endpoint သို့မဟုတ် header များကို override လုပ်နိုင်သည်။
- Output သည် အခြား provider များကဲ့သို့ အသံဆိုင်ရာ စည်းမျဉ်းများ (အရွယ်အစား ကန့်သတ်ချက်များ၊ timeout များ၊ transcript ထည့်သွင်းမှု) ကို လိုက်နာသည်။
