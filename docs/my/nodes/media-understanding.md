---
summary: "ဝင်လာသော ရုပ်ပုံ/အသံ/ဗီဒီယိုကို နားလည်မှု (ရွေးချယ်နိုင်) ကို provider + CLI fallback များဖြင့် ပံ့ပိုးခြင်း"
read_when:
  - မီဒီယာနားလည်မှုကို ဒီဇိုင်းဆွဲခြင်း သို့မဟုတ် ပြန်လည်ဖွဲ့စည်းခြင်း ပြုလုပ်နေချိန်
  - ဝင်လာသော အသံ/ဗီဒီယို/ရုပ်ပုံ အကြိုလုပ်ဆောင်မှုများကို ချိန်ညှိနေချိန်
title: "မီဒီယာ နားလည်မှု"
---

# မီဒီယာ နားလည်မှု (ဝင်လာသော) — 2026-01-17

35. local tools သို့မဟုတ် provider keys ရရှိနိုင်ပါက auto-detect လုပ်ပြီး disable လုပ်ခြင်း သို့မဟုတ် customize လုပ်ခြင်းကို လုပ်နိုင်သည်။ 36. understanding ကို ပိတ်ထားပါက model များသည် မူရင်း files/URLs များကို ပုံမှန်အတိုင်း ဆက်လက်လက်ခံရရှိမည်ဖြစ်သည်။ 37. `prompt` သည် default အနေဖြင့် “Describe the {media}.” ကို အသုံးပြုပြီး `maxChars` guidance (image/video only) ကို ပေါင်းထည့်ထားသည်။

## ရည်မှန်းချက်များ

- ရွေးချယ်နိုင်သည်: လမ်းကြောင်းရွေးချယ်မှု မြန်ဆန်စေရန်နှင့် အမိန့်ခွဲခြမ်းစိတ်ဖြာမှု ပိုမိုကောင်းမွန်စေရန် ဝင်လာသော မီဒီယာကို စာသားတိုအဖြစ် ကြိုတင်ချေဖျက်ခြင်း။
- မူလ မီဒီယာကို မော်ဒယ်သို့ ပေးပို့ခြင်းကို ထိန်းသိမ်းထားခြင်း (အမြဲတမ်း)။
- **provider API များ** နှင့် **CLI fallback များ** ကို ပံ့ပိုးခြင်း။
- မော်ဒယ်များစွာကို အစီအစဉ်ထားသော fallback (အမှား/အရွယ်အစား/အချိန်ကုန်) ဖြင့် ခွင့်ပြုခြင်း။

## အမြင့်အဆင့် လုပ်ဆောင်ပုံ

1. ဝင်လာသော attachment များကို စုဆောင်းသည် (`MediaPaths`, `MediaUrls`, `MediaTypes`)။
2. enable ပြုလုပ်ထားသော capability တစ်ခုချင်းစီအတွက် (image/audio/video) မူဝါဒအရ attachment များကို ရွေးချယ်သည် (မူလသတ်မှတ်ချက်: **ပထမတစ်ခု**)။
3. အရည်အချင်းပြည့်မီသော မော်ဒယ် entry ကို ပထမဆုံးရွေးချယ်သည် (အရွယ်အစား + capability + auth)။
4. မော်ဒယ် မအောင်မြင်ပါက သို့မဟုတ် မီဒီယာ အရွယ်အစားကြီးလွန်းပါက **နောက်တစ်ခုသို့ fallback** လုပ်သည်။
5. အောင်မြင်ပါက:
   - `Body` သည် `[Image]`, `[Audio]`, သို့မဟုတ် `[Video]` block ဖြစ်လာသည်။
   - Audio သည် `{{Transcript}}` ကို သတ်မှတ်ပေးပြီး; caption ရှိပါက အမိန့်ခွဲခြမ်းစိတ်ဖြာမှုတွင် caption စာသားကို အသုံးပြုကာ မရှိပါက transcript ကို အသုံးပြုသည်။
   - Caption များကို block အတွင်း `User text:` အဖြစ် ထိန်းသိမ်းထားသည်။

နားလည်မှု မအောင်မြင်ပါက သို့မဟုတ် ပိတ်ထားပါက **ပြန်ကြားချက် လုပ်ငန်းစဉ်သည် မူလ body + attachment များဖြင့် ဆက်လက်လုပ်ဆောင်** ပါသည်။

## Config အကျဉ်းချုပ်

`tools.media` သည် **shared models** များနှင့် capability တစ်ခုချင်းစီအလိုက် override များကို ပံ့ပိုးပါသည်—

- `tools.media.models`: shared model စာရင်း (gate လုပ်ရန် `capabilities` ကို အသုံးပြုပါ)။
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - defaults (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - provider override များ (`baseUrl`, `headers`, `providerOptions`)
  - Deepgram audio options ကို `tools.media.audio.providerOptions.deepgram` ဖြင့် သတ်မှတ်နိုင်သည်
  - ရွေးချယ်နိုင်သော **capability တစ်ခုချင်းစီအလိုက် `models` စာရင်း** (shared models များမတိုင်မီ ဦးစားပေး)
  - `attachments` မူဝါဒ (`mode`, `maxAttachments`, `prefer`)
  - `scope` (channel/chatType/session key အလိုက် gate လုပ်ရန် ရွေးချယ်နိုင်)
- `tools.media.concurrency`: capability run များကို တပြိုင်နက် အများဆုံး လုပ်ဆောင်နိုင်သော အရေအတွက် (မူလ **2**)။

```json5
{
  tools: {
    media: {
      models: [
        /* shared list */
      ],
      image: {
        /* optional overrides */
      },
      audio: {
        /* optional overrides */
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### မော်ဒယ် entry များ

`models[]` entry တစ်ခုချင်းစီသည် **provider** သို့မဟုတ် **CLI** ဖြစ်နိုင်ပါသည်—

```json5
{
  type: "provider", // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

CLI template များတွင် အောက်ပါအချက်များကိုလည်း အသုံးပြုနိုင်ပါသည်—

- `{{MediaDir}}` (မီဒီယာဖိုင် ပါရှိသည့် directory)
- `{{OutputDir}}` (ဤ run အတွက် ဖန်တီးထားသော scratch dir)
- `{{OutputBase}}` (extension မပါသော scratch file base path)

## မူလသတ်မှတ်ချက်များနှင့် ကန့်သတ်ချက်များ

အကြံပြု မူလသတ်မှတ်ချက်များ—

- `maxChars`: ရုပ်ပုံ/ဗီဒီယိုအတွက် **500** (တိုတောင်း၍ အမိန့်နှင့် သင့်လျော်)
- `maxChars`: အသံအတွက် **မသတ်မှတ်ထား** (ကန့်သတ်ချက် မသတ်မှတ်ပါက transcript အပြည့်အစုံ)
- `maxBytes`:
  - image: **10MB**
  - audio: **20MB**
  - video: **50MB**

စည်းမျဉ်းများ—

- မီဒီယာသည် `maxBytes` ကို ကျော်လွန်ပါက ထိုမော်ဒယ်ကို ကျော်ပြီး **နောက်မော်ဒယ်ကို စမ်းသပ်** ပါသည်။
- မော်ဒယ်က `maxChars` ထက် ပိုမို ပြန်ပေးပါက output ကို ဖြတ်တောက်ပါသည်။
- 38. \`tools.media.<capability>
- `<capability>.enabled: true` ဖြစ်ပြီး မော်ဒယ်များ မဖွဲ့စည်းထားပါက OpenClaw သည်
  provider က capability ကို ပံ့ပိုးနိုင်သည့်အခါ **active reply model** ကို စမ်းသပ်ပါသည်။

### မီဒီယာ နားလည်မှုကို အလိုအလျောက် သိရှိခြင်း (မူလ)

39. .enabled`ကို`false`ဟု မသတ်မှတ်ထားဘဲ model များကို configure မလုပ်ထားပါက OpenClaw သည် အောက်ပါအစဉ်အတိုင်း auto-detect လုပ်ပြီး **အလုပ်လုပ်သော ပထမ option တွင် ရပ်တန့်သည်**:40.`capabilities\` ကို သတ်မှတ်ပါက entry သည် ထို media types များအတွက်သာ run လုပ်မည်ဖြစ်သည်။

1. **Local CLI များ** (audio သာ; ထည့်သွင်းထားပါက)
   - `sherpa-onnx-offline` (`SHERPA_ONNX_MODEL_DIR` နှင့် encoder/decoder/joiner/tokens လိုအပ်)
   - `whisper-cli` (`whisper-cpp`; `WHISPER_CPP_MODEL` သို့မဟုတ် bundled tiny model ကို အသုံးပြု)
   - `whisper` (Python CLI; မော်ဒယ်များကို အလိုအလျောက် ဒေါင်းလုဒ်)
2. **Gemini CLI** (`gemini`) ကို `read_many_files` ဖြင့် အသုံးပြုခြင်း
3. **Provider key များ**
   - Audio: OpenAI → Groq → Deepgram → Google
   - Image: OpenAI → Anthropic → Google → MiniMax
   - Video: Google

အလိုအလျောက် သိရှိမှုကို ပိတ်ရန်—

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

မှတ်ချက်: binary detection သည် macOS/Linux/Windows အနှံ့ best‑effort ဖြစ်ပါသည်; CLI ကို `PATH` တွင် ရှိနေစေရန် (ကျွန်ုပ်တို့သည် `~` ကို ချဲ့ထွင်ပါသည်) သို့မဟုတ် CLI မော်ဒယ်ကို အပြည့်အစုံ command path ဖြင့် အတိအကျ သတ်မှတ်ပါ။

## Capability များ (ရွေးချယ်နိုင်)

41. shared lists များအတွက် OpenClaw သည် defaults များကို infer လုပ်နိုင်သည်။ 42. CLI entries များအတွက် **`capabilities` ကို တိတိကျကျ သတ်မှတ်ပါ** unexpected matches မဖြစ်စေရန်။

- `openai`, `anthropic`, `minimax`: **image**
- `google` (Gemini API): **image + audio + video**
- `groq`: **audio**
- `deepgram`: **audio**

43. `capabilities` ကို ချန်ထားပါက entry သည် ပါဝင်နေသော list အတွက် eligible ဖြစ်သည်။
44. Understanding သည် **best‑effort** ဖြစ်သည်။

## Provider ပံ့ပိုးမှု ဇယား (OpenClaw integration များ)

| Capability | Provider integration                                    | မှတ်ချက်များ                                                           |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Image      | OpenAI / Anthropic / Google / `pi-ai` မှတဆင့် အခြားများ | registry ထဲရှိ image-capable မော်ဒယ် မည်သည့်အရာမဆို အလုပ်လုပ်နိုင်သည်။ |
| Audio      | OpenAI, Groq, Deepgram, Google                          | Provider transcription (Whisper/Deepgram/Gemini)    |
| Video      | Google (Gemini API)                  | Provider video နားလည်မှု                                               |

## အကြံပြု provider များ

**Image**

- image ကို ပံ့ပိုးနိုင်ပါက သင်၏ active model ကို ဦးစားပေးပါ။
- ကောင်းမွန်သော မူလရွေးချယ်မှုများ: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`။

**Audio**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, သို့မဟုတ် `deepgram/nova-3`။
- CLI fallback: `whisper-cli` (whisper-cpp) သို့မဟုတ် `whisper`။
- Deepgram setup: [Deepgram (audio transcription)](/providers/deepgram)။

**Video**

- `google/gemini-3-flash-preview` (မြန်ဆန်), `google/gemini-3-pro-preview` (ပိုမိုစုံလင်)။
- CLI fallback: `gemini` CLI (video/audio တွင် `read_file` ကို ပံ့ပိုး)။

## Attachment မူဝါဒ

Capability တစ်ခုချင်းစီအလိုက် `attachments` သည် မည်သည့် attachment များကို လုပ်ဆောင်မည်ကို ထိန်းချုပ်ပါသည်—

- `mode`: `first` (မူလ) သို့မဟုတ် `all`
- `maxAttachments`: လုပ်ဆောင်မည့် အရေအတွက်ကို ကန့်သတ်ခြင်း (မူလ **1**)
- `prefer`: `first`, `last`, `path`, `url`

`mode: "all"` ဖြစ်ပါက output များကို `[Image 1/2]`, `[Audio 2/2]` စသဖြင့် အမှတ်အသားတပ်ပါသည်။

## Config ဥပမာများ

### 1. Shared models စာရင်း + override များ

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
}
```

### 2. Audio + Video သာ (image ပိတ်)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 3. ရွေးချယ်နိုင်သော image နားလည်မှု

```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4. Multi‑modal single entry (capability များကို အတိအကျ သတ်မှတ်)

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## Status output

မီဒီယာ နားလည်မှု လုပ်ဆောင်သောအခါ `/status` တွင် အကျဉ်းချုပ်လိုင်းတို တစ်ကြောင်း ပါဝင်ပါသည်—

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

ဤအချက်အလက်သည် capability တစ်ခုချင်းစီ၏ ရလဒ်များနှင့် သက်ဆိုင်ရာ provider/model ကို ပြသပါသည်။

## မှတ်ချက်များ

- 45. Errors များသည် replies များကို မတားဆီးပါ။ 46. pairing မရှိပါက node device ကို အရင် approve လုပ်ပါ။
- နားလည်မှုကို ပိတ်ထားသော်လည်း attachment များကို မော်ဒယ်များသို့ ဆက်လက် ပေးပို့ပါသည်။
- နားလည်မှု လုပ်ဆောင်မည့် နေရာများကို ကန့်သတ်ရန် `scope` ကို အသုံးပြုပါ (ဥပမာ DM များသာ)။

## ဆက်စပ် စာတမ်းများ

- [Configuration](/gateway/configuration)
- [Image & Media Support](/nodes/images)
