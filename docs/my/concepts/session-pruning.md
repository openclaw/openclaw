---
summary: "Session pruning: context ဖောင်းပွမှုကို လျှော့ချရန် tool ရလဒ်များကို ဖြတ်တောက်ခြင်း"
read_when:
  - tool output များကြောင့် LLM context ကြီးထွားမှုကို လျှော့ချချင်ပါက
  - agents.defaults.contextPruning ကို ချိန်ညှိနေပါက
x-i18n:
  source_path: concepts/session-pruning.md
  source_hash: 9b0aa2d1abea7050
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:25Z
---

# Session Pruning

Session pruning သည် LLM ကို ခေါ်မီ တစ်ကြိမ်ချင်းစီတွင် in-memory context ထဲရှိ **အဟောင်း tool ရလဒ်များ** ကို ဖြတ်တောက်ပေးသည်။ ၎င်းသည် on-disk session history ကို ပြန်ရေးခြင်း **မလုပ်ပါ** (`*.jsonl`)။

## မည်သည့်အချိန်တွင် လုပ်ဆောင်သနည်း

- `mode: "cache-ttl"` ကို ဖွင့်ထားပြီး session အတွက် နောက်ဆုံး Anthropic ခေါ်ဆိုမှုသည် `ttl` ထက် အဟောင်းဖြစ်ပါက။
- ထိုတောင်းဆိုမှုအတွက် မော်ဒယ်ထံ ပို့သည့် မက်ဆေ့ချ်များကိုသာ သက်ရောက်မှုရှိသည်။
- Anthropic API ခေါ်ဆိုမှုများ (နှင့် OpenRouter Anthropic မော်ဒယ်များ) အတွက်သာ အသက်ဝင်သည်။
- အကောင်းဆုံးရလဒ်အတွက် `ttl` ကို သင့်မော်ဒယ်၏ `cacheControlTtl` နှင့် ကိုက်ညီအောင် ချိန်ညှိပါ။
- prune လုပ်ပြီးနောက် TTL ဝင်းဒိုးသည် ပြန်လည် reset ဖြစ်သဖြင့် နောက်တစ်ဆင့် တောင်းဆိုမှုများသည် `ttl` ထပ်မံ မကုန်ဆုံးမချင်း cache ကို ဆက်လက် ထိန်းထားနိုင်သည်။

## Smart defaults (Anthropic)

- **OAuth သို့မဟုတ် setup-token** ပရိုဖိုင်များ: `cache-ttl` pruning ကို ဖွင့်ပြီး heartbeat ကို `1h` သို့ သတ်မှတ်သည်။
- **API key** ပရိုဖိုင်များ: `cache-ttl` pruning ကို ဖွင့်ပြီး heartbeat ကို `30m` သို့ သတ်မှတ်ကာ Anthropic မော်ဒယ်များတွင် ပုံမှန် `cacheControlTtl` ကို `1h` အဖြစ် သတ်မှတ်သည်။
- ဤတန်ဖိုးများထဲမှ မည်သည့်တစ်ခုကိုမဆို သင်က ကိုယ်တိုင် သတ်မှတ်ထားပါက OpenClaw သည် ၎င်းတို့ကို **မပြောင်းလဲပါ**။

## ဘာတွေကောင်းမွန်လာသလဲ (ကုန်ကျစရိတ် + cache အပြုအမူ)

- **ဘာကြောင့် prune လုပ်ရသလဲ:** Anthropic prompt caching သည် TTL အတွင်းသာ သက်ရောက်သည်။ Session တစ်ခုသည် TTL ကျော်လွန်ပြီး အလုပ်မလုပ်နေလျှင် နောက်တစ်ကြိမ် တောင်းဆိုမှုတွင် trim မလုပ်ထားပါက prompt အပြည့်အစုံကို ပြန်လည် cache လုပ်ရသည်။
- **ဘာတွေ စျေးချိုလာသလဲ:** pruning သည် TTL ကုန်ဆုံးပြီးနောက် ပထမဆုံး တောင်းဆိုမှုအတွက် **cacheWrite** အရွယ်အစားကို လျှော့ချပေးသည်။
- **TTL reset အရေးပါမှု:** pruning လုပ်ပြီးနောက် cache ဝင်းဒိုးသည် ပြန်လည် reset ဖြစ်သဖြင့် နောက်လိုက် တောင်းဆိုမှုများသည် အပြည့်အစုံကို ထပ်မံ cache မလုပ်ဘဲ အသစ် cache လုပ်ထားသည့် prompt ကို ပြန်အသုံးပြုနိုင်သည်။
- **မလုပ်ပေးသည့်အရာ:** pruning သည် token များကို မထည့်ပါ၊ ကုန်ကျစရိတ်ကိုလည်း “နှစ်ဆ” မလုပ်ပါ။ TTL ပြီးနောက် ပထမဆုံး တောင်းဆိုမှုတွင် ဘာကို cache လုပ်မလဲ ဆိုတာကိုသာ ပြောင်းလဲပေးသည်။

## ဖြတ်တောက်နိုင်သော အရာများ

- `toolResult` မက်ဆေ့ချ်များသာ။
- User + assistant မက်ဆေ့ချ်များကို **ဘယ်တော့မှ** မပြင်ဆင်ပါ။
- နောက်ဆုံး `keepLastAssistants` assistant မက်ဆေ့ချ်များကို ကာကွယ်ထားသည်။ ထို cutoff နောက်ပိုင်းရှိ tool ရလဒ်များကို မဖြတ်တောက်ပါ။
- cutoff ကို သတ်မှတ်နိုင်ရန် လုံလောက်သော assistant မက်ဆေ့ချ်များ မရှိပါက pruning ကို ကျော်သွားမည်။
- **image blocks** ပါဝင်သည့် tool ရလဒ်များကို ကျော်သွားမည် (မဖြတ်တောက်/မရှင်းလင်းပါ)။

## Context window ခန့်မှန်းခြင်း

Pruning သည် ခန့်မှန်း context window (chars ≈ tokens × 4) ကို အသုံးပြုသည်။ အခြေခံ window ကို အောက်ပါ အစဉ်အတိုင်း ဖြေရှင်းသည်—

1. `models.providers.*.models[].contextWindow` override။
2. မော်ဒယ် သတ်မှတ်ချက် `contextWindow` (model registry မှ)။
3. ပုံမှန် `200000` tokens။

`agents.defaults.contextTokens` ကို သတ်မှတ်ထားပါက ၎င်းကို ဖြေရှင်းထားသော window အပေါ် အကန့်အသတ် (min) အဖြစ် ထည့်သွင်းစဉ်းစားသည်။

## Mode

### cache-ttl

- နောက်ဆုံး Anthropic ခေါ်ဆိုမှုသည် `ttl` (ပုံမှန် `5m`) ထက် အဟောင်းဖြစ်ပါကသာ pruning လုပ်ဆောင်သည်။
- လုပ်ဆောင်သည့်အချိန်: ယခင်ကဲ့သို့ soft-trim + hard-clear အပြုအမူကို အသုံးပြုသည်။

## Soft နှင့် Hard pruning

- **Soft-trim**: အရွယ်အစားကြီးလွန်းသော tool ရလဒ်များအတွက်သာ။
  - အစပိုင်း + အဆုံးပိုင်းကို ထိန်းထားပြီး `...` ကို ထည့်သွင်းကာ မူရင်းအရွယ်အစားပါရှိကြောင်း မှတ်ချက်တစ်ခုကို ပူးတွဲသည်။
  - image blocks ပါသော ရလဒ်များကို ကျော်သွားသည်။
- **Hard-clear**: tool ရလဒ် အပြည့်အစုံကို `hardClear.placeholder` ဖြင့် အစားထိုးသည်။

## Tool ရွေးချယ်ခြင်း

- `tools.allow` / `tools.deny` သည် `*` wildcards များကို ပံ့ပိုးသည်။
- Deny သည် အနိုင်ရသည်။
- ကိုက်ညီမှုကို case မခွဲခြားဘဲ စစ်ဆေးသည်။
- allow list လွတ်နေပါက => tool အားလုံးကို ခွင့်ပြုသည်။

## အခြား အကန့်အသတ်များနှင့် အပြန်အလှန်သက်ရောက်မှု

- Built-in tool များသည် ကိုယ်တိုင် output ကို truncate လုပ်ပြီးသားဖြစ်သည်။ Session pruning သည် အပိုအလွှာတစ်ခုအဖြစ် အလုပ်လုပ်ပြီး အချိန်ကြာရှည် ဆွေးနွေးမှုများတွင် မော်ဒယ် context အတွင်း tool output များ များလွန်းစွာ စုပုံမသွားစေရန် ကာကွယ်ပေးသည်။
- Compaction သည် သီးခြားဖြစ်သည်—compaction သည် အကျဉ်းချုပ်ရေးပြီး သိမ်းဆည်းသည်၊ pruning သည် တောင်းဆိုမှုတစ်ကြိမ်ချင်းစီအတွက် ယာယီသာ ဖြစ်သည်။ [/concepts/compaction](/concepts/compaction) ကို ကြည့်ပါ။

## Defaults (ဖွင့်ထားသောအခါ)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## ဥပမာများ

ပုံမှန် (ပိတ်ထားသည်):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

TTL ကို သိရှိသည့် pruning ကို ဖွင့်ရန်:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

သီးသန့် tool များအတွက်သာ pruning ကို ကန့်သတ်ရန်:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Config ကိုးကားချက်ကို ကြည့်ရန်: [Gateway Configuration](/gateway/configuration)
