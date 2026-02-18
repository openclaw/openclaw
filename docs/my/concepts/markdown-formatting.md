---
summary: "ထွက်သွားသော ချန်နယ်များအတွက် Markdown ဖော်မတ်ချခြင်း လမ်းကြောင်း"
read_when:
  - သင်သည် ထွက်သွားသော ချန်နယ်များအတွက် Markdown ဖော်မတ်ချခြင်း သို့မဟုတ် chunking ကို ပြောင်းလဲနေပါက
  - ချန်နယ် formatter အသစ် သို့မဟုတ် style mapping အသစ် ထည့်သွင်းနေပါက
  - ချန်နယ်များအကြား ဖော်မတ်ချခြင်း regression များကို စစ်ဆေးနေပါက
title: "Markdown ဖော်မတ်ချခြင်း"
---

# Markdown ဖော်မတ်ချခြင်း

23. OpenClaw သည် outbound Markdown ကို rendering မလုပ်မီ shared intermediate representation (IR) သို့ ပြောင်းလဲခြင်းဖြင့် format လုပ်ပါသည်။ 24. IR သည် source text ကို မပြောင်းလဲဘဲ ထိန်းထားပြီး style/link spans များကို သယ်ဆောင်ထားသဖြင့် chunking နှင့် rendering ကို channel များအကြား တူညီစွာ ထိန်းထားနိုင်ပါသည်။

## ရည်မှန်းချက်များ

- **တသမတ်တည်းဖြစ်မှု:** parse တစ်ကြိမ်၊ renderer များစွာ။
- **လုံခြုံသော chunking:** inline ဖော်မတ်ချခြင်း မပြတ်တောက်စေရန် rendering မတိုင်မီ စာသားကို ခွဲခြားသည်။
- **ချန်နယ်ကိုက်ညီမှု:** Markdown ကို ပြန်လည် parse မလုပ်ဘဲ တူညီသော IR ကို Slack mrkdwn၊ Telegram HTML နှင့် Signal style range များသို့ mapping လုပ်သည်။

## Pipeline

1. **Markdown ကို Parse -> IR**
   - IR သည် စာသားသန့် (plain text) နှင့် style span များ (bold/italic/strike/code/spoiler) နှင့် link span များပါဝင်သည်။
   - Offset များကို UTF-16 code unit အဖြစ် အသုံးပြုထားသဖြင့် Signal style range များသည် ၎င်း၏ API နှင့် ကိုက်ညီသည်။
   - Table များကို ချန်နယ်တစ်ခုက table conversion ကို ရွေးချယ်မှသာ parse လုပ်သည်။
2. **IR ကို Chunk လုပ်ခြင်း (format-first)**
   - Chunking ကို rendering မတိုင်မီ IR စာသားပေါ်တွင် ပြုလုပ်သည်။
   - Inline ဖော်မတ်ချခြင်းများသည် chunk များအကြား မပြတ်တောက်ဘဲ span များကို chunk အလိုက် ဖြတ်တောက်ထားသည်။
3. **ချန်နယ်အလိုက် Render**
   - **Slack:** mrkdwn token များ (bold/italic/strike/code)၊ link များကို `<url|label>` အဖြစ်။
   - **Telegram:** HTML tag များ (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`)။
   - **Signal:** plain text + `text-style` range များ; label မတူလျှင် link များကို `label (url)` အဖြစ် ပြောင်းလဲသည်။

## IR ဥပမာ

Input Markdown:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (schematic):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## အသုံးပြုရာနေရာများ

- Slack၊ Telegram နှင့် Signal ထွက်သွားသော adapter များသည် IR မှ render လုပ်သည်။
- အခြား ချန်နယ်များ (WhatsApp၊ iMessage၊ MS Teams၊ Discord) သည် plain text သို့မဟုတ် ၎င်းတို့၏ ကိုယ်ပိုင် ဖော်မတ်ချခြင်း စည်းမျဉ်းများကို အသုံးပြုနေဆဲဖြစ်ပြီး enable လုပ်ထားပါက Markdown table conversion ကို chunking မတိုင်မီ အသုံးပြုသည်။

## Table ကို ကိုင်တွယ်ခြင်း

25. Markdown tables များကို chat clients အားလုံးတွင် တူညီစွာ မထောက်ပံ့နိုင်ပါ။ 26. Channel တစ်ခုချင်းစီ (နှင့် account တစ်ခုချင်းစီ) အလိုက် conversion ကို ထိန်းချုပ်ရန် `markdown.tables` ကို အသုံးပြုပါ။

- `code`: table များကို code block အဖြစ် render လုပ်သည် (ချန်နယ်အများစုအတွက် မူလအခြေအနေ)။
- `bullets`: row တစ်ခုချင်းစီကို bullet point များအဖြစ် ပြောင်းလဲသည် (Signal + WhatsApp အတွက် မူလအခြေအနေ)။
- `off`: table parsing နှင့် conversion ကို ပိတ်ထားသည်; raw table စာသားကို တိုက်ရိုက် ဖြတ်သန်းပို့ဆောင်သည်။

Config key များ:

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## Chunking စည်းမျဉ်းများ

- Chunk အရွယ်အစား ကန့်သတ်ချက်များကို ချန်နယ် adapter များ/ဖွဲ့စည်းပြင်ဆင်မှုများမှ ရယူပြီး IR စာသားပေါ်တွင် အသုံးချသည်။
- Code fence များကို နောက်ဆုံး newline ပါသော block တစ်ခုအဖြစ် ထိန်းသိမ်းထားသဖြင့် ချန်နယ်များက မှန်ကန်စွာ render လုပ်နိုင်သည်။
- List prefix များနှင့် blockquote prefix များသည် IR စာသား၏ အစိတ်အပိုင်းများဖြစ်သောကြောင့် chunking သည် prefix အလယ်တွင် မဖြတ်တောက်ပါ။
- Inline style များ (bold/italic/strike/inline-code/spoiler) ကို chunk များအကြား မဖြတ်တောက်ပါ; renderer သည် chunk တစ်ခုချင်းစီအတွင်း style များကို ပြန်ဖွင့်သည်။

ချန်နယ်များအကြား chunking အပြုအမူများအကြောင်း ပိုမိုသိရှိလိုပါက
[Streaming + chunking](/concepts/streaming) ကို ကြည့်ပါ။

## Link မူဝါဒ

- 27. **Slack:** `[label](url)` -> `<url|label>`; bare URLs များသည် bare အဖြစ်ပဲ ကျန်နေပါသည်။ 28. Double-linking မဖြစ်စေရန် parse လုပ်စဉ်တွင် Autolink ကို ပိတ်ထားပါသည်။
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML parse mode)။
- **Signal:** `[label](url)` -> `label (url)` (label သည် URL နှင့် ကိုက်ညီပါက မပြောင်းလဲပါ)။

## Spoiler များ

29. Spoiler markers (`||spoiler||`) များကို Signal အတွက်သာ parse လုပ်ပြီး၊ ထိုနေရာတွင် SPOILER style ranges အဖြစ် map လုပ်ပါသည်။ 30. အခြား channel များတွင် ၎င်းတို့ကို plain text အဖြစ်သာ ကိုင်တွယ်ပါသည်။

## ချန်နယ် formatter ကို ထည့်သွင်း သို့မဟုတ် အပ်ဒိတ်လုပ်နည်း

1. **တစ်ကြိမ်တည်း Parse:** ချန်နယ်နှင့် ကိုက်ညီသော option များ (autolink၊ heading style၊ blockquote prefix) ဖြင့် မျှဝေထားသော `markdownToIR(...)` helper ကို အသုံးပြုပါ။
2. **Render:** `renderMarkdownWithMarkers(...)` နှင့် style marker map (သို့မဟုတ် Signal style range များ) ဖြင့် renderer တစ်ခုကို အကောင်အထည်ဖော်ပါ။
3. **Chunk:** rendering မတိုင်မီ `chunkMarkdownIR(...)` ကို ခေါ်ပြီး chunk တစ်ခုချင်းစီကို render လုပ်ပါ။
4. **Adapter ကို ချိတ်ဆက်:** ချန်နယ် ထွက်သွားသော adapter ကို chunker နှင့် renderer အသစ်ကို အသုံးပြု하도록 အပ်ဒိတ်လုပ်ပါ။
5. **စမ်းသပ်:** ဖော်မတ် စမ်းသပ်မှုများနှင့် (chunking ကို အသုံးပြုပါက) ထွက်သွားသော ပို့ဆောင်မှု စမ်းသပ်မှု တစ်ခုကို ထည့်သွင်း သို့မဟုတ် အပ်ဒိတ်လုပ်ပါ။

## မကြာခဏ ကြုံတွေ့ရသော အမှားများ

- Slack angle-bracket token များ (`<@U123>`, `<#C123>`, `<https://...>`) ကို မပျောက်မယှက် ထိန်းသိမ်းရမည်; raw HTML ကို လုံခြုံစွာ escape လုပ်ပါ။
- Telegram HTML တွင် tag အပြင်ဘက်ရှိ စာသားများကို escape မလုပ်ပါက markup ပျက်နိုင်သည်။
- Signal style range များသည် UTF-16 offset များအပေါ် မူတည်သည်; code point offset များကို မအသုံးပြုပါ။
- Fenced code block များအတွက် နောက်ဆုံး newline ကို ထိန်းသိမ်းထားပါ၊ ပိတ်သိမ်း marker များသည် ကိုယ်ပိုင်လိုင်းပေါ်တွင် ကျရောက်စေရန်။
