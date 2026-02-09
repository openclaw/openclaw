---
summary: "وائس کال پلگ اِن: Twilio/Telnyx/Plivo کے ذریعے آؤٹ باؤنڈ + اِن باؤنڈ کالز (پلگ اِن انسٹال + کنفیگ + CLI)"
read_when:
  - آپ OpenClaw سے آؤٹ باؤنڈ وائس کال کرنا چاہتے ہیں
  - آپ voice-call پلگ اِن کو کنفیگر یا ڈیولپ کر رہے ہیں
title: "وائس کال پلگ اِن"
---

# وائس کال (پلگ اِن)

Voice calls for OpenClaw via a plugin. Supports outbound notifications and
multi-turn conversations with inbound policies.

موجودہ فراہم کنندگان:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/no network)

فوری ذہنی ماڈل:

- پلگ اِن انسٹال کریں
- Gateway ری اسٹارٹ کریں
- `plugins.entries.voice-call.config` کے تحت کنفیگر کریں
- `openclaw voicecall ...` یا `voice_call` اوزار استعمال کریں

## یہ کہاں چلتا ہے (لوکل بمقابلہ ریموٹ)

وائس کال پلگ اِن **Gateway پروسس کے اندر** چلتا ہے۔

اگر آپ ریموٹ Gateway استعمال کرتے ہیں تو پلگ اِن کو **اس مشین پر انسٹال/کنفیگر کریں جہاں Gateway چل رہا ہو**، پھر Gateway کو ری اسٹارٹ کریں تاکہ یہ لوڈ ہو جائے۔

## انسٹال

### آپشن A: npm سے انسٹال کریں (سفارش کردہ)

```bash
openclaw plugins install @openclaw/voice-call
```

اس کے بعد Gateway کو ری اسٹارٹ کریں۔

### آپشن B: لوکل فولڈر سے انسٹال کریں (ڈیولپمنٹ، بغیر کاپی)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

اس کے بعد Gateway کو ری اسٹارٹ کریں۔

## کنفیگ

کنفیگ کو `plugins.entries.voice-call.config` کے تحت سیٹ کریں:

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

نوٹس:

- Twilio/Telnyx کے لیے **عوامی طور پر قابلِ رسائی** ویب ہوک URL درکار ہے۔
- Plivo کے لیے **عوامی طور پر قابلِ رسائی** ویب ہوک URL درکار ہے۔
- `mock` ایک لوکل ڈیولپمنٹ فراہم کنندہ ہے (کوئی نیٹ ورک کالز نہیں)۔
- `skipSignatureVerification` صرف لوکل ٹیسٹنگ کے لیے ہے۔
- اگر آپ ngrok فری ٹیر استعمال کرتے ہیں تو `publicUrl` کو عین ngrok URL پر سیٹ کریں؛ دستخط کی توثیق ہمیشہ نافذ رہتی ہے۔
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Use for local dev only.
- Ngrok free tier URLs can change or add interstitial behavior; if `publicUrl` drifts, Twilio signatures will fail. For production, prefer a stable domain or Tailscale funnel.

## ویب ہوک سکیورٹی

When a proxy or tunnel sits in front of the Gateway, the plugin reconstructs the
public URL for signature verification. These options control which forwarded
headers are trusted.

`webhookSecurity.allowedHosts` فارورڈنگ ہیڈرز سے ہوسٹس کی اجازت فہرست بناتا ہے۔

`webhookSecurity.trustForwardingHeaders` اجازت فہرست کے بغیر فارورڈڈ ہیڈرز پر بھروسا کرتا ہے۔

`webhookSecurity.trustedProxyIPs` صرف اس وقت فارورڈڈ ہیڈرز پر بھروسا کرتا ہے جب ریکویسٹ کا ریموٹ IP فہرست سے میچ کرے۔

ایک مستحکم عوامی ہوسٹ کے ساتھ مثال:

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

## کالز کے لیے TTS

Voice Call uses the core `messages.tts` configuration (OpenAI or ElevenLabs) for
streaming speech on calls. You can override it under the plugin config with the
**same shape** — it deep‑merges with `messages.tts`.

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

نوٹس:

- **وائس کالز کے لیے Edge TTS کو نظرانداز کیا جاتا ہے** (ٹیلی فونی آڈیو کے لیے PCM درکار ہوتا ہے؛ Edge آؤٹ پٹ غیر معتبر ہے)۔
- جب Twilio میڈیا اسٹریمنگ فعال ہو تو بنیادی TTS استعمال ہوتا ہے؛ بصورتِ دیگر کالز فراہم کنندہ کی مقامی آوازوں پر واپس آ جاتی ہیں۔

### مزید مثالیں

صرف بنیادی TTS استعمال کریں (کوئی اووررائیڈ نہیں):

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

صرف کالز کے لیے ElevenLabs پر اووررائیڈ کریں (دیگر جگہوں پر بنیادی ڈیفالٹ برقرار رکھیں):

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

صرف کالز کے لیے OpenAI ماڈل اووررائیڈ کریں (ڈیپ‑مرج مثال):

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

## اِن باؤنڈ کالز

Inbound policy defaults to `disabled`. To enable inbound calls, set:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Auto-responses use the agent system. Tune with:

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

## ایجنٹ اوزار

اوزار کا نام: `voice_call`

کارروائیاں:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

یہ ریپو `skills/voice-call/SKILL.md` پر ایک ہم آہنگ skill دستاویز فراہم کرتا ہے۔

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
