---
summary: "ဝင်ရောက်လာသော အသံ/အသံမက်ဆေ့ချ်များကို ဒေါင်းလုဒ်လုပ်ခြင်း၊ စာသားပြောင်းခြင်း (transcribe) နှင့် ပြန်ကြားချက်များထဲသို့ ထည့်သွင်းပေးပို့ပုံ"
read_when:
  - အသံစာသားပြောင်းခြင်း သို့မဟုတ် မီဒီယာ ကိုင်တွယ်ပုံကို ပြောင်းလဲသည့်အခါ
title: "အသံနှင့် အသံမက်ဆေ့ချ်များ"
---

# အသံ / အသံမက်ဆေ့ချ်များ — 2026-01-17

## အလုပ်လုပ်ပြီးသား အချက်များ

- **မီဒီယာ နားလည်မှု (အသံ)**: အသံနားလည်မှုကို ဖွင့်ထားပါက (သို့မဟုတ် အလိုအလျောက် သိရှိပါက) OpenClaw သည် —
  1. ပထမဆုံး အသံ attachment ကို (local path သို့မဟုတ် URL) ရှာဖွေပြီး လိုအပ်ပါက ဒေါင်းလုဒ်လုပ်သည်။
  2. မော်ဒယ် entry တစ်ခုချင်းစီသို့ ပို့မည့်အခါ `maxBytes` ကို အတည်ပြုစစ်ဆေးသည်။
  3. အစီအစဉ်အလိုက် သင့်လျော်သော ပထမဆုံး မော်ဒယ် entry ကို (provider သို့မဟုတ် CLI) လည်ပတ်စေသည်။
  4. မအောင်မြင်ပါက သို့မဟုတ် ကျော်သွားပါက (အရွယ်အစား/အချိန်ကုန်ဆုံး) နောက် entry ကို စမ်းသပ်သည်။
  5. အောင်မြင်ပါက `Body` ကို `[Audio]` block ဖြင့် အစားထိုးပြီး `{{Transcript}}` ကို သတ်မှတ်သည်။
- **အမိန့် ခွဲခြမ်းစိတ်ဖြာခြင်း**: စာသားပြောင်းခြင်း အောင်မြင်သည့်အခါ `CommandBody`/`RawBody` ကို transcript ဖြင့် သတ်မှတ်ထားသဖြင့် slash commands များ ဆက်လက် အလုပ်လုပ်နိုင်သည်။
- **အသေးစိတ် မှတ်တမ်းရေးသားခြင်း**: `--verbose` တွင် စာသားပြောင်းခြင်း လုပ်ဆောင်ချိန်နှင့် body ကို အစားထိုးချိန်တို့ကို မှတ်တမ်းတင်ထားသည်။

## အလိုအလျောက် သိရှိခြင်း (မူလအတိုင်း)

သင်သည် **မော်ဒယ်များကို မဖွဲ့စည်းထားပါက** နှင့် `tools.media.audio.enabled` ကို `false` အဖြစ် **မသတ်မှတ်ထားပါက**,
OpenClaw သည် အောက်ပါ အစီအစဉ်အတိုင်း အလိုအလျောက် သိရှိစမ်းသပ်ပြီး ပထမဆုံး အလုပ်လုပ်သည့် ရွေးချယ်မှုတွင် ရပ်တန့်သည် —

1. **Local CLIs** (ထည့်သွင်းထားပါက)
   - `sherpa-onnx-offline` (`SHERPA_ONNX_MODEL_DIR` နှင့် encoder/decoder/joiner/tokens လိုအပ်)
   - `whisper-cli` (`whisper-cpp` မှ; `WHISPER_CPP_MODEL` သို့မဟုတ် bundled tiny model ကို အသုံးပြုသည်)
   - `whisper` (Python CLI; မော်ဒယ်များကို အလိုအလျောက် ဒေါင်းလုဒ်လုပ်သည်)
2. **Gemini CLI** (`gemini`) ကို `read_many_files` ဖြင့် အသုံးပြုခြင်း
3. **Provider keys** (OpenAI → Groq → Deepgram → Google)

auto-detection ကို ပိတ်ရန် `tools.media.audio.enabled: false` ကို သတ်မှတ်ပါ။
စိတ်ကြိုက်ပြင်ဆင်ရန် `tools.media.audio.models` ကို သတ်မှတ်ပါ။
မှတ်ချက်: binary detection သည် macOS/Linux/Windows အနှံ့ best‑effort ဖြစ်ပါသည်; CLI ကို `PATH` တွင် ရှိနေစေရန် (ကျွန်ုပ်တို့သည် `~` ကို ချဲ့ထွင်ပါသည်) သို့မဟုတ် CLI မော်ဒယ်ကို အပြည့်အစုံ command path ဖြင့် အတိအကျ သတ်မှတ်ပါ။

## Config ဥပမာများ

### Provider + CLI fallback (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### Provider-only (scope gating ပါရှိ)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### Provider-only (Deepgram)

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

## မှတ်ချက်များနှင့် ကန့်သတ်ချက်များ

- Provider authentication သည် မော်ဒယ် auth အစီအစဉ်အတိုင်း လိုက်နာသည် (auth profiles, env vars, `models.providers.*.apiKey`)။
- Deepgram သည် `provider: "deepgram"` ကို အသုံးပြုသောအခါ `DEEPGRAM_API_KEY` ကို ဖမ်းယူအသုံးပြုသည်။
- Deepgram setup အသေးစိတ်: [Deepgram (audio transcription)](/providers/deepgram)။
- Audio providers များသည် `tools.media.audio` မှတဆင့် `baseUrl`, `headers`, နှင့် `providerOptions` ကို override လုပ်နိုင်သည်။
- default size cap သည် 20MB ဖြစ်ပါသည် (`tools.media.audio.maxBytes`)။ အရွယ်အစားကြီးလွန်းသော audio များကို ထို model အတွက် ကျော်သွားပြီး နောက် entry ကို စမ်းသပ်ပါသည်။
- audio အတွက် default `maxChars` သည် **မသတ်မှတ်ထားပါ** (transcript အပြည့်အစုံ)။ output ကို လျှော့ချရန် `tools.media.audio.maxChars` သို့မဟုတ် per-entry `maxChars` ကို သတ်မှတ်ပါ။
- OpenAI ၏ အလိုအလျောက် မူလသတ်မှတ်ချက်မှာ `gpt-4o-mini-transcribe` ဖြစ်သည်; ပိုမိုတိကျစေရန် `model: "gpt-4o-transcribe"` ကို သတ်မှတ်ပါ။
- အသံမက်ဆေ့ချ်များ အများအပြားကို ကိုင်တွယ်ရန် `tools.media.audio.attachments` ကို အသုံးပြုပါ (`mode: "all"` + `maxAttachments`)။
- Transcript ကို template များတွင် `{{Transcript}}` အဖြစ် အသုံးပြုနိုင်သည်။
- CLI stdout ကို 5MB အထိသာ ခွင့်ပြုထားသည်; CLI အထွက်ကို ချုပ်ကိုင်ပြီး ရှင်းလင်းအောင် ထုတ်ပေးပါ။

## သတိပြုရန် အချက်များ

- Scope စည်းမျဉ်းများတွင် ပထမဆုံး ကိုက်ညီသည့်အရာကို ဦးစားပေးပါသည်။ `chatType` ကို `direct`, `group`, သို့မဟုတ် `room` ဟု normalize လုပ်ပါသည်။
- သင့် CLI သည် exit code 0 ဖြင့် အဆုံးသတ်ပြီး plain text ကို ထုတ်ပေးကြောင်း သေချာပါစေ; JSON ကို `jq -r .text` ဖြင့် ပြုပြင်ညှိနှိုင်းရပါမည်။
- အချိန်ကန့်သတ်ချက်များကို သင့်တင့်စွာ ထားပါ (`timeoutSeconds`, မူလ 60s) သို့မဟုတ် ပြန်ကြားချက် queue ကို ပိတ်ဆို့နိုင်ပါသည်။
