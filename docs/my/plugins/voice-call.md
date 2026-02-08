---
summary: "Voice Call ပလပ်ဂင် — Twilio/Telnyx/Plivo ဖြင့် အထွက် + အဝင် ဖုန်းခေါ်ဆိုမှုများ (ပလပ်ဂင် ထည့်သွင်းခြင်း + ဖွဲ့စည်းပြင်ဆင်ခြင်း + CLI)"
read_when:
  - OpenClaw မှ အထွက် Voice Call တစ်ခုပြုလုပ်လိုသောအခါ
  - Voice Call ပလပ်ဂင်ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း သို့မဟုတ် ဖွံ့ဖြိုးတိုးတက်ရေးလုပ်ဆောင်နေသောအခါ
title: "Voice Call ပလပ်ဂင်"
x-i18n:
  source_path: plugins/voice-call.md
  source_hash: 46d05a5912b785d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:54Z
---

# Voice Call (plugin)

OpenClaw အတွက် Voice Call များကို ပလပ်ဂင်ဖြင့် အသုံးပြုနိုင်သည်။ အထွက် အသိပေးချက်များနှင့် အဝင် မူဝါဒများပါဝင်သော multi-turn ဆက်သွယ်ပြောဆိုမှုများကို ပံ့ပိုးသည်။

လက်ရှိ ပံ့ပိုးသူများ:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/no network)

အမြန် စိတ်ကူးပုံစံ:

- ပလပ်ဂင် ထည့်သွင်းပါ
- Gateway ကို ပြန်လည်စတင်ပါ
- `plugins.entries.voice-call.config` အောက်တွင် ဖွဲ့စည်းပြင်ဆင်ပါ
- `openclaw voicecall ...` သို့မဟုတ် `voice_call` ကိရိယာကို အသုံးပြုပါ

## မည်သည့်နေရာတွင် အလုပ်လုပ်သနည်း (local vs remote)

Voice Call ပလပ်ဂင်သည် **Gateway လုပ်ငန်းစဉ်အတွင်း** လည်ပတ်သည်။

Remote Gateway ကို အသုံးပြုပါက Gateway ကို လည်ပတ်နေသော **စက်ပေါ်တွင်ပင်** ပလပ်ဂင်ကို ထည့်သွင်း/ဖွဲ့စည်းပြင်ဆင်ပြီး Gateway ကို ပြန်လည်စတင်ရမည် ဖြစ်သည်။

## ထည့်သွင်းခြင်း

### ရွေးချယ်မှု A: npm မှ ထည့်သွင်းခြင်း (အကြံပြု)

```bash
openclaw plugins install @openclaw/voice-call
```

ပြီးနောက် Gateway ကို ပြန်လည်စတင်ပါ။

### ရွေးချယ်မှု B: local ဖိုလ်ဒါမှ ထည့်သွင်းခြင်း (dev, မကူးယူဘဲ)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

ပြီးနောက် Gateway ကို ပြန်လည်စတင်ပါ။

## ဖွဲ့စည်းပြင်ဆင်ခြင်း

`plugins.entries.voice-call.config` အောက်တွင် ဖွဲ့စည်းပြင်ဆင်မှုကို သတ်မှတ်ပါ:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

မှတ်ချက်များ:

- Twilio/Telnyx သည် **အများပြည်သူမှ ရောက်နိုင်သော** webhook URL လိုအပ်သည်။
- Plivo သည် **အများပြည်သူမှ ရောက်နိုင်သော** webhook URL လိုအပ်သည်။
- `mock` သည် local dev အတွက် ပံ့ပိုးသူ (network ခေါ်ဆိုမှု မရှိ) ဖြစ်သည်။
- `skipSignatureVerification` သည် local စမ်းသပ်မှုအတွက်သာ ဖြစ်သည်။
- ngrok free tier ကို အသုံးပြုပါက `publicUrl` ကို ngrok URL အတိအကျ သတ်မှတ်ရပါမည်; လက်မှတ်စစ်ဆေးခြင်းကို အမြဲတမ်း အကောင်အထည်ဖော်ထားသည်။
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` သည် `tunnel.provider="ngrok"` နှင့် `serve.bind` သည် loopback (ngrok local agent) ဖြစ်သည့်အချိန်တွင်သာ Twilio webhook များ၏ မမှန်ကန်သော လက်မှတ်များကို ခွင့်ပြုပါသည်။ local dev အတွက်သာ အသုံးပြုပါ။
- Ngrok free tier URL များသည် ပြောင်းလဲနိုင်ခြင်း သို့မဟုတ် interstitial အပြုအမူများ ထည့်နိုင်ပါသည်; `publicUrl` ပြောင်းလဲသွားပါက Twilio လက်မှတ်များ မအောင်မြင်ပါမည်။ ထုတ်လုပ်ရေးအတွက် တည်ငြိမ်သော domain သို့မဟုတ် Tailscale funnel ကို ဦးစားပေးအသုံးပြုပါ။

## Webhook လုံခြုံရေး

Gateway အရှေ့တွင် proxy သို့မဟုတ် tunnel တစ်ခု ရှိနေပါက၊ ပလပ်ဂင်သည် လက်မှတ်စစ်ဆေးရန် အများပြည်သူ URL ကို ပြန်လည်တည်ဆောက်ပါသည်။ အောက်ပါ ရွေးချယ်မှုများသည် မည်သည့် forwarded header များကို ယုံကြည်မည်ကို ထိန်းချုပ်ပါသည်။

`webhookSecurity.allowedHosts` သည် forwarding header များမှ ဟို့စ်များကို ခွင့်ပြုစာရင်းဖြင့် သတ်မှတ်ပါသည်။

`webhookSecurity.trustForwardingHeaders` သည် ခွင့်ပြုစာရင်းမပါဘဲ forwarded header များကို ယုံကြည်ပါသည်။

`webhookSecurity.trustedProxyIPs` သည် တောင်းဆိုမှု၏ remote IP သည် စာရင်းနှင့် ကိုက်ညီသည့်အခါတွင်သာ forwarded header များကို ယုံကြည်ပါသည်။

တည်ငြိမ်သော အများပြည်သူ ဟို့စ်ဖြင့် ဥပမာ:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## ခေါ်ဆိုမှုများအတွက် TTS

Voice Call သည် ခေါ်ဆိုမှုများအတွက် streaming speech ကို core `messages.tts` ဖွဲ့စည်းပြင်ဆင်မှု (OpenAI သို့မဟုတ် ElevenLabs) ကို အသုံးပြုပါသည်။ ပလပ်ဂင် ဖွဲ့စည်းပြင်ဆင်မှုအောက်တွင် **တူညီသော ပုံသဏ္ဌာန်** ဖြင့် override လုပ်နိုင်ပြီး `messages.tts` နှင့် deep‑merge လုပ်ပါသည်။

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

မှတ်ချက်များ:

- **Voice Call များတွင် Edge TTS ကို လျစ်လျူရှုပါသည်** (တယ်လီဖုန်းအသံအတွက် PCM လိုအပ်ပြီး Edge output သည် ယုံကြည်ရမှုမရှိပါ)။
- Twilio media streaming ကို ဖွင့်ထားပါက core TTS ကို အသုံးပြုပါသည်; မဟုတ်ပါက ခေါ်ဆိုမှုများသည် ပံ့ပိုးသူ၏ native voice များသို့ ပြန်လည်ကျသွားပါသည်။

### နောက်ထပ် ဥပမာများ

Core TTS ကိုသာ အသုံးပြုခြင်း (override မလုပ်):

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

ခေါ်ဆိုမှုများအတွက်သာ ElevenLabs သို့ override လုပ်ခြင်း (အခြားနေရာများတွင် core default ကို ထိန်းထား):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

ခေါ်ဆိုမှုများအတွက် OpenAI မော်ဒယ်ကိုသာ override လုပ်ခြင်း (deep‑merge ဥပမာ):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## အဝင် ခေါ်ဆိုမှုများ

Inbound မူဝါဒ၏ default သည် `disabled` ဖြစ်သည်။ အဝင် ခေါ်ဆိုမှုများကို ဖွင့်ရန် အောက်ပါအတိုင်း သတ်မှတ်ပါ:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Auto-response များသည် agent စနစ်ကို အသုံးပြုပါသည်။ အောက်ပါအရာများဖြင့် ချိန်ညှိနိုင်ပါသည်:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Agent tool

ကိရိယာအမည်: `voice_call`

လုပ်ဆောင်ချက်များ:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

ဤ repo တွင် ကိုက်ညီသော skill စာရွက်စာတမ်းကို `skills/voice-call/SKILL.md` တွင် ပါဝင်ပေးထားပါသည်။

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
