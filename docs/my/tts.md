---
summary: "အပြန်အလှန်ပို့သော အဖြေများအတွက် စာသားမှ အသံ (TTS)"
read_when:
  - အဖြေများအတွက် စာသားမှ အသံကို ဖွင့်အသုံးပြုခြင်း
  - TTS ပံ့ပိုးသူများ သို့မဟုတ် ကန့်သတ်ချက်များကို ဖွဲ့စည်းပြင်ဆင်ခြင်း
  - /tts အမိန့်များကို အသုံးပြုခြင်း
title: "စာသားမှ အသံ"
---

# စာသားမှ အသံ (TTS)

OpenClaw can convert outbound replies into audio using ElevenLabs, OpenAI, or Edge TTS.
It works anywhere OpenClaw can send audio; Telegram gets a round voice-note bubble.

## ပံ့ပိုးထားသော ဝန်ဆောင်မှုများ

- **ElevenLabs** (အဓိက သို့မဟုတ် အစားထိုး ပံ့ပိုးသူ)
- **OpenAI** (အဓိက သို့မဟုတ် အစားထိုး ပံ့ပိုးသူ၊ အကျဉ်းချုပ်များအတွက်လည်း အသုံးပြုသည်)
- **Edge TTS** (အဓိက သို့မဟုတ် အစားထိုး ပံ့ပိုးသူ; `node-edge-tts` ကို အသုံးပြု하며 API key မရှိပါက မူလသတ်မှတ်ချက်)

### Edge TTS မှတ်ချက်များ

Edge TTS uses Microsoft Edge's online neural TTS service via the `node-edge-tts`
library. ၎င်းသည် hosted service (local မဟုတ်ပါ) ဖြစ်ပြီး Microsoft ၏ endpoints များကို အသုံးပြုကာ API key မလိုအပ်ပါ။ `node-edge-tts` သည် speech configuration options နှင့် output formats များကို ဖော်ပြပေးထားသော်လည်း Edge service မှာ option အားလုံးကို မထောက်ပံ့ပါ။ citeturn2search0

Edge TTS သည် ထုတ်ပြန်ထားသော SLA သို့မဟုတ် quota မရှိသည့် public web service ဖြစ်သောကြောင့် best-effort အဖြစ်သာ သတ်မှတ်အသုံးပြုသင့်ပါသည်။ အကန့်အသတ်အာမခံချက်နှင့် support လိုအပ်ပါက OpenAI သို့မဟုတ် ElevenLabs ကို အသုံးပြုပါ။
Microsoft ၏ Speech REST API စာရွက်စာတမ်းအရ request တစ်ခုလျှင် audio ၁၀ မိနစ်ကန့်သတ်ချက်ရှိသည်ဟု ဖော်ပြထားပြီး Edge TTS သည် ကန့်သတ်ချက်မထုတ်ပြန်ထားသဖြင့် အလားတူ သို့မဟုတ် ပိုနည်းသော ကန့်သတ်ချက်များဟု ခန့်မှန်းသင့်ပါသည်။ citeturn0search3

## ရွေးချယ်နိုင်သော ကီးများ

OpenAI သို့မဟုတ် ElevenLabs ကို အသုံးပြုလိုပါက-

- `ELEVENLABS_API_KEY` (သို့မဟုတ် `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS သည် API key **မလိုအပ်ပါ**။ API key မတွေ့ရှိပါက OpenClaw သည် Edge TTS ကို default အဖြစ် အသုံးပြုပါသည် (`messages.tts.edge.enabled=false` ဖြင့် ပိတ်ထားခြင်း မရှိပါက)။

provider များကို များစွာ configure လုပ်ထားပါက ရွေးချယ်ထားသော provider ကို ပထမဦးစွာ အသုံးပြုပြီး အခြားများကို fallback အဖြစ် အသုံးပြုပါသည်။
Auto-summary သည် configure လုပ်ထားသော `summaryModel` (သို့မဟုတ် `agents.defaults.model.primary`) ကို အသုံးပြုသဖြင့် summary များကို enable လုပ်ပါက ထို provider ကိုလည်း authentication ပြုလုပ်ထားရပါမည်။

## ဝန်ဆောင်မှု လင့်ခ်များ

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## မူလအတိုင်း ဖွင့်ထားပါသလား?

No. Auto‑TTS သည် default အနေဖြင့် **ပိတ်ထားပါသည်**။ config တွင် `messages.tts.auto` ဖြင့် သို့မဟုတ် session အလိုက် `/tts always` (alias: `/tts on`) ဖြင့် enable လုပ်နိုင်ပါသည်။

TTS ကို ဖွင့်ထားသည့်အခါ Edge TTS သည် မူလအတိုင်း **ဖွင့်ထား** ပြီး
OpenAI သို့မဟုတ် ElevenLabs API key မရှိပါက အလိုအလျောက် အသုံးပြုပါမည်။

## ဖွဲ့စည်းပြင်ဆင်ခြင်း (Config)

TTS config သည် `openclaw.json` ထဲရှိ `messages.tts` အောက်တွင် ရှိပါသည်။
Schema အပြည့်အစုံကို [Gateway configuration](/gateway/configuration) တွင် ကြည့်နိုင်ပါသည်။

### အနည်းဆုံး config (ဖွင့်ခြင်း + ပံ့ပိုးသူ)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI အဓိက၊ ElevenLabs အစားထိုး

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### Edge TTS အဓိက (API key မလို)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### Edge TTS ပိတ်ခြင်း

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### ကိုယ်ပိုင် ကန့်သတ်ချက်များ + prefs path

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### ဝင်လာသော voice note ရှိမှသာ အသံဖြင့် ပြန်ကြားခြင်း

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### ရှည်လျားသော အဖြေများအတွက် auto-summary ပိတ်ခြင်း

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

ထို့နောက် run လုပ်ပါ-

```
/tts summary off
```

### အကွက်များအကြောင်း မှတ်ချက်များ

- `auto`: auto‑TTS မုဒ် (`off`, `always`, `inbound`, `tagged`)။
  - `inbound` သည် ဝင်လာသော voice note ရှိမှသာ အသံပို့ပါသည်။
  - `tagged` သည် အဖြေတွင် `[[tts]]` tag များ ပါဝင်သည့်အခါသာ အသံပို့ပါသည်။
- `enabled`: legacy toggle (doctor သည် ၎င်းကို `auto` သို့ ပြောင်းရွှေ့ပေးပါသည်)။
- `mode`: `"final"` (မူလ) သို့မဟုတ် `"all"` (tool/block အဖြေများ ပါဝင်)။
- `provider`: `"elevenlabs"`, `"openai"`, သို့မဟုတ် `"edge"` (fallback သည် အလိုအလျောက်)။
- `provider` ကို **မသတ်မှတ်ထားပါက** OpenClaw သည် `openai` (key ရှိလျှင်) ကို ဦးစားပေးပြီး
  ထို့နောက် `elevenlabs` (key ရှိလျှင်) ကို အသုံးပြုကာ မရှိပါက `edge` ကို အသုံးပြုပါသည်။
- `summaryModel`: auto-summary အတွက် စျေးသက်သာသော model ရွေးချယ်နိုင်မှု; မူလမှာ `agents.defaults.model.primary` ဖြစ်သည်။
  - `provider/model` သို့မဟုတ် ဖွဲ့စည်းထားသော model alias ကို လက်ခံပါသည်။
- `modelOverrides`: model ကို TTS ညွှန်ကြားချက်များ ထုတ်ပေးခွင့်ပြုခြင်း (မူလအတိုင်း ဖွင့်ထား)။
- `maxTextLength`: TTS input အတွက် အမြင့်ဆုံး ကန့်သတ်ချက် (characters) ဖြစ်ပါသည်။ ကန့်သတ်ချက်ကျော်လွန်ပါက `/tts audio` မအောင်မြင်ပါ။
- `timeoutMs`: request timeout (ms)။
- `prefsPath`: local prefs JSON path ကို အစားထိုး သတ်မှတ်ခြင်း (provider/limit/summary)။
- `apiKey` တန်ဖိုးများသည် env vars (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`) သို့ ပြန်လည်သွားပါသည်။
- `elevenlabs.baseUrl`: ElevenLabs API base URL ကို အစားထိုးသတ်မှတ်ခြင်း။
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = ပုံမှန်)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: စာလုံး ၂ လုံးပါ ISO 639-1 (ဥပမာ `en`, `de`)
- `elevenlabs.seed`: ကိန်းပြည့် `0..4294967295` (best‑effort determinism)
- `edge.enabled`: Edge TTS အသုံးပြုခွင့် (မူလ `true`; API key မလို)။
- `edge.voice`: Edge neural voice အမည် (ဥပမာ `en-US-MichelleNeural`)။
- `edge.lang`: ဘာသာစကားကုဒ် (ဥပမာ `en-US`)။
- `edge.outputFormat`: Edge output ဖော်မတ် (ဥပမာ `audio-24khz-48kbitrate-mono-mp3`)။
  - တန်ဖိုးများအတွက် Microsoft Speech output formats ကို ကြည့်ပါ; Edge တွင် ဖော်မတ်အားလုံး မပံ့ပိုးပါ။
- `edge.rate` / `edge.pitch` / `edge.volume`: ရာခိုင်နှုန်း စာကြောင်းများ (ဥပမာ `+10%`, `-5%`)။
- `edge.saveSubtitles`: အသံဖိုင်နှင့်အတူ JSON subtitles ကို ရေးထုတ်ခြင်း။
- `edge.proxy`: Edge TTS တောင်းဆိုမှုများအတွက် proxy URL။
- `edge.timeoutMs`: request timeout အစားထိုး (ms)။

## Model မှ မောင်းနှင်သော အစားထိုးများ (မူလအတိုင်း ဖွင့်ထား)

default အနေဖြင့် model သည် reply တစ်ခုအတွက် TTS directives ကို ထုတ်ပေးနိုင်ပါသည်။
`messages.tts.auto` ကို `tagged` အဖြစ် သတ်မှတ်ထားပါက audio ကို trigger လုပ်ရန် အဆိုပါ directives မဖြစ်မနေ လိုအပ်ပါသည်။

ဖွင့်ထားသည့်အခါ model သည် အဖြေတစ်ခုအတွက် အသံကို အစားထိုးရန် `[[tts:...]]`
ညွှန်ကြားချက်များကို ထုတ်ပေးနိုင်ပြီး၊ ထို့အပြင် ရွေးချယ်နိုင်သော `[[tts:text]]...[[/tts:text]]` block တစ်ခုဖြင့်
အသံထဲတွင်သာ ပေါ်လာသင့်သော ဖော်ပြချက် tag များ (ရယ်သံ၊ သီချင်းညွှန်ကြားချက်များ စသည်) ကို ပံ့ပိုးနိုင်ပါသည်။

ဥပမာ အဖြေ payload:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

အသုံးပြုနိုင်သော ညွှန်ကြားချက် ကီးများ (ဖွင့်ထားသည့်အခါ):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI အသံ) သို့မဟုတ် `voiceId` (ElevenLabs)
- `model` (OpenAI TTS model သို့မဟုတ် ElevenLabs model id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Model အစားထိုးမှုများအားလုံး ပိတ်ခြင်း:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

ရွေးချယ်နိုင်သော allowlist (tag များကို ဖွင့်ထားသော်လည်း အစားထိုးမှုအချို့ကို ပိတ်ရန်):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## အသုံးပြုသူတစ်ဦးချင်းစီအလိုက် ဦးစားပေးချက်များ

Slash commands များသည် local overrides များကို `prefsPath` သို့ ရေးသွင်းပါသည် (မူလ:
`~/.openclaw/settings/tts.json`, `OPENCLAW_TTS_PREFS` သို့မဟုတ်
`messages.tts.prefsPath` ဖြင့် အစားထိုးနိုင်ပါသည်)။

သိမ်းဆည်းထားသော အကွက်များ-

- `enabled`
- `provider`
- `maxLength` (အကျဉ်းချုပ် threshold; မူလ 1500 chars)
- `summarize` (မူလ `true`)

ဤများသည် ထိုဟို့စ်အတွက် `messages.tts.*` ကို အစားထိုးပါသည်။

## အထွက် ဖော်မတ်များ (တိတိကျကျ)

- **Telegram**: Opus voice note (ElevenLabs မှ `opus_48000_64`, OpenAI မှ `opus`)။
  - 48kHz / 64kbps သည် voice-note အတွက် သင့်လျော်ပြီး ဝိုင်းပတ် bubble အတွက် လိုအပ်ပါသည်။
- **အခြား ချန်နယ်များ**: MP3 (ElevenLabs မှ `mp3_44100_128`, OpenAI မှ `mp3`)။
  - 44.1kHz / 128kbps သည် စကားပြော အသံရှင်းလင်းမှုအတွက် မူလ ချိန်ညှိချက် ဖြစ်သည်။
- **Edge TTS**: `edge.outputFormat` ကို အသုံးပြုသည် (မူလ `audio-24khz-48kbitrate-mono-mp3`)။
  - `node-edge-tts` သည် `outputFormat` ကို လက်ခံသော်လည်း Edge service မှာ format အားလုံး မရနိုင်ပါ။ citeturn2search0
  - Output format တန်ဖိုးများသည် Microsoft Speech output formats (Ogg/WebM Opus အပါအဝင်) ကို လိုက်နာပါသည်။ citeturn1search0
  - Telegram ၏ `sendVoice` သည် OGG/MP3/M4A ကို လက်ခံပါသည်; Opus voice notes ကို အာမခံလိုပါက OpenAI/ElevenLabs ကို အသုံးပြုပါ။ citeturn1search1
  - Edge output ဖော်မတ် မအောင်မြင်ပါက OpenClaw သည် MP3 ဖြင့် ပြန်လည်ကြိုးစားပါသည်။

OpenAI/ElevenLabs ဖော်မတ်များသည် တိတိကျကျ သတ်မှတ်ထားပြီး Telegram သည် voice-note UX အတွက် Opus ကို မျှော်လင့်ပါသည်။

## Auto‑TTS အပြုအမူ

ဖွင့်ထားသည့်အခါ OpenClaw သည်-

- အဖြေတွင် မီဒီယာ သို့မဟုတ် `MEDIA:` ညွှန်ကြားချက် ပါဝင်ပြီးသားဖြစ်ပါက TTS ကို ကျော်လွှားပါသည်။
- အလွန်တိုသော အဖြေများ (< 10 chars) ကို ကျော်လွှားပါသည်။
- ဖွင့်ထားပါက `agents.defaults.model.primary` (သို့မဟုတ် `summaryModel`) ကို အသုံးပြုပြီး ရှည်လျားသော အဖြေများကို အကျဉ်းချုပ်ပါသည်။
- ထုတ်လုပ်ထားသော အသံကို အဖြေတွင် တွဲဖက်ပေးပါသည်။

အဖြေသည် `maxLength` ကို ကျော်လွန်ပြီး summary ကို ပိတ်ထားပါက (သို့မဟုတ် summary model အတွက် API key မရှိပါက)
အသံကို မပို့ဘဲ ပုံမှန် စာသားအဖြေကို ပို့ပါသည်။

## လုပ်ငန်းစဉ် ဇယား

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## Slash command အသုံးပြုနည်း

command တစ်ခုတည်းသာ ရှိပါသည်: `/tts`။
enable လုပ်နည်း အသေးစိတ်ကို [Slash commands](/tools/slash-commands) တွင် ကြည့်ပါ။

Discord မှတ်ချက်: `/tts` သည် Discord ၏ built-in command ဖြစ်သောကြောင့် OpenClaw သည် အဲဒီနေရာတွင် native command အဖြစ် `/voice` ကို register လုပ်ပါသည်။ Text `/tts ...` သည် ဆက်လက် အလုပ်လုပ်ပါသည်။

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

မှတ်ချက်များ-

- အမိန့်များကို အသုံးပြုရန် ခွင့်ပြုထားသော ပို့သူ လိုအပ်ပါသည် (allowlist/owner စည်းမျဉ်းများ ဆက်လက် သက်ရောက်ပါသည်)။
- `commands.text` သို့မဟုတ် native command မှတ်ပုံတင်ခြင်းကို ဖွင့်ထားရပါမည်။
- `off|always|inbound|tagged` များသည် session တစ်ခုချင်းစီအလိုက် toggle များ ဖြစ်ပါသည် (`/tts on` သည် `/tts always` အတွက် alias ဖြစ်သည်)။
- `limit` နှင့် `summary` ကို main config မဟုတ်ဘဲ local prefs တွင် သိမ်းဆည်းပါသည်။
- `/tts audio` သည် တစ်ကြိမ်တည်း အသံအဖြေကို ထုတ်ပေးပါသည် (TTS ကို ဖွင့်/ပိတ် မပြောင်းပါ)။

## Agent tool

`tts` tool သည် text ကို speech သို့ ပြောင်းလဲပြီး `MEDIA:` path ကို ပြန်ပေးပါသည်။ ရလဒ်သည် Telegram နှင့် ကိုက်ညီပါက Telegram မှ voice bubble ပို့ရန် `[[audio_as_voice]]` ကို tool က ထည့်သွင်းပေးပါသည်။

## Gateway RPC

Gateway အမိန့်များ-

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
