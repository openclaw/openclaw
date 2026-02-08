---
summary: "ကိုးကားချက်: ပံ့ပိုးသူအလိုက် transcript သန့်စင်ခြင်းနှင့် ပြုပြင်ခြင်း စည်းမျဉ်းများ"
read_when:
  - Transcript ပုံသဏ္ဍာန်နှင့် ဆက်စပ်သော ပံ့ပိုးသူ၏ တောင်းဆိုချက် ငြင်းပယ်မှုများကို ချွတ်ယွင်းချက်ရှာဖွေနေစဉ်
  - Transcript သန့်စင်ခြင်း သို့မဟုတ် tool-call ပြုပြင်ရေး လိုဂျစ်ကို ပြောင်းလဲနေစဉ်
  - ပံ့ပိုးသူများအကြား tool-call id မကိုက်ညီမှုများကို စုံစမ်းနေစဉ်
title: "Transcript Hygiene"
x-i18n:
  source_path: reference/transcript-hygiene.md
  source_hash: 43ed460827d514a8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:09Z
---

# Transcript Hygiene (Provider Fixups)

ဤစာရွက်စာတမ်းသည် run မတိုင်မီ (model context တည်ဆောက်ခြင်းအတွက်) transcript များအပေါ် **ပံ့ပိုးသူအလိုက် ပြုပြင်ချက်များ** ကို ဖော်ပြထားသည်။ ဤအရာများသည် ပံ့ပိုးသူ၏ တင်းကျပ်သော လိုအပ်ချက်များကို ဖြည့်ဆည်းရန် အသုံးပြုသော **မှတ်ဉာဏ်အတွင်း (in-memory)** ပြင်ဆင်ချက်များဖြစ်သည်။ ဤ hygiene အဆင့်များသည် disk ပေါ်ရှိ သိမ်းဆည်းထားသော JSONL transcript ကို **ပြန်ရေးမည်မဟုတ်ပါ**။ သို့သော် session ကို load မလုပ်မီ သီးခြား session-file ပြုပြင်ရေး အဆင့်တစ်ခုတွင် မမှန်ကန်သော JSONL ဖိုင်များကို မမှန်သော လိုင်းများကို ဖယ်ရှားခြင်းဖြင့် ပြန်ရေးနိုင်သည်။ ပြုပြင်မှု ဖြစ်ပေါ်ပါက မူရင်းဖိုင်ကို session ဖိုင်နှင့်အတူ အရန်အဖြစ် သိမ်းဆည်းထားသည်။

အကျယ်အဝန်းတွင် ပါဝင်သည့်အရာများမှာ—

- Tool call id သန့်စင်ခြင်း
- Tool call input အတည်ပြုခြင်း
- Tool result ချိတ်ဆက်မှု ပြုပြင်ခြင်း
- Turn အတည်ပြုခြင်း / အစဉ်လိုက်စီစဉ်ခြင်း
- Thought signature သန့်ရှင်းရေး
- Image payload သန့်စင်ခြင်း

Transcript သိမ်းဆည်းမှု အသေးစိတ်များ လိုအပ်ပါက—

- [/reference/session-management-compaction](/reference/session-management-compaction)

ကို ကြည့်ရှုပါ။

---

## Where this runs

Transcript hygiene အားလုံးကို embedded runner အတွင်း ဗဟိုပြုထားသည်—

- Policy ရွေးချယ်ခြင်း: `src/agents/transcript-policy.ts`
- သန့်စင်ခြင်း/ပြုပြင်ခြင်း လုပ်ဆောင်ခြင်း: `sanitizeSessionHistory` ကို `src/agents/pi-embedded-runner/google.ts` အတွင်း

Policy သည် ဘာတွေကို အသုံးချမလဲ ဆုံးဖြတ်ရန် `provider`, `modelApi`, နှင့် `modelId` ကို အသုံးပြုသည်။

Transcript hygiene နှင့် သီးခြားအနေဖြင့် session ဖိုင်များကို load မလုပ်မီ (လိုအပ်ပါက) ပြုပြင်သည်—

- `repairSessionFileIfNeeded` ကို `src/agents/session-file-repair.ts` အတွင်း
- `run/attempt.ts` နှင့် `compact.ts` (embedded runner) မှ ခေါ်သုံးသည်

---

## Global rule: image sanitization

Image payload များကို အရွယ်အစား ကန့်သတ်ချက်များကြောင့် ပံ့ပိုးသူဘက်မှ ငြင်းပယ်ခြင်း မဖြစ်စေရန် အမြဲ သန့်စင်ထားသည် (အလွန်ကြီးမားသော base64 image များကို downscale/recompress ပြုလုပ်သည်)။

Implementation:

- `sanitizeSessionMessagesImages` ကို `src/agents/pi-embedded-helpers/images.ts` အတွင်း
- `sanitizeContentBlocksImages` ကို `src/agents/tool-images.ts` အတွင်း

---

## Global rule: malformed tool calls

`input` နှင့် `arguments` နှစ်ခုလုံး မပါရှိသော Assistant tool-call block များကို model context တည်ဆောက်မတိုင်မီ ဖယ်ရှားသည်။ ၎င်းသည် အပိုင်းပိုင်းသာ သိမ်းဆည်းထားသော tool call များ (ဥပမာ rate limit ပျက်ကွက်ပြီးနောက်) ကြောင့် ပံ့ပိုးသူ ငြင်းပယ်မှုများ မဖြစ်စေရန် ကာကွယ်ပေးသည်။

Implementation:

- `sanitizeToolCallInputs` ကို `src/agents/session-transcript-repair.ts` အတွင်း
- `sanitizeSessionHistory` ကို `src/agents/pi-embedded-runner/google.ts` အတွင်း အသုံးချသည်

---

## Provider matrix (current behavior)

**OpenAI / OpenAI Codex**

- Image သန့်စင်ခြင်းသာ။
- OpenAI Responses/Codex သို့ model ပြောင်းသည့်အခါ၊ နောက်ဆက်တွဲ content block မပါရှိသော orphaned reasoning signature များ (သီးခြား reasoning item များ) ကို ဖယ်ရှားသည်။
- Tool call id သန့်စင်ခြင်း မရှိ။
- Tool result ချိတ်ဆက်မှု ပြုပြင်ခြင်း မရှိ။
- Turn အတည်ပြုခြင်း သို့မဟုတ် အစဉ်လိုက်စီစဉ်ခြင်း မရှိ။
- Synthetic tool result မရှိ။
- Thought signature ဖြုတ်ထုတ်ခြင်း မရှိ။

**Google (Generative AI / Gemini CLI / Antigravity)**

- Tool call id သန့်စင်ခြင်း: အက္ခရာ-ကိန်းဂဏန်း သီးသန့် (strict alphanumeric)။
- Tool result ချိတ်ဆက်မှု ပြုပြင်ခြင်းနှင့် synthetic tool result များ။
- Turn အတည်ပြုခြင်း (Gemini စတိုင် turn အလှည့်အပြောင်း)။
- Google turn ordering ပြုပြင်ချက် (history ကို assistant ဖြင့် စတင်ပါက အသုံးပြုသူ bootstrap သေးငယ်တစ်ခုကို ရှေ့တွင် ထည့်သွင်းသည်)။
- Antigravity Claude: thinking signature များကို normalize ပြုလုပ်ပြီး လက်မှတ်မပါသော thinking block များကို ဖယ်ရှားသည်။

**Anthropic / Minimax (Anthropic-compatible)**

- Tool result ချိတ်ဆက်မှု ပြုပြင်ခြင်းနှင့် synthetic tool result များ။
- Turn အတည်ပြုခြင်း (တင်းကျပ်သော အလှည့်အပြောင်းကို ဖြည့်ဆည်းရန် ဆက်တိုက် user turn များကို ပေါင်းစည်းသည်)။

**Mistral (model-id အခြေပြု ရှာဖွေတွေ့ရှိမှု အပါအဝင်)**

- Tool call id သန့်စင်ခြင်း: strict9 (အက္ခရာ-ကိန်းဂဏန်း အရှည် 9)။

**OpenRouter Gemini**

- Thought signature သန့်ရှင်းရေး: base64 မဟုတ်သော `thought_signature` တန်ဖိုးများကို ဖယ်ရှားပြီး base64 ကိုသာ ထားရှိသည်။

**Everything else**

- Image သန့်စင်ခြင်းသာ။

---

## Historical behavior (pre-2026.1.22)

2026.1.22 ထုတ်ဝေမှု မတိုင်မီ OpenClaw သည် transcript hygiene အလွှာများစွာကို အသုံးချခဲ့သည်—

- **transcript-sanitize extension** တစ်ခုသည် context တည်ဆောက်မှုတိုင်းတွင် chạy လုပ်ပြီး အောက်ပါအရာများကို လုပ်ဆောင်နိုင်ခဲ့သည်—
  - Tool use/result ချိတ်ဆက်မှုကို ပြုပြင်ခြင်း။
  - Tool call id များကို သန့်စင်ခြင်း ( `_`/`-` ကို ထိန်းသိမ်းထားသော non-strict မုဒ် အပါအဝင်)။
- Runner သည်လည်း ပံ့ပိုးသူအလိုက် သန့်စင်မှုများကို လုပ်ဆောင်ပြီး အလုပ်ထပ်နေမှုများ ဖြစ်ပေါ်ခဲ့သည်။
- Provider policy အပြင်ဘက်တွင် ထပ်မံ ပြောင်းလဲမှုများ ဖြစ်ပေါ်ခဲ့ပြီး—
  - သိမ်းဆည်းမည့်အခါ assistant စာသားမှ `<final>` tag များကို ဖြုတ်ထုတ်ခြင်း။
  - အလွတ် assistant error turn များကို ဖယ်ရှားခြင်း။
  - Tool call ပြီးနောက် assistant content ကို ဖြတ်တောက်ခြင်း။

ဤရှုပ်ထွေးမှုကြောင့် ပံ့ပိုးသူအကြား regression များ ဖြစ်ပေါ်ခဲ့သည် (အထူးသဖြင့် `openai-responses`
`call_id|fc_id` ချိတ်ဆက်မှု)။ 2026.1.22 သန့်ရှင်းရေးတွင် extension ကို ဖယ်ရှားပြီး လိုဂျစ်ကို runner အတွင်း ဗဟိုပြုခဲ့ကာ OpenAI ကို image သန့်စင်ခြင်းအပြင် **no-touch** အဖြစ် သတ်မှတ်하였다။
