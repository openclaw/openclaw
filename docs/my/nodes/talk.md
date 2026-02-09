---
summary: "Talk မုဒ်: ElevenLabs TTS ဖြင့် ဆက်တိုက် စကားပြောအသံ ဆက်သွယ်မှုများ"
read_when:
  - macOS/iOS/Android တွင် Talk မုဒ်ကို အကောင်အထည်ဖော်နေချိန်
  - အသံ/ TTS/ အနှောင့်အယှက် ပြုမူပုံကို ပြောင်းလဲချင်သောအခါ
title: "Talk မုဒ်"
---

# Talk မုဒ်

Talk မုဒ်သည် ဆက်တိုက် အသံဖြင့် စကားပြောဆိုနိုင်သော လုပ်ဆောင်ချက် လှည့်ပတ်မှုတစ်ခု ဖြစ်သည်—

1. စကားပြောအသံကို နားထောင်သည်
2. ပြန်ရေးသားထားသော စာသားကို မော်ဒယ်သို့ ပို့သည် (main session, chat.send)
3. တုံ့ပြန်ချက်ကို စောင့်သည်
4. ElevenLabs မှတစ်ဆင့် (streaming playback) အသံထုတ်ပြောသည်

## ပြုမူပုံ (macOS)

- Talk မုဒ် ဖွင့်ထားစဉ် **အမြဲတမ်း ပေါ်နေသော overlay**။
- **Listening → Thinking → Speaking** အဆင့်အလိုက် ပြောင်းလဲမှုများ။
- **ခဏတာ ရပ်နားမှု** (တိတ်ဆိတ်ချိန်ကာလ) ဖြစ်သည့်အခါ လက်ရှိ transcript ကို ပို့သည်။
- တုံ့ပြန်ချက်များကို **WebChat သို့ ရေးထည့်သည်** (စာရိုက်သည့်အတိုင်းတူ)။
- **စကားပြောနေစဉ် အနှောင့်အယှက် ပြုလုပ်နိုင်ခြင်း** (မူလအတိုင်း ဖွင့်ထား): အကူအညီပေးသူက ပြောနေစဉ် အသုံးပြုသူ စကားပြောစတင်ပါက playback ကို ရပ်ပြီး နောက်တစ်ကြိမ် prompt အတွက် အနှောင့်အယှက် ဖြစ်သည့် အချိန်တံဆိပ်ကို မှတ်သားထားသည်။

## တုံ့ပြန်ချက်များအတွင်း အသံညွှန်ကြားချက်များ

အကူအညီပေးသူသည် အသံကို ထိန်းချုပ်ရန် **JSON တစ်ကြောင်းတည်း** ကို မိမိတုံ့ပြန်ချက်၏ အစတွင် ထည့်နိုင်သည်—

```json
{ "voice": "<voice-id>", "once": true }
```

စည်းကမ်းများ—

- ပထမဆုံး မလွတ်လပ်သော စာကြောင်းတစ်ကြောင်းသာ။
- မသိသော ကီးများကို လျစ်လျူရှုမည်။
- `once: true` သည် လက်ရှိ တုံ့ပြန်ချက်အတွက်သာ သက်ရောက်သည်။
- `once` မပါရှိပါက အသံသည် Talk မုဒ်အတွက် မူလအတိုင်း အသစ်ဖြစ်သွားမည်။
- TTS playback မပြုလုပ်မီ JSON စာကြောင်းကို ဖယ်ရှားမည်။

ပံ့ပိုးထားသော ကီးများ—

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Config (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

မူလတန်ဖိုးများ—

- `interruptOnSpeech`: true
- `voiceId`: `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` သို့ ပြန်လည် ချိတ်ဆက်မည် (API key ရရှိပါက ElevenLabs အသံ ပထမဆုံးတစ်ခုကို အသုံးပြုမည်)
- `modelId`: မသတ်မှတ်ထားပါက `eleven_v3` သို့ မူလအတိုင်း သတ်မှတ်မည်
- `apiKey`: `ELEVENLABS_API_KEY` သို့ ပြန်လည် ချိတ်ဆက်မည် (ရရှိပါက gateway shell profile ကို အသုံးပြုမည်)
- `outputFormat`: macOS/iOS တွင် `pcm_44100` နှင့် Android တွင် `pcm_24000` သို့ မူလအတိုင်း သတ်မှတ်မည် (MP3 streaming ကို အတင်းအကျပ် သုံးရန် `mp3_*` ကို သတ်မှတ်နိုင်သည်)

## macOS UI

- မီနူးဘား ခလုတ်: **Talk**
- Config တဘ်: **Talk Mode** အုပ်စု (voice id + အနှောင့်အယှက် ခလုတ်)
- Overlay:
  - **Listening**: မိုက်အဆင့်အလိုက် တိမ်ပုံ လှုပ်ရှားမှု
  - **Thinking**: အောက်သို့ စိမ့်ဝင်သည့် အန်နီမေးရှင်း
  - **Speaking**: လှိုင်းဝိုင်းများ ဖြန့်ထွက်လာခြင်း
  - တိမ်ပုံကို နှိပ်ပါက: စကားပြောခြင်းကို ရပ်မည်
  - X ကို နှိပ်ပါက: Talk မုဒ်မှ ထွက်မည်

## မှတ်ချက်များ

- Speech + Microphone ခွင့်ပြုချက်များ လိုအပ်သည်။
- session key `main` ကို အသုံးပြုပြီး `chat.send` ကို အသုံးချသည်။
- TTS သည် ElevenLabs streaming API ကို `ELEVENLABS_API_KEY` ဖြင့် အသုံးပြုပြီး macOS/iOS/Android တွင် latency လျော့ချရန် incremental playback ကို အသုံးပြုသည်။
- `eleven_v3` အတွက် `stability` ကို `0.0`, `0.5`, သို့မဟုတ် `1.0` ဟုတ်မဟုတ် စစ်ဆေးအတည်ပြုသည်; အခြား မော်ဒယ်များသည် `0..1` ကို လက်ခံသည်။
- `latency_tier` ကို သတ်မှတ်ထားပါက `0..4` ဖြစ်ရမည်ဟု အတည်ပြုသည်။
- Android သည် latency နည်းသော AudioTrack streaming အတွက် `pcm_16000`, `pcm_22050`, `pcm_24000`, နှင့် `pcm_44100` output ဖော်မတ်များကို ပံ့ပိုးသည်။
