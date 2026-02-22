---
summary: "စီးဆင်းပို့ဆောင်ခြင်း + ချန့်ခွဲခြင်း အပြုအမူများ (ဘလောက်ဖြင့် ပြန်ကြားမှုများ၊ မူကြမ်း စီးဆင်းပို့ဆောင်မှု၊ ကန့်သတ်ချက်များ)"
read_when:
  - ချန်နယ်များပေါ်တွင် စီးဆင်းပို့ဆောင်မှု သို့မဟုတ် ချန့်ခွဲခြင်း ဘယ်လို အလုပ်လုပ်သည်ကို ရှင်းပြရာတွင်
  - block streaming သို့မဟုတ် channel chunking အပြုအမူကို ပြောင်းလဲရာတွင်
  - ထပ်နေသော/အလွန်စောသော ဘလောက် ပြန်ကြားမှုများ သို့မဟုတ် မူကြမ်း စီးဆင်းပို့ဆောင်မှုကို စစ်ဆေးပြင်ဆင်ရာတွင်
title: "စီးဆင်းပို့ဆောင်ခြင်း နှင့် ချန့်ခွဲခြင်း"
---

# စီးဆင်းပို့ဆောင်ခြင်း + ချန့်ခွဲခြင်း

OpenClaw တွင် သီးခြား “စီးဆင်းပို့ဆောင်မှု” အလွှာ ၂ ခု ရှိသည်–

- **Block streaming (channels):** အကူအညီပေးသူ ရေးသားနေစဉ် ပြီးစီးပြီးသား **block** များကို ထုတ်ပေးပါ။ ဤသည်များမှာ ပုံမှန် ချန်နယ် မက်ဆေ့ချ်များ ဖြစ်ပြီး (token deltas မဟုတ်ပါ)။
- **Token-ish streaming (Telegram သာ):** စာသား ထုတ်လုပ်နေစဉ် **draft bubble** ကို အစိတ်အပိုင်း စာသားဖြင့် အပ်ဒိတ်လုပ်ပေးပြီး အဆုံးတွင် နောက်ဆုံး မက်ဆေ့ချ်ကို ပို့သည်။

ယနေ့အချိန်တွင် ပြင်ပ ချန်နယ် မက်ဆေ့ချ်များသို့ **အမှန်တကယ် တိုကင် streaming မရှိပါ**။ Telegram draft streaming သည် တစ်စိတ်တစ်ပိုင်း streaming လုပ်နိုင်သော တစ်ခုတည်းသော မျက်နှာပြင်ဖြစ်သည်။

## Block streaming (ချန်နယ် မက်ဆေ့ချ်များ)

Block streaming သည် ရရှိလာသလို အကူအညီပေးသူ၏ အထွက်ကို ကြမ်းတမ်းသည့် ချန့်ခွဲမှုများဖြင့် ပို့ပေးသည်။

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: မော်ဒယ် စီးဆင်းပို့ဆောင်မှု ဖြစ်ရပ်များ (streaming မလုပ်သော မော်ဒယ်များအတွက် အနည်းငယ်သာ ဖြစ်နိုင်သည်)။
- `chunker`: အနိမ့်/အမြင့် ကန့်သတ်ချက်များ နှင့် ချိုးခွဲ အလေးထားမှုကို အသုံးချသည့် `EmbeddedBlockChunker`။
- `channel send`: အပြင်ဘက်သို့ ပို့သော မက်ဆေ့ချ်များ (block replies)။

**ထိန်းချုပ်မှုများ:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (မူလအခြေအနေ ပိတ်ထားသည်)။
- ချန်နယ်အလိုက် override များ: `*.blockStreaming` (နှင့် အကောင့်အလိုက် မူကွဲများ) ဖြင့် ချန်နယ်တစ်ခုချင်းစီအလိုက် `"on"`/`"off"` ကို အတင်းအကျပ် သတ်မှတ်နိုင်သည်။
- `agents.defaults.blockStreamingBreak`: `"text_end"` သို့မဟုတ် `"message_end"`။
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`။
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (ပို့မည့်အချိန်မတိုင်မီ streamed blocks များကို ပေါင်းစည်းသည်)။
- ချန်နယ် အမြင့်ဆုံး ကန့်သတ်ချက်: `*.textChunkLimit` (ဥပမာ၊ `channels.whatsapp.textChunkLimit`)။
- ချန်နယ် ချန့်ခွဲမှု မုဒ်: `*.chunkMode` (`length` မူလအဖြစ်၊ `newline` သည် အရှည်အလိုက် ချန့်ခွဲမတိုင်မီ လွတ်နေသော လိုင်းများ (စာပိုဒ်နယ်နိမိတ်များ) တွင် ခွဲသည်)။
- Discord soft cap: `channels.discord.maxLinesPerMessage` (မူလ 17) သည် UI ဖြတ်တောက်မှုကို ရှောင်ရန် အလွန်ရှည်သော ပြန်ကြားမှုများကို ခွဲပေးသည်။

**နယ်နိမိတ် အဓိပ္ပါယ်များ:**

- `text_end`: chunker က ထုတ်ပေးသလို ချက်ချင်း ဘလောက်များကို စီးဆင်းပို့ဆောင်ပြီး `text_end` တစ်ခုချင်းစီတွင် flush လုပ်သည်။
- `message_end`: အကူအညီပေးသူ၏ မက်ဆေ့ချ် ပြီးဆုံးသည်အထိ စောင့်ပြီး ထို့နောက် buffer ထားထားသမျှကို flush လုပ်သည်။

`message_end` သည် buffer ထဲရှိ စာသားသည် `maxChars` ကို ကျော်လွန်ပါက chunker ကို ဆက်လက် အသုံးပြုနေဆဲဖြစ်ပြီး အဆုံးတွင် ချန့်ခွဲမှုများ များစွာ ထုတ်နိုင်သည်။

## Chunking အယ်လ်ဂိုရစ်သမ် (အနိမ့်/အမြင့် ကန့်သတ်ချက်များ)

Block chunking ကို `EmbeddedBlockChunker` ဖြင့် အကောင်အထည်ဖော်ထားသည်–

- **အနိမ့် ကန့်သတ်ချက်:** buffer >= `minChars` မရောက်မချင်း မထုတ်ပါ (အတင်းအကျပ် မလုပ်လျှင်)။
- **အမြင့် ကန့်သတ်ချက်:** `maxChars` မတိုင်မီ ခွဲရန် ဦးစားပေးသည်၊ အတင်းအကျပ် ဖြစ်ပါက `maxChars` တွင် ခွဲသည်။
- **ချိုးခွဲ အလေးထားမှု:** `paragraph` → `newline` → `sentence` → `whitespace` → hard break။
- **Code fences:** fence အတွင်းတွင် မခွဲပါ။ `maxChars` တွင် အတင်းအကျပ် ခွဲရပါက Markdown မှန်ကန်စေရန် fence ကို ပိတ်ပြီး ပြန်ဖွင့်သည်။

`maxChars` ကို ချန်နယ်၏ `textChunkLimit` အတွင်းသို့ clamp လုပ်ထားသောကြောင့် ချန်နယ်တစ်ခုချင်းစီ၏ အမြင့်ဆုံး ကန့်သတ်ချက်ကို မကျော်နိုင်ပါ။

## Coalescing (စီးဆင်းလာသော ဘလောက်များကို ပေါင်းစည်း)

block streaming ကို ဖွင့်ထားသောအခါ OpenClaw သည် ပို့မီ **ဆက်တိုက် block chunk များကို ပေါင်းစည်း** နိုင်သည်။ ဤအရာသည် တစ်ကြောင်းချင်း စပမ်များကို လျော့ချပြီး တိုးတက်လာသော ထုတ်လွှတ်မှုကို ဆက်လက် ပေးစွမ်းနိုင်သည်။

- Coalescing သည် **အလုပ်မလုပ်သော အကြားကာလများ** (`idleMs`) ကို စောင့်ပြီး flush လုပ်သည်။
- Buffer များကို `maxChars` ဖြင့် ကန့်သတ်ထားပြီး ၎င်းကို ကျော်လွန်ပါက flush လုပ်မည်ဖြစ်သည်။
- `minChars` သည် စာသား အလုံအလောက် မစုမချင်း အလွန်သေးငယ်သော အပိုင်းအစများကို မပို့စေရန် တားဆီးသည်
  (နောက်ဆုံး flush တွင် ကျန်ရှိသမျှကို အမြဲ ပို့သည်)။
- Joiner ကို `blockStreamingChunk.breakPreference` မှ ဆင်းသက်ထားသည်
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → space)။
- ချန်နယ်အလိုက် override များကို `*.blockStreamingCoalesce` မှတစ်ဆင့် ရရှိနိုင်သည် (အကောင့်အလိုက် ဖွဲ့စည်းမှုများ ပါဝင်)။
- မူလ coalesce `minChars` ကို Signal/Slack/Discord အတွက် override မရှိပါက 1500 သို့ မြှင့်ထားသည်။

## ဘလောက်များအကြား လူသားတူ အချိန်ညှိခြင်း

block streaming ဖွင့်ထားသောအခါ (ပထမ block အပြီး) block ပြန်စာများအကြား **ကျပန်းအနားယူချိန်** ကို ထည့်နိုင်သည်။ ဤအရာသည် bubble များစွာပါသော ပြန်စာများကို ပိုမို သဘာဝကျစေသည်။

- Config: `agents.defaults.humanDelay` (အေးဂျင့်အလိုက် `agents.list[].humanDelay` ဖြင့် override)။
- မုဒ်များ: `off` (မူလ), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`)။
- **block replies** များအတွက်သာ သက်ရောက်ပြီး နောက်ဆုံး ပြန်ကြားမှုများ သို့မဟုတ် tool summary များအတွက် မသက်ရောက်ပါ။

## “Chunk များကို စီးဆင်းပို့မလား၊ အားလုံးကို တစ်ခါတည်းလား”

ဤသည်တို့နှင့် ကိုက်ညီသည်–

- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (ရေးသားသလို ထုတ်ပေးသည်)။ Telegram မဟုတ်သော ချန်နယ်များတွင်လည်း `*.blockStreaming: true` လိုအပ်သည်။
- **အဆုံးတွင် အားလုံးကို စီးဆင်းပို့:** `blockStreamingBreak: "message_end"` (တစ်ကြိမ်သာ flush လုပ်ပြီး အလွန်ရှည်ပါက chunk များစွာ ဖြစ်နိုင်သည်)။
- **Block streaming မရှိ:** `blockStreamingDefault: "off"` (နောက်ဆုံး ပြန်ကြားမှုသာ)။

**Channel မှတ်စု:** Telegram မဟုတ်သော ချန်နယ်များအတွက် `*.blockStreaming` ကို `true` ဟု တိတိကျကျ မသတ်မှတ်ထားပါက block streaming ကို **ပိတ်ထားသည်**။ Telegram သည် block ပြန်စာများ မပါဘဲ draft များကို (`channels.telegram.streamMode`) streaming လုပ်နိုင်သည်။

Config တည်နေရာ သတိပေးချက်: `blockStreaming*` မူလတန်ဖိုးများသည် root config မဟုတ်ဘဲ
`agents.defaults` အောက်တွင် ရှိသည်။

## Telegram draft streaming (token-ish)

Telegram သည် draft streaming ရှိသော တစ်ခုတည်းသော ချန်နယ်ဖြစ်သည်–

- **private chats with topics** တွင် Bot API `sendMessageDraft` ကို အသုံးပြုသည်။
- `channels.telegram.streamMode: "partial" | "block" | "off"`။
  - `partial`: နောက်ဆုံး stream စာသားဖြင့် draft အပ်ဒိတ်များ။
  - `block`: chunked blocks ဖြင့် draft အပ်ဒိတ်များ (တူညီသော chunker စည်းမျဉ်းများ)။
  - `off`: draft streaming မရှိ။
- Draft chunk config (`streamMode: "block"` အတွက်သာ): `channels.telegram.draftChunk` (မူလတန်ဖိုးများ: `minChars: 200`, `maxChars: 800`)။
- Draft streaming သည် block streaming နှင့် သီးခြားဖြစ်ပြီး block replies များကို မူလအဖြစ် ပိတ်ထားသည်။ Telegram မဟုတ်သော ချန်နယ်များတွင် `*.blockStreaming: true` ဖြင့်သာ ဖွင့်နိုင်သည်။
- နောက်ဆုံး ပြန်ကြားမှုသည် ပုံမှန် မက်ဆေ့ချ် တစ်ခု ဖြစ်နေဆဲဖြစ်သည်။
- `/reasoning stream` သည် reasoning ကို draft bubble အတွင်းသို့ ရေးသားသည် (Telegram သာ)။

Draft streaming လုပ်ဆောင်နေစဉ် OpenClaw သည် double-streaming မဖြစ်စေရန် အဆိုပါ ပြန်ကြားမှုအတွက် block streaming ကို ပိတ်ထားသည်။

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legend:

- `sendMessageDraft`: Telegram draft bubble (တကယ့် မက်ဆေ့ချ် မဟုတ်ပါ)။
- `final reply`: ပုံမှန် Telegram မက်ဆေ့ချ် ပို့ခြင်း။
